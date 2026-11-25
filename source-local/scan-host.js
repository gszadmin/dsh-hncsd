/**
 * Read-only directory scanner, Host side.
 *
 * This is the plugin's only filesystem access: `readdir` with `withFileTypes`, nothing
 * else. It never opens a file, never writes, never resolves a symbolic link, and never
 * touches the network. Everything it learns becomes a `WorkspaceSnapshot`.
 *
 * `readdir` is injectable so the scanner's budget, depth, cycle and error behaviour can be
 * tested against an in-memory tree without touching a real disk.
 */

import fsp from 'node:fs/promises'

import {
  DEFAULT_IGNORE_NAMES,
  SCAN_LIMITS,
  basename,
  clampInt,
  hashId,
  inScope,
  isIgnoredName,
  normalizePath,
  tooBroadReason,
} from './guards.js'

const defaultReaddir = (path) => fsp.readdir(path, { withFileTypes: true })

export function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

function describeError(error) {
  if (!error) return '未知错误'
  const code = error && error.code ? String(error.code) : ''
  const message = typeof error?.message === 'string' ? error.message : String(error)
  if (!code) return message
  return message.includes(code) ? message : code + ': ' + message
}

/** Directories only: symbolic links and junctions are skipped, never followed. */
function directoryNames(dirents) {
  const names = []
  for (const dirent of dirents) {
    if (!dirent) continue
    if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) continue
    if (typeof dirent.isDirectory === 'function' && !dirent.isDirectory()) continue
    names.push(dirent.name)
  }
  return names
}

/**
 * Aggregate stored sessions onto one workspace: how many, the newest creation time, and how many
 * of them the workspace registry lists as archived.
 *
 * Only the session header's `cwd` and `createdAt` are involved: `sessionPersistence.list()`
 * observes headers and revisions without reading an event log, so no prompt or transcript
 * text reaches this plugin. `archived` is `null` when the profile exposes no archive set —
 * "unknown" is reported as unknown instead of being flattened into 0.
 */
function sessionsFor(workspacePath, sessions) {
  if (sessions.length === 0) return { count: 0, lastAt: 0, archived: null }
  const base = workspacePath.toLowerCase()
  const separator = base.includes('\\') || base.endsWith(':') ? '\\' : '/'
  const prefix = base.endsWith(separator) ? base : base + separator
  let count = 0
  let lastAt = 0
  let archivedCount = 0
  let archivedKnown = false
  for (const session of sessions) {
    if (session.cwd !== base && !session.cwd.startsWith(prefix)) continue
    count += 1
    if (session.at > lastAt) lastAt = session.at
    if (session.archived === true) {
      archivedCount += 1
      archivedKnown = true
    } else if (session.archived === false) {
      archivedKnown = true
    }
  }
  return { count, lastAt, archived: archivedKnown ? archivedCount : null }
}

function hiddenName(name, dirents) {
  return String(name).startsWith('.')
}

/**
 * @param {{
 *   rootPath: string,
 *   options?: object,
 *   signal?: AbortSignal,
 *   readdir?: (path: string) => Promise<Array<object>>,
 *   onProgress?: (progress: { done: number, total: number }) => void,
 * }} request
 * @returns {Promise<object>} a WorkspaceSnapshot
 */
