/**
 * 术法蒸馏（工作区技能）数据层：只读汇总，供 /api/skills 路由与详情面板使用。
 *
 * 三个来源，全部本地只读：
 *   1. `<DSH_HOME>/storages/session_projcache/sessions/*.json`
 *      会话投影里 `contextTimeline.surface` 的 `{ cat:'skill', tool:'skill', skill:<名字> }`
 *      是一次真实加载；`record.identity.cwd` 给出它属于哪个工作区。
 *   2. 技能目录：`<工作区>/.dsh/skills`、`<工作区>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`。
 *   3. `~/.mnemon/skills/ledger.json`：只取计数，不读证据正文。
 *
 * `buildSkillsPayload` 是纯函数（不碰磁盘），聚合规则与回归测试都在它身上；
 * `collectSkillsReport` 负责读盘，把结果整形后交给它。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { REMOVABLE_MAX_LOADS, readIgnored, readScope } from './actions.js'
import { contentHash, lintPortability } from './portability.js'

/** 工作区里技能根的相对路径，顺序即优先级（先命中者为准）。 */
export const PROJECT_SKILL_ROOTS = ['.dsh/skills', '.agents/skills']

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 从 SKILL.md 的 frontmatter 取 name / description；取不到就用目录名、空描述。 */
export function parseSkillFrontmatter(text, dirName) {
  const out = { name: dirName, description: '' }
  if (typeof text !== 'string') return out
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return out
  const lines = match[1].split(/\r?\n/)
  const read = (key) => {
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line))
    if (index < 0) return ''
    let value = lines[index].replace(new RegExp(`^${key}:\\s*`), '').trim()
    if (/^[|>][+-]?$/.test(value)) value = ''
    for (let next = index + 1; next < lines.length; next++) {
      if (/^\s+\S/.test(lines[next])) value += ' ' + lines[next].trim()
      else if (lines[next].trim() === '') continue
      else break
    }
    return value.trim()
  }
  const name = read('name')
  if (name && SKILL_NAME_RE.test(name)) out.name = name
  out.description = read('description')
  return out
}

const asCount = (value) => (typeof value === 'number' ? value : value instanceof Set ? value.size : 0)

/**
 * 纯聚合：把「会话使用记录 + 技能元数据 + 账本计数」拼成面板要的整份数据。
 *
 * @param {{
 *   generatedAt?: number,
 *   scannedSessions?: number,
 *   unreadable?: number,
 *   selectedPath?: string,
 *   usage?: Array<{ workspace: string, name: string, loads: number, sessions: number|Set, last?: number }>,
 *   workspaceSessions?: Array<{ workspace: string, sessions: number|Set }>,
 *   skillMeta?: Array<{ workspace: string|null, name: string, scope?: string, description?: string, bytes?: number, mtime?: number, file?: string }>,
 *   ledger?: object|null,
 *   maxSkillsPerWorkspace?: number,
 * }} input
 */
