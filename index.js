/**
 * Host half of the brain-workspaces bundle: the read-only local directory source.
 *
 * Why the scan lives here: this deployment composes the *native* directory picker, so the
 * Client's `uiWorkspace.listDirectory` Remote has no browse capability to answer it. The
 * Host therefore does the listing itself with `node:fs` and publishes the result on one
 * exact, connection-fenced route that the page fetches same-origin.
 *
 * Boundaries: `readdir` only (never file contents), no writes, no symlink traversal, no
 * outbound network. The route answers JSON containing local paths, so it requires the same
 * request admission as the rest of the UI and refuses cross-origin calls.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isFullyQualified, normalizePath, tooBroadReason } from './source-local/guards.js'
import { scanDirectories } from './source-local/scan-host.js'
import { collectSkillsReport } from './skills-local/report.js'
import { distillSkill, globalizeSkill, ignoreSkill, readSkillDocument, recordPromotion, trashSkill, unignoreSkill } from './skills-local/actions.js'

const DEFAULT_IGNORE_NAMES = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.venv',
  'vendor',
])

export const DEFAULTS = Object.freeze({
  // 空串 = 未配置。`dataDir` 目前只被校验、运行期未使用；发布包不该把本机 E 盘路径当默认值发出去。
  dataDir: '',
  // Five levels below each workspace root is what the user asked for; deeper trees are
  // reported as partial counts instead of being walked.
  maxDepth: 5,
  maxDirs: 20000,
  timeoutMs: 8000,
  includeHidden: false,
  ignoreNames: DEFAULT_IGNORE_NAMES,
  allowRoots: Object.freeze([]),
})

export const SCAN_ROUTE = '/plugins/dsh-brain-workspaces/api/scan'
/** Current bundle-revision probe: the client needs it to address the three.js chunk. */
export const REV_ROUTE = '/plugins/dsh-brain-workspaces/api/chunk-rev'

/**
 * 术法蒸馏：各工作区的技能与真实加载次数。按需查询，不进全量扫描，
 * 所以它不会拖慢星星的任何一帧。
 */
export const SKILLS_ROUTE = '/plugins/dsh-brain-workspaces/api/skills'

/** 三个写动作：蒸馏 / 移入回收站 / 提升为全局。必须 POST，且同样过准入与同源检查。 */
export const SKILLS_DISTILL_ROUTE = SKILLS_ROUTE + '/distill'
export const SKILLS_TRASH_ROUTE = SKILLS_ROUTE + '/trash'
export const SKILLS_GLOBALIZE_ROUTE = SKILLS_ROUTE + '/globalize'
/** 忽略 / 取消忽略「可提升为全局」的候选，落盘到 DSH_HOME。 */
export const SKILLS_IGNORE_ROUTE = SKILLS_ROUTE + '/ignore'
export const SKILLS_UNIGNORE_ROUTE = SKILLS_ROUTE + '/unignore'

/** 加入全局之前先看一眼原文：只读，GET，?workspace=&name=。 */
export const SKILLS_PREVIEW_ROUTE = SKILLS_ROUTE + '/preview'

/** 技能报表的缓存窗口：1200+ 会话投影读一遍约 2 秒，窗口内复用。 */
const SKILLS_CACHE_TTL_MS = 30000

/** 写动作成功后清空报表缓存，下一次读就是新状态。 */
const SKILLS_CACHE = new Map()

/** Media type that switches the route from one JSON document to a progress stream. */
export const NDJSON_TYPE = 'application/x-ndjson'

export const name = 'brain-workspaces'

/** The page cannot reach the scan route without these two Host services. */
export const inject = ['webServer', 'connection']

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.trunc(number)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Merge one patch row's `config` with defaults. Never throws: a malformed field falls back
 * to its default so a typo in the patch cannot stop the bundle from activating.
 *
 * @param {unknown} raw
 * @returns {{ config: object, diagnostics: string[] }}
 */