export async function scanDirectories(request) {
  const readdir = typeof request.readdir === 'function' ? request.readdir : defaultReaddir
  const stat = typeof request.stat === 'function' ? request.stat : (target) => fsp.stat(target)
  const signal = request.signal
  const options = Object.assign(
    {
      includeHidden: false,
      ignoreNames: DEFAULT_IGNORE_NAMES,
      concurrency: 8,
      maxDepth: SCAN_LIMITS.maxDepth.fallback,
      maxDirs: SCAN_LIMITS.maxDirs.fallback,
      timeoutMs: SCAN_LIMITS.timeoutMs.fallback,
    },
    request.options || {},
  )
  const maxDepth = clampInt(options.maxDepth, SCAN_LIMITS.maxDepth)
  const maxDirs = clampInt(options.maxDirs, SCAN_LIMITS.maxDirs)
  const timeoutMs = clampInt(options.timeoutMs, SCAN_LIMITS.timeoutMs)

  const root = normalizePath(request.rootPath)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const warnings = []

  /**
   * Progress events are best-effort telemetry: a consumer that throws (a socket that closed
   * mid-stream, a test that asserts on a stale shape) must never abort the scan itself.
   */
  const emit = (event) => {
    if (typeof request.onEvent !== 'function') return
    try {
      request.onEvent(event)
    } catch {
      /* ignore: the sweep continues without its listener */
    }
  }

  const limitHits = { dirs: false, time: false, depth: false }
  /** Each budget reports itself at most once, the moment it first bites. */
  const emitLimit = (kind, limit, used) => {
    if (limitHits[kind]) return
    limitHits[kind] = true
    emit({ type: 'limit', kind, limit, used })
  }

  /** Directories read so far. Budgeted by `maxDirs` across the whole sweep. */
  const budget = { visited: 0 }
  /** Top-level folders the root advertised; unknown until the root has been read. */
  const declared = { value: 0 }

  const snapshotOf = (workspaces) => ({
    schemaVersion: 1,
    rootPath: root,
    scannedAt: Date.now(),
    workspaces,
    warnings,
    scan: {
      declared: declared.value,
      scanned: workspaces.length,
      visitedDirs: budget.visited,
      maxDirs,
      maxDepth,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      partial: workspaces.length < declared.value || limitHits.dirs || limitHits.time,
      limits: { dirs: limitHits.dirs, time: limitHits.time, depth: limitHits.depth },
    },
  })

  const emitStart = (total) => {
    declared.value = total
    emit({
      type: 'start',
      schemaVersion: 1,
      rootPath: root,
      declared: total,
      maxDirs,
      maxDepth,
      timeoutMs,
      startedAt,
    })
  }

  const emitWarning = (warning) => emit({ type: 'warning', warning })

  const broad = tooBroadReason(root)
  if (broad) {
    emitStart(0)
    const warning = { code: 'too-broad-root', path: root, message: broad }
    warnings.push(warning)
    emitWarning(warning)
    return snapshotOf([])
  }

  let rootEntries
  try {
    rootEntries = await readdir(root)
  } catch (error) {
    if (isAbortError(error)) throw error
    emitStart(0)
    const warning = { code: 'root-unavailable', path: root, message: describeError(error) }
    warnings.push(warning)
    emitWarning(warning)
    return snapshotOf([])
  }

  const ignoreNames = options.ignoreNames
  const seenNames = { hidden: 0, ignored: 0 }
  const candidates = []

  for (const dirent of rootEntries) {
    if (!dirent) continue
    if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) continue
    if (typeof dirent.isDirectory === 'function' && !dirent.isDirectory()) continue
    if (!options.includeHidden && hiddenName(dirent.name, rootEntries)) {
      seenNames.hidden += 1
      continue
    }
    if (isIgnoredName(dirent.name, ignoreNames)) {
      seenNames.ignored += 1
      continue
    }
    const childPath = normalizePath(root + '\\' + dirent.name)
    if (!inScope(childPath, root)) continue
    candidates.push({ name: dirent.name, path: childPath })
  }

  // The client learns the denominator before the first workspace finishes, so a progress
  // bar has a total to fill instead of an unknown bar.
  emitStart(candidates.length)

  if (seenNames.hidden > 0) {
    const warning = {
      code: 'hidden-skipped',
      path: root,
      message: '已跳过 ' + seenNames.hidden + ' 个隐藏目录',
    }
    warnings.push(warning)
    emitWarning(warning)
  }
  if (seenNames.ignored > 0) {
    const warning = {
      code: 'ignored-skipped',
      path: root,
      message: '已跳过 ' + seenNames.ignored + ' 个忽略名单内的目录',
    }
    warnings.push(warning)
    emitWarning(warning)
  }

  // One `stat` per workspace, for "recently touched on disk". Budgeted separately from
  // directory reads so a wide tree cannot turn into an unbounded stat sweep.
  const statBudget = { used: 0, limit: Math.max(0, Number(options.maxStats) || maxDirs) }
  const nodes = []

  const normalizedSessions = Array.isArray(request.sessions)
    ? request.sessions
        .map((session) => {
          const cwd = session && typeof session.cwd === 'string' ? normalizePath(session.cwd).toLowerCase() : ''
          const at = session && Number.isSafeInteger(session.at) && session.at > 0 ? session.at : 0
          if (cwd === '') return null
          // P5.2: keep the archive flag; `null` means "unknown for this session", which is what
          // lets a workspace report "unknown" instead of a fabricated "0 archived".
          const archived = session && typeof session.archived === 'boolean' ? session.archived : null
          return { cwd, at, archived }
        })
        .filter(Boolean)
    : Array.isArray(request.sessionCwds)
      ? request.sessionCwds
          .map((cwd) => (typeof cwd === 'string' ? normalizePath(cwd).toLowerCase() : ''))
          .filter((cwd) => cwd !== '')
          .map((cwd) => ({ cwd, at: 0, archived: null }))
      : []

  const countWorkspace = async (entry) => {
    const localWarnings = []
    let count = 0
    let status = 'ready'
    const stack = [{ path: entry.path, depth: 1 }]
    const seen = new Set([entry.path.toLowerCase()])

    while (stack.length > 0) {
      if (signal && signal.aborted) {
        const aborted = new Error('aborted')
        aborted.name = 'AbortError'
        throw aborted
      }
      if (Date.now() > deadline) {
        emitLimit('time', timeoutMs, Date.now() - startedAt)
        localWarnings.push({ code: 'timed-out', path: entry.path, message: '扫描超时，结果为部分统计' })
        break
      }
      if (budget.visited >= maxDirs) {
        emitLimit('dirs', maxDirs, budget.visited)
        localWarnings.push({
          code: 'truncated-count',
          path: entry.path,
          message: '达到目录访问上限 ' + maxDirs + '，结果为部分统计',
        })
        break
      }

      const current = stack.pop()
      if (current.depth > maxDepth) {
        emitLimit('depth', maxDepth, current.depth)
        localWarnings.push({
          code: 'truncated-depth',
          path: current.path,
          message: '超过最大深度 ' + maxDepth + '，更深层目录未统计',
        })
        continue
      }

      budget.visited += 1
      let dirents
      try {
        dirents = await readdir(current.path)
      } catch (error) {
        if (isAbortError(error)) throw error
        localWarnings.push({
          code: 'permission-denied',
          path: current.path,
          message: describeError(error),
        })
        if (current.depth === 1) status = 'unavailable'
        continue
      }

      for (const dirent of dirents) {
        if (!dirent) continue
        if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) continue
        if (typeof dirent.isDirectory === 'function' && !dirent.isDirectory()) continue
        if (!options.includeHidden && hiddenName(dirent.name, dirents)) continue
        if (isIgnoredName(dirent.name, ignoreNames)) continue
        const childPath = normalizePath(current.path + '\\' + dirent.name)
        const key = childPath.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        count += 1
        stack.push({ path: childPath, depth: current.depth + 1 })
      }
    }

    return { count, status, warnings: localWarnings }
  }

  let done = 0
  const queue = candidates.slice()
  const limit = Math.max(1, Math.min(16, Number(options.concurrency) || 8))

  const worker = async () => {
    while (queue.length > 0) {
      if (signal && signal.aborted) {
        const aborted = new Error('aborted')
        aborted.name = 'AbortError'
        throw aborted
      }
      // Out of time: stop handing out work. Whatever finished stays in `nodes`, and the
      // shortfall against `declared` is what marks the snapshot partial.
      if (Date.now() > deadline) {
        emitLimit('time', timeoutMs, Date.now() - startedAt)
        break
      }
      const entry = queue.shift()
      const outcome = await countWorkspace(entry)
      const sessionStats = sessionsFor(entry.path, normalizedSessions)

      let modifiedAt
      if (statBudget.used < statBudget.limit) {
        statBudget.used += 1
        try {
          const info = await stat(entry.path)
          if (info && Number.isFinite(info.mtimeMs)) modifiedAt = info.mtimeMs
        } catch {
          /* a vanished or unreadable directory simply has no mtime */
        }
      }

      const node = {
        id: hashId(entry.path),
        name: entry.name || basename(entry.path),
        path: entry.path,
        directoryCount: outcome.count,
        sessionCount: sessionStats.count,
        lastSessionAt: sessionStats.lastAt || undefined,
        // P5.2: how many of those sessions the workspace registry lists as archived. Absent when
        // the archive set is unknown, so the panel can say nothing instead of inventing "0".
        archivedSessionCount: sessionStats.archived === null ? undefined : sessionStats.archived,
        modifiedAt,
        status: outcome.status,
      }
      nodes.push(node)
      const nodeWarnings = outcome.warnings.map((warning) => Object.assign({ workspaceId: node.id }, warning))
      for (const warning of nodeWarnings) warnings.push(warning)
      done += 1
      emit({
        type: 'workspace',
        node,
        warnings: nodeWarnings,
        done,
        declared: candidates.length,
        visitedDirs: budget.visited,
        elapsedMs: Date.now() - startedAt,
      })
      if (typeof request.onProgress === 'function') {
        request.onProgress({ done, total: candidates.length })
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))

  nodes.sort((a, b) => {
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    if (an < bn) return -1
    if (an > bn) return 1
    return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1
  })

  return snapshotOf(nodes)
}