export function buildSkillsPayload(input = {}) {
  const usage = Array.isArray(input.usage) ? input.usage : []
  const workspaceSessions = Array.isArray(input.workspaceSessions) ? input.workspaceSessions : []
  const skillMeta = Array.isArray(input.skillMeta) ? input.skillMeta : []
  const maxSkills = Number.isFinite(input.maxSkillsPerWorkspace) && input.maxSkillsPerWorkspace > 0 ? input.maxSkillsPerWorkspace : 60

  // workspace -> skill -> 计数
  const useByWorkspace = new Map()
  const crossWorkspace = new Map()
  for (const row of usage) {
    if (!row || typeof row.workspace !== 'string' || typeof row.name !== 'string') continue
    const perSkill = useByWorkspace.get(row.workspace) ?? new Map()
    useByWorkspace.set(row.workspace, perSkill)
    const rec = perSkill.get(row.name) ?? { loads: 0, sessions: 0, last: 0 }
    rec.loads += Number(row.loads) || 0
    rec.sessions += asCount(row.sessions)
    rec.last = Math.max(rec.last, Number(row.last) || 0)
    perSkill.set(row.name, rec)
    const cross = crossWorkspace.get(row.name) ?? { name: row.name, loads: 0, workspaces: new Set() }
    cross.loads += Number(row.loads) || 0
    cross.workspaces.add(row.workspace)
    crossWorkspace.set(row.name, cross)
  }

  // workspace -> 技能元数据
  const metaByWorkspace = new Map()
  const userSkills = new Map()
  for (const meta of skillMeta) {
    if (!meta || typeof meta.name !== 'string') continue
    const scope = meta.scope || (meta.workspace ? 'project' : 'user')
    const markers = Array.isArray(meta.markers) ? meta.markers : []
    const structure =
      meta.structure && typeof meta.structure === 'object'
        ? {
            trigger: Boolean(meta.structure.trigger),
            steps: Boolean(meta.structure.steps),
            scope: Boolean(meta.structure.scope),
          }
        : { trigger: false, steps: false, scope: false }
    const record = {
      name: meta.name,
      scope,
      description: meta.description || '',
      bytes: Number(meta.bytes) || 0,
      mtime: Number(meta.mtime) || 0,
      file: meta.file || '',
      // 当前文件内容的指纹。它只标识"现在这份正文"，不能用来追认历史加载的版本。
      hash: typeof meta.hash === 'string' ? meta.hash : '',
      markers,
      structure,
      // 可迁移 = 没有强项目标识（本机端口算弱提示）+ 有触发条件或步骤（调用方没给就按同一规则算，不编造）。
      transferable:
        meta.transferable !== undefined
          ? Boolean(meta.transferable)
          : markers.filter((marker) => marker.kind !== 'port').length === 0 && (structure.trigger || structure.steps),
    }
    if (scope === 'project' && typeof meta.workspace === 'string') {
      const perSkill = metaByWorkspace.get(meta.workspace) ?? new Map()
      if (!perSkill.has(meta.name)) perSkill.set(meta.name, record)
      metaByWorkspace.set(meta.workspace, perSkill)
    } else if (!userSkills.has(meta.name)) {
      userSkills.set(meta.name, record)
    }
  }

  const sessionCounts = new Map()
  for (const row of workspaceSessions) {
    if (!row || typeof row.workspace !== 'string') continue
    sessionCounts.set(row.workspace, (sessionCounts.get(row.workspace) || 0) + asCount(row.sessions))
  }

  const workspacePaths = new Set([...useByWorkspace.keys(), ...metaByWorkspace.keys(), ...sessionCounts.keys()])
  const workspaces = []
  for (const workspace of workspacePaths) {
    const projectSkills = metaByWorkspace.get(workspace) ?? new Map()
    const perSkill = useByWorkspace.get(workspace) ?? new Map()
    const names = new Set([...projectSkills.keys(), ...perSkill.keys()])
    const skills = []
    for (const name of names) {
      const meta = projectSkills.get(name) ?? userSkills.get(name) ?? null
      const rec = perSkill.get(name) ?? null
      skills.push({
        name,
        scope: projectSkills.has(name) ? 'project' : meta ? 'user' : 'unlocated',
        description: meta?.description ?? '',
        bytes: meta?.bytes ?? 0,
        mtime: meta?.mtime ?? 0,
        file: meta?.file ?? '',
        loads: rec?.loads ?? 0,
        sessions: rec?.sessions ?? 0,
        lastUsed: rec?.last ?? 0,
        // 同名技能被加载过的工作区数：历史记录，版本未知（既不是"已验证通用"，也不是"可复用"）。
        workspacesUsed: crossWorkspace.get(name)?.workspaces.size ?? 0,
        hash: meta?.hash ?? '',
        markers: meta?.markers ?? [],
        structure: meta?.structure ?? null,
        // 可迁移 = 没有强项目标识 + 有触发条件或步骤；元数据没给就当场按同一规则算，不再读盘。
        transferable:
          meta?.transferable !== undefined
            ? Boolean(meta.transferable)
            : (meta?.markers ?? []).filter((marker) => marker.kind !== 'port').length === 0 &&
              Boolean(meta?.structure && (meta.structure.trigger || meta.structure.steps)),
        // 「使用次数少」可删：阈值见 actions.js 的 REMOVABLE_MAX_LOADS。
        removable: (rec?.loads ?? 0) <= REMOVABLE_MAX_LOADS,
      })
    }
    skills.sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
    const trimmed = skills.slice(0, maxSkills)
    workspaces.push({
      path: workspace,
      name: workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace,
      sessions: sessionCounts.get(workspace) ?? 0,
      loads: trimmed.reduce((sum, skill) => sum + skill.loads, 0),
      distilled: trimmed.filter((skill) => skill.scope === 'project').length,
      skills: trimmed,
      selected: input.selectedPath ? workspace === input.selectedPath : false,
    })
  }
  workspaces.sort((a, b) => Number(b.selected) - Number(a.selected) || b.loads - a.loads || b.skills.length - a.skills.length)

  const unused = []
  for (const workspace of workspaces) {
    for (const skill of workspace.skills) {
      if (skill.loads === 0 && skill.scope === 'project') {
        unused.push({ name: skill.name, workspace: workspace.name, workspacePath: workspace.path, mtime: skill.mtime, bytes: skill.bytes })
      }
    }
  }
  for (const [name, meta] of userSkills) {
    if (!crossWorkspace.has(name)) unused.push({ name, workspace: '', workspacePath: '', mtime: meta.mtime, bytes: meta.bytes })
  }
  unused.sort((a, b) => b.mtime - a.mtime)

  const allSkills = workspaces.flatMap((workspace) => workspace.skills)

  // 内容身份：同名但正文不同，就是两个不同的东西。历史加载只记了技能名，没记版本，
  // 所以「同名」不能被当成「同一份内容被复用过」——这里是本次修复的核心口径。
  const contentWorkspaces = new Map()
  for (const workspace of workspaces) {
    for (const skill of workspace.skills) {
      if (skill.scope !== 'project' || !skill.hash) continue
      const identity = skill.name + '|' + skill.hash
      const set = contentWorkspaces.get(identity) ?? new Set()
      set.add(workspace.path)
      contentWorkspaces.set(identity, set)
    }
  }

  // 可提升为全局的项目技能。按「工作区 + 名字 + 内容指纹」分行，不再把同名合并成一条。
  //
  // 状态只是提示，不是推荐也不是否决（用户 2026-11-22 确认）：
  //   - 「热度」（loads/sessions）只说明这个工作区经常加载它，不构成跨工作区适用；
  //   - 「项目标识」只说明正文里写着某个工作区的东西，最终仍由人判断；
  //   - 跨工作区的名字出现次数是使用记录，版本未知，不能称为"已验证通用"。
  const promotableRows = []
  for (const workspace of workspaces) {
    for (const skill of workspace.skills) {
      if (skill.scope !== 'project') continue
      if (userSkills.has(skill.name)) continue
      const markers = Array.isArray(skill.markers) ? skill.markers : []
      const sameContent = contentWorkspaces.get(skill.name + '|' + skill.hash) ?? new Set([workspace.path])
      const recorded = crossWorkspace.get(skill.name)?.workspaces ?? new Set()
      const sameContentOthers = Math.max(0, sameContent.size - 1)
      // 弱提示（本机端口）不足以判成项目专用：很多通用排障文档也会写 localhost:端口。
      const strongMarkers = markers.filter((marker) => marker.kind !== 'port')
      promotableRows.push({
        name: skill.name,
        workspace: workspace.name,
        workspacePath: workspace.path,
        loads: skill.loads,
        sessions: skill.sessions,
        // 当前文件内容的指纹（不是历史加载的版本）。
        hash: skill.hash,
        status: strongMarkers.length ? 'project-specific' : skill.transferable ? 'portable' : 'needs-structure',
        markers,
        structure: skill.structure,
        transferable: Boolean(skill.transferable),
        // 当前内容相同的其他工作区（内容身份）。
        workspacesUsed: sameContentOthers,
        // 同名技能被加载过的工作区数（历史，版本未知）。
        recordedWorkspaces: recorded.size,
        evidenceVersion: 'unknown',
        description: skill.description,
        bytes: skill.bytes,
        basis: {
          evidenceVersion: 'unknown',
          heat: { loads: skill.loads, sessions: skill.sessions },
          workspaces: { sameContent: sameContentOthers, recorded: recorded.size },
          markers,
          structure: skill.structure,
        },
      })
    }
  }
  // 排序按证据：没命中项目标识的排前面，然后才是热度。没有任何一条因为"够热"被抬成推荐。
  const statusRank = { portable: 0, 'needs-structure': 1, 'project-specific': 2 }
  const allPromotable = promotableRows.sort(
    (a, b) =>
      (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
      b.loads - a.loads ||
      b.workspacesUsed - a.workspacesUsed ||
      a.name.localeCompare(b.name),
  )
  const ignoredRows = Array.isArray(input.ignored) ? input.ignored : []
  const ignoredKeys = new Set(ignoredRows.map((row) => String(row?.workspace ?? '') + '|' + String(row?.name ?? '')))
  const promotable = allPromotable.filter((item) => !ignoredKeys.has(item.workspacePath + '|' + item.name))
  // 已忽略清单是权威：清单里每一条都要能看见（包括技能已被删掉/已加入全局的老记录），
  // 匹配不到当前候选的标 unmatched，这样「查看已忽略」入口不会假装只有几条。
  const ignoredPromotions = ignoredRows
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => {
      const workspacePath = String(row.workspace ?? '')
      const found = allPromotable.find((item) => item.workspacePath === workspacePath && item.name === row.name)
      if (found) return { ...found, ignoredAt: String(row.at ?? '') }
      return {
        name: row.name,
        workspace: workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '',
        workspacePath,
        loads: 0,
        sessions: 0,
        hash: '',
        status: 'unknown',
        markers: [],
        structure: null,
        workspacesUsed: 0,
        recordedWorkspaces: 0,
        evidenceVersion: 'unknown',
        unmatched: true,
        ignoredAt: String(row.at ?? ''),
      }
    })

  // 「已加入全局」的记录来自状态账本。它只陈述事实：什么时候加入、加入时指纹、当前指纹是否一致。
  // 只有账本里存在与当前指纹一致的**显式验证记录**才会出现 verified；本期没有任何写验证的入口，
  // 所以不会出现"已验证通用"。跨工作区加载仍是版本未知的使用记录。
  const promotions = Array.isArray(input.scopeLedger?.promotions) ? input.scopeLedger.promotions : []
  const verifications = Array.isArray(input.scopeLedger?.verifications) ? input.scopeLedger.verifications : []
  const promotedByName = new Map()
  for (const row of promotions) {
    if (!row || typeof row.name !== 'string') continue
    const globalMeta = userSkills.get(row.name)
    const currentHash = globalMeta?.hash || ''
    const promotedHash = typeof row.hash === 'string' ? row.hash : ''
    const hashComparable = Boolean(currentHash && promotedHash)
    const hashChanged = hashComparable && currentHash !== promotedHash
    const verified = verifications.some((entry) => entry && entry.name === row.name && hashComparable && entry.hash === currentHash)
    const usage = crossWorkspace.get(row.name)
    const from = String(row.from ?? '')
    const record = {
      name: row.name,
      from,
      fromName: from.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '',
      at: String(row.at ?? ''),
      hash: promotedHash,
      currentHash,
      hashChanged,
      existsGlobal: userSkills.has(row.name),
      status: verified ? 'verified' : hashComparable ? 'pending-verification' : 'unknown',
      loads: usage?.loads ?? 0,
      workspacesUsed: usage?.workspaces.size ?? 0,
      evidenceVersion: 'unknown',
    }
    const existing = promotedByName.get(row.name)
    if (!existing || String(existing.at) < record.at) promotedByName.set(row.name, record)
  }
  const promoted = [...promotedByName.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.name.localeCompare(b.name))

  return {
    ok: true,
    generatedAt: Number(input.generatedAt) || Date.now(),
    source: {
      sessionsScanned: Number(input.scannedSessions) || 0,
      unreadable: Number(input.unreadable) || 0,
    },
    totals: {
      workspaces: workspaces.length,
      workspacesWithSkills: workspaces.filter((workspace) => workspace.skills.length > 0).length,
      skills: new Set(allSkills.map((skill) => skill.name)).size,
      // 「被用过的不同技能」= 至少被真实加载过一次的技能数，与技能总数（含没被用过的）不是一回事。
      usedSkills: new Set(allSkills.filter((skill) => skill.loads > 0).map((skill) => skill.name)).size,
      projectSkills: new Set(allSkills.filter((skill) => skill.scope === 'project').map((skill) => skill.name)).size,
      userSkills: userSkills.size,
      loads: allSkills.reduce((sum, skill) => sum + skill.loads, 0),
      // 「用过技能的会话」= 至少有一条真实加载的会话数（按文件去重），与加载次数不是一回事。
      sessionsWithSkill: Number(input.sessionsWithSkill) || 0,
      reused: [...crossWorkspace.values()].filter((row) => row.workspaces.size > 1).length,
    },
    workspaces,
    promotable,
    promoted,
    // 账本自身是否可读：缺文件是正常的（还没加入过技能），坏了要让人知道记录为什么不见。
    scopeLedger: {
      available: Boolean(input.scopeLedger?.available),
      reason: String(input.scopeLedger?.reason || (input.scopeLedger?.available ? '' : 'missing')),
    },
    ignoredPromotions,
    topSkills: [...crossWorkspace.values()]
      .map((row) => ({ name: row.name, loads: row.loads, workspaces: row.workspaces.size }))
      .sort((a, b) => b.loads - a.loads)
      .slice(0, 12),
    unused: unused.slice(0, 60),
    evolution: input.ledger ?? null,
  }
}