export function resolveConfig(raw) {
  const diagnostics = []
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object')) {
    diagnostics.push('config 不是一个对象，已全部使用默认值。')
  }

  let dataDir = DEFAULTS.dataDir
  if (typeof input.dataDir === 'string') {
    // 空串 / 空白串 = 未配置（发布包默认值），不是错误；只有给了非字符串才值得提示。
    const trimmed = input.dataDir.trim()
    if (trimmed) dataDir = trimmed
  } else if (input.dataDir !== undefined) {
    diagnostics.push('dataDir 不是字符串，已使用默认值。')
  }

  const config = {
    dataDir,
    maxDepth: clampInt(input.maxDepth, DEFAULTS.maxDepth, 1, 32),
    maxDirs: clampInt(input.maxDirs, DEFAULTS.maxDirs, 100, 200000),
    timeoutMs: clampInt(input.timeoutMs, DEFAULTS.timeoutMs, 250, 30000),
    includeHidden: input.includeHidden === true,
    ignoreNames: stringList(input.ignoreNames, DEFAULT_IGNORE_NAMES),
    allowRoots: stringList(input.allowRoots, []),
  }

  if (config.ignoreNames.length === 0) {
    diagnostics.push('ignoreNames 为空：node_modules 等生成目录会被计入目录数。')
  }

  return { config, diagnostics }
}

/** Resolved configuration of the active row, for diagnostics. */
let activeConfig = null

export function getActiveConfig() {
  return activeConfig
}

function admitted(ctx, req) {
  try {
    return ctx.connection.requestRejection(req) === undefined
  } catch {
    return false
  }
}

/**
 * A same-origin GET may omit `Origin`; when it is present it must match this host, so a
 * proxied request from another device cannot read the directory listing.
 */
function sameOrigin(req) {
  const origin = req && req.headers ? req.headers.origin : undefined
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * The stream is opt-in through `Accept`, never through a query parameter: the request's
 * query string stays "root and nothing else", and an old client keeps receiving exactly the
 * single JSON document it expects.
 */
function wantsStream(req) {
  const accept = req && req.headers ? req.headers.accept : undefined
  if (typeof accept !== 'string') return false
  return accept.toLowerCase().includes(NDJSON_TYPE)
}

/**
 * Writes one JSON line per event, honouring backpressure.
 *
 * A wide sweep can produce thousands of lines while the browser is still busy; without the
 * `drain` handshake those lines would queue in the socket's buffer instead. Writes after the
 * response ended (or after the client hung up) are dropped rather than thrown.
 */
function createLineWriter(res) {
  const queue = []
  let blocked = false
  let ending = false
  let disposed = false

  const flush = () => {
    if (disposed || blocked) return
    while (queue.length > 0) {
      let accepted = true
      try {
        accepted = res.write(queue[0])
      } catch {
        disposed = true
        queue.length = 0
        return
      }
      queue.shift()
      if (accepted === false) {
        blocked = true
        return
      }
    }
    if (ending) {
      disposed = true
      try {
        res.end()
      } catch {
        /* the socket is already gone */
      }
    }
  }

  const onDrain = () => {
    blocked = false
    flush()
  }
  const onClose = () => {
    disposed = true
    queue.length = 0
  }
  if (typeof res.on === 'function') {
    res.on('drain', onDrain)
    res.on('close', onClose)
  }

  return {
    write(event) {
      if (disposed || res.writableEnded || res.destroyed) return
      let line
      try {
        line = JSON.stringify(event) + '\n'
      } catch {
        return
      }
      queue.push(line)
      flush()
    },
    end() {
      ending = true
      flush()
    },
  }
}

/**
 * A query value, or undefined when the caller did not send one.
 *
 * `params.get()` returns `null` for an absent key, and `Number(null)` is `0` — which
 * `clampInt` treats as a real value, silently clamping every omitted budget to its minimum
 * (depth 1 / 100 dirs / 250 ms) instead of using the configured default. Empty strings are
 * treated the same way.
 */
function queryInt(params, name) {
  const raw = params.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseScanQuery(url, config) {
  const params = url.searchParams
  const ignoreParam = params.getAll('ignore').flatMap((value) => String(value).split(','))
  const ignoreNames =
    ignoreParam.length > 0
      ? ignoreParam.map((value) => value.trim()).filter((value) => value !== '')
      : config.ignoreNames

  const includeHiddenParam = params.get('includeHidden')

  return {
    rootPath: params.get('root') || '',
    options: {
      maxDepth: clampInt(queryInt(params, 'maxDepth'), config.maxDepth, 1, 32),
      maxDirs: clampInt(queryInt(params, 'maxDirs'), config.maxDirs, 100, 200000),
      timeoutMs: clampInt(queryInt(params, 'timeoutMs'), config.timeoutMs, 250, 30000),
      includeHidden:
        includeHiddenParam === null
          ? config.includeHidden
          : includeHiddenParam === '1' || includeHiddenParam === 'true',
      ignoreNames,
    },
  }
}

/**
 * Whether one session id is in the archive set.
 *
 * The registry spells session identities `session-<uuid>` while a stored header may carry either
 * spelling, so both are tried: a silent miss here would always report "0 archived".
 */
function archiveHit(archivedIds, id) {
  if (!archivedIds || id === '') return false
  if (archivedIds.has(id)) return true
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : 'session-' + id
  return archivedIds.has(bare)
}

/**
 * Collect stored-session metadata: the header's `cwd`, and its `createdAt` when present.
 *
 * `sessionPersistence.list()` returns header + revision metadata per session and never
 * reads an event log, so this plugin sees a working directory and a creation timestamp —
 * no prompt, title, or transcript text. The service is optional: a profile without it
 * simply reports zero sessions per workspace.
 *
 * P5.2 adds one more bit per session: whether the workspace registry lists it as archived. Only
 * the session *identity* crosses that boundary (`workspaceRegistry.archivedSessionIds` is a list of
 * ids); when the service is absent the answer stays `null` = "unknown", never a fabricated `false`.
 *
 * @returns {Promise<Array<{ cwd: string, at: number, archived: boolean | null }>>}
 */
async function collectSessions(ctx, signal) {
  let persistence
  try {
    persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  } catch {
    return []
  }
  if (!persistence || typeof persistence.list !== 'function') return []

  // Archive set: ids only, and unknown when the registry is not mounted in this profile.
  let archivedIds = null
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const ids = registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : null
    if (ids !== null) archivedIds = new Set(ids.map(String))
  } catch {
    archivedIds = null
  }

  try {
    // No options object: the list options shape is backend-specific and an unknown key
    // would be rejected, which would silently drop every session count.
    const snapshots = await persistence.list()
    if (!Array.isArray(snapshots)) return []
    const sessions = []
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== 'object') continue
      const header = snapshot.header || snapshot
      const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
      if (cwd === '') continue
      const createdAt = Number.isSafeInteger(header.createdAt) && header.createdAt > 0 ? header.createdAt : 0
      const id = header && header.id !== undefined && header.id !== null ? String(header.id) : ''
      const archived = archivedIds === null ? null : archiveHit(archivedIds, id)
      sessions.push({ cwd, at: createdAt, archived })
    }
    return sessions
  } catch {
    return []
  }
}

function createHandler(ctx, config) {  return async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (!admitted(ctx, req) || !sameOrigin(req)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }

    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(400, { ok: false, error: 'bad-url' })
      return
    }

    const { rootPath, options } = parseScanQuery(url, config)
    const root = normalizePath(rootPath)

    if (!isFullyQualified(root)) {
      send(400, { ok: false, error: 'not-fully-qualified', message: '根目录必须是完整的绝对路径' })
      return
    }
    const broad = tooBroadReason(root)
    if (broad) {
      send(400, { ok: false, error: 'root-too-broad', message: broad })
      return
    }

    // Streaming starts only after the request has passed method, admission, same-origin and
    // root checks, so every rejection above is still an ordinary JSON error response.
    const writer = wantsStream(req)
      ? (() => {
          res.writeHead(200, {
            'content-type': NDJSON_TYPE + '; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            // Proxies must not buffer a progress stream into one delayed response.
            'x-accel-buffering': 'no',
          })
          return createLineWriter(res)
        })()
      : null
    const onEvent = writer ? (event) => writer.write(event) : undefined

    const controller = new AbortController()
    const abort = () => controller.abort()
    res.on('close', abort)

    try {
      // Session metadata is optional: only the header's cwd and createdAt are read.
      const sessions = await collectSessions(ctx, controller.signal)
      if (controller.signal.aborted) return

      const snapshot = await scanDirectories({
        rootPath: root,
        options,
        sessions,
        signal: controller.signal,
        onEvent,
      })
      if (controller.signal.aborted) return
      if (writer) {
        writer.write({ type: 'done', snapshot })
        writer.end()
        return
      }
      send(200, snapshot)
    } catch (error) {
      // A cancelled sweep ends the stream without a `done`: the client's AbortError is the
      // cancel signal, and a half-finished snapshot is not a result.
      if (controller.signal.aborted || error?.name === 'AbortError') return
      if (writer) {
        writer.write({ type: 'error', error: 'scan-failed', message: String(error?.message || error) })
        writer.end()
        return
      }
      send(500, { ok: false, error: 'scan-failed', message: String(error?.message || error) })
    } finally {
      res.removeListener('close', abort)
    }
  }
}