/**
 * 读一个技能根目录，返回 `名字 -> 元数据` 的 Map。
 *
 * 每份 SKILL.md 只读一次：同时给出内容指纹（当前内容身份）和可迁移性 lint 结果（面板依据行）。
 * `context.workspacePath` 只用于判断"正文里有没有提到它所在的工作区"，不写回任何地方。
 */
export async function listSkillDirs(root, context) {
  const map = new Map()
  const settings = context || {}
  const workspacePath = typeof settings.workspacePath === 'string' ? settings.workspacePath : ''
  const workspaceName = settings.workspaceName || (workspacePath ? basename(workspacePath.replace(/[\\/]+$/, '')) : '')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return map
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, 'SKILL.md')
    try {
      const info = await stat(file)
      const text = await readFile(file, 'utf8')
      const frontmatter = parseSkillFrontmatter(text, entry.name)
      if (map.has(frontmatter.name)) continue
      const lint = lintPortability(text, { workspacePath, workspaceName })
      map.set(frontmatter.name, {
        name: frontmatter.name,
        description: frontmatter.description,
        bytes: info.size,
        mtime: info.mtimeMs,
        file,
        hash: contentHash(text),
        markers: lint.markers,
        structure: lint.structure,
        transferable: lint.transferable,
      })
    } catch {
      /* 不是技能目录 */
    }
  }
  return map
}