/**
 * The page needs the *current* revision of this bundle to address its three.js chunk: the
 * chunk route only answers an exact `?rev=`. The boot manifest carries a revision too, but it
 * is a snapshot taken at page load, so it goes stale as soon as the plugin is updated without a
 * reload. This route lets the client ask the Host for the live value.
 *
 * The hash mirrors the Host's own artifact revision (domain-tagged SHA-1 over mtime, ctime and
 * size, truncated to 12 hex), so the value we hand out is exactly the one the chunk route
 * validates.
 */
export function artifactRevision(baseline) {
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]) {
    hash.update(String(Buffer.byteLength(part)) + ':').update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

/** Revision of this package's own client bundle, or null when it cannot be read. */
export function currentBundleRevision(clientPath) {
  const file = clientPath || join(dirname(fileURLToPath(import.meta.url)), 'client.js')
  try {
    return artifactRevision(statSync(file))
  } catch {
    return null
  }
}

function createRevHandler(ctx, clientPath) {
  return async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (!admitted(ctx, req) || !sameOrigin(req)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }

    const rev = currentBundleRevision(clientPath)
    if (!rev) {
      send(500, { ok: false, error: 'revision-unavailable' })
      return
    }
    send(200, { ok: true, rev })
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
function skillsDataRoots() {
  return {
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    mnemonRoot: process.env.MNEMON_DATA_DIR || join(homedir(), '.mnemon'),
  }
}

/**
 * `/api/skills`：把「工作区 → 技能 → 加载次数」算好返回。只读、同源、带 30 秒缓存。
 * `?workspace=<绝对路径>` 只影响排序（把该工作区排在最前并打上 selected），
 * 不影响统计口径 —— 面板因此可以在任意珠子上打开同一个视图。
 */
function createSkillsHandler(ctx) {
  const load = async (workspace, refresh) => {
    const key = workspace || ''
    const hit = SKILLS_CACHE.get(key)
    if (!refresh && hit && Date.now() - hit.at < SKILLS_CACHE_TTL_MS) return hit.body
    const { dshHome, mnemonRoot } = skillsDataRoots()
    const body = await collectSkillsReport({ dshHome, mnemonRoot, selectedPath: workspace || undefined })
    SKILLS_CACHE.set(key, { at: Date.now(), body })
    if (SKILLS_CACHE.size > 8) SKILLS_CACHE.delete(SKILLS_CACHE.keys().next().value)
    return body
  }

  return async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (!admitted(ctx, req) || !sameOrigin(req)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(400, { ok: false, error: 'bad-url' })
      return
    }
    const workspace = url.searchParams.get('workspace') || ''
    const refresh = url.searchParams.get('refresh') === '1'
    try {
      send(200, await load(workspace, refresh))
    } catch (error) {
      send(500, { ok: false, error: 'skills-failed', message: String(error?.message ?? error) })
    }
  }
}

/** 读一个有上限的 JSON 请求体；超过上限直接拒绝，避免被灌大 body。 */
function readJsonBody(req, limit = 16384) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(Object.assign(new Error('body-too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolveBody({})
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(Object.assign(new Error('bad-json'), { status: 400 }))
      }
    })
    req.on('error', rejectBody)
  })
}