/** 扫一遍会话投影，返回按工作区归属的技能加载记录。 */
export async function scanSkillUsage(projectionDir) {
  const usage = []
  const workspaceSessions = new Map()
  const sessionsWithSkill = new Set()
  let scanned = 0
  let unreadable = 0
  let files
  try {
    files = (await readdir(projectionDir)).filter((file) => file.endsWith('.json'))
  } catch {
    return { usage, workspaceSessions, scanned, unreadable }
  }
  let processed = 0
  for (const file of files) {
    let doc
    try {
      doc = JSON.parse(await readFile(join(projectionDir, file), 'utf8'))
    } catch {
      unreadable++
      continue
    }
    scanned++
    processed++
    // 大目录逐条读盘会让事件循环憋住，隔一段让一次。
    if (processed % 64 === 0) await new Promise((resolve) => setImmediate(resolve))
    const workspace = doc?.record?.identity?.cwd
    if (typeof workspace !== 'string' || !workspace) continue
    workspaceSessions.set(workspace, (workspaceSessions.get(workspace) ?? 0) + 1)
    const surface = doc?.record?.rows?.contextTimeline?.val?.surface
    if (!Array.isArray(surface)) continue
    const perSkill = new Map()
    for (const item of surface) {
      if (item?.cat !== 'skill' || item?.tool !== 'skill' || typeof item?.skill !== 'string') continue
      const rec = perSkill.get(item.skill) ?? { loads: 0, sessions: 0, last: 0 }
      rec.loads++
      rec.sessions++
      rec.last = Math.max(rec.last, Number(item.time) || 0)
      perSkill.set(item.skill, rec)
    }
    for (const [name, rec] of perSkill) usage.push({ workspace, name, ...rec })
    if (perSkill.size) sessionsWithSkill.add(file)
  }
  return { usage, workspaceSessions, sessionsWithSkill: sessionsWithSkill.size, scanned, unreadable }
}

/** 读 mnemon 账本，只留计数。 */
export async function readSkillsLedger(ledgerPath) {
  try {
    const doc = JSON.parse(await readFile(ledgerPath, 'utf8'))
    const count = (rows, key) => {
      const out = {}
      for (const row of Array.isArray(rows) ? rows : []) {
        const value = String(row?.[key] ?? 'unknown')
        out[value] = (out[value] ?? 0) + 1
      }
      return out
    }
    return {
      available: true,
      reviews: (doc.reviews ?? []).length,
      reviewOutcomes: count(doc.reviews, 'outcome'),
      suggestions: (doc.suggestions ?? []).length,
      suggestionStatus: count(doc.suggestions, 'status'),
      drafts: (doc.drafts ?? []).length,
      draftStatus: count(doc.drafts, 'status'),
    }
  } catch {
    return { available: false }
  }
}

/**
 * 读盘 + 聚合的唯一入口。
 *
 * @param {{ dshHome: string, mnemonRoot: string, selectedPath?: string, maxSkillsPerWorkspace?: number }} options
 */
export async function collectSkillsReport(options) {
  const { dshHome, mnemonRoot, selectedPath, maxSkillsPerWorkspace } = options
  const projectionDir = join(dshHome, 'storages', 'session_projcache', 'sessions')
  const { usage, workspaceSessions, sessionsWithSkill, scanned, unreadable } = await scanSkillUsage(projectionDir)

  const skillMeta = []
  const workspaces = new Set([...workspaceSessions.keys(), ...usage.map((row) => row.workspace)])
  for (const workspace of workspaces) {
    for (const root of PROJECT_SKILL_ROOTS) {
      const found = await listSkillDirs(join(workspace, root), { workspacePath: workspace })
      for (const meta of found.values()) {
        skillMeta.push({ ...meta, workspace, scope: 'project' })
      }
    }
  }
  for (const root of [join(dshHome, 'skills'), join(dshHome, '.agents', 'skills')]) {
    for (const meta of (await listSkillDirs(root, {})).values()) skillMeta.push({ ...meta, workspace: null, scope: 'user' })
  }

  const ledger = await readSkillsLedger(join(mnemonRoot, 'skills', 'ledger.json'))
  return buildSkillsPayload({
    generatedAt: Date.now(),
    scannedSessions: scanned,
    sessionsWithSkill,
    unreadable,
    selectedPath,
    usage,
    workspaceSessions: [...workspaceSessions].map(([workspace, sessions]) => ({ workspace, sessions })),
    skillMeta,
    ledger,
    ignored: await readIgnored(dshHome),
    scopeLedger: await readScope(dshHome),
    maxSkillsPerWorkspace,
  })
}