/**
 * 三个写动作的处理器。全部要求 POST + 准入 + 同源；成功后清空报表缓存。
 * body: { workspace, name, loads? }
 */
function createSkillsActionHandler(ctx, kind) {
  return async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!admitted(ctx, req) || !sameOrigin(req)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(error.status || 400, { ok: false, error: error.message })
      return
    }

    try {
      const { dshHome, mnemonRoot } = skillsDataRoots()
      let result
      if (kind === 'distill') {
        result = await distillSkill({ workspace: body.workspace, name: body.name })
      } else if (kind === 'trash') {
        // 删除时顺手清账本：mnemon 里针对这个技能的建议/草案/版本一起下掉（先备份 ledger）。
        result = await trashSkill({ workspace: body.workspace, name: body.name, loads: body.loads, mnemonRoot })
      } else if (kind === 'ignore') {
        result = await ignoreSkill({ dshHome, name: body.name, workspace: body.workspace })
      } else if (kind === 'unignore') {
        result = await unignoreSkill({ dshHome, name: body.name, workspace: body.workspace })
      } else {
        result = await globalizeSkill({ workspace: body.workspace, name: body.name, userRoot: join(dshHome, 'skills') })
        // 只记录事实：谁、从哪个工作区、以什么内容指纹加入的全局。写账本失败不影响「已复制」这个事实。
        try {
          result.scope = await recordPromotion({
            dshHome,
            name: body.name,
            from: body.workspace,
            hash: result.hash,
            loads: Number(body.loads) || 0,
          })
        } catch (error) {
          result.scope = { ok: false, message: String(error?.message ?? error) }
        }
      }
      SKILLS_CACHE.clear()
      send(200, result)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      send(status, { ok: false, error: error?.code || 'action-failed', message: String(error?.message ?? error) })
    }
  }
}

/**
 * `GET /api/skills/preview?workspace=&name=`：读一段 SKILL.md 原文，供「加入全局」之前判断。
 * 只读、同源、按字节上限截断，绝不返回整份大文件。
 */
function createSkillsPreviewHandler(ctx) {
  return async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (!admitted(ctx, req) || !sameOrigin(req)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(400, { ok: false, error: 'bad-url' })
      return
    }
    const workspace = url.searchParams.get('workspace') || ''
    const name = url.searchParams.get('name') || ''
    const limit = Number(url.searchParams.get('limit')) || 8192
    try {
      send(200, await readSkillDocument({ workspace, name, limitBytes: limit }))
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      send(status, { ok: false, error: error?.code || 'preview-failed', message: String(error?.message ?? error) })
    }
  }
}

export function apply(ctx, config) {
  const { config: resolved, diagnostics } = resolveConfig(config)

  for (const message of diagnostics) {
    try {
      ctx.logger?.('brain-workspaces')?.warn?.(message)
    } catch {
      /* logging is best-effort */
    }
  }

  activeConfig = resolved

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SCAN_ROUTE,
        handler: createHandler(ctx, resolved),
      }),
    'brain-workspaces: read-only scan route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: REV_ROUTE,
        handler: createRevHandler(ctx),
      }),
    'brain-workspaces: bundle revision route',
  )

  // 术法蒸馏按需查询：点击详情卡里的按钮才触发，不参与星云扫描。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SKILLS_ROUTE,
        handler: createSkillsHandler(ctx),
      }),
    'brain-workspaces: read-only skills route',
  )

  // 三个写动作：蒸馏 / 移入回收站 / 提升为全局。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SKILLS_PREVIEW_ROUTE,
        handler: createSkillsPreviewHandler(ctx),
      }),
    'brain-workspaces: read-only skills preview route',
  )

  for (const [route, actionKind] of [
    [SKILLS_DISTILL_ROUTE, 'distill'],
    [SKILLS_TRASH_ROUTE, 'trash'],
    [SKILLS_GLOBALIZE_ROUTE, 'globalize'],
    [SKILLS_IGNORE_ROUTE, 'ignore'],
    [SKILLS_UNIGNORE_ROUTE, 'unignore'],
  ]) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: route,
          handler: createSkillsActionHandler(ctx, actionKind),
        }),
      'brain-workspaces: skills action ' + actionKind,
    )
  }
}
