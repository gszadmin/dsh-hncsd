/**
 * 术法蒸馏的三个写动作：蒸馏（规范化 frontmatter）、移入回收站、提升为全局。
 *
 * 三条硬纪律：
 *   1. 只碰 `<工作区>/.dsh/skills/<name>` 与 `~/.dsh/skills/<name>`，名字必须过 kebab-case 正则，
 *      解析后的路径必须还在技能根之内（防 `../` 穿越）。
 *   2. 任何写之前先留一份原文件到 `<工作区>/.dsh/skills-versions/<name>/<时间戳>.md`，
 *      失败时目标文件保持原样（先写临时文件再 rename）。
 *   3. 删除不是真删：整目录移到 `<工作区>/.dsh/skills-trash/<时间戳>-<name>/`，随时可以搬回来。
 *
 * 这里没有模型调用：蒸馏只做「让文件变成模型真能发现并加载的形状」这件事。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { contentHash } from './portability.js'

export const SKILLS_SUBDIR = '.dsh/skills'
export const TRASH_SUBDIR = '.dsh/skills-trash'
export const VERSIONS_SUBDIR = '.dsh/skills-versions'

/** 「使用次数少」的阈值：0 或 1 次才算低频，可删。 */
export const REMOVABLE_MAX_LOADS = 1
// 2026-11-22 删除「加载够多 / 跨够多工作区就推荐全局」两个阈值常量：
// 单工作区加载次数只说明热度；跨工作区加载是版本未知的使用记录，两者都不构成"推荐"。
// 判断依据改为内容指纹 + 项目标识提示，见 portability.js 与 report.js。

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MIN_DESCRIPTION_CHARS = 40

export class ActionError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** 校验技能名：只允许 kebab-case，挡住路径穿越。 */
export function assertSkillName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ActionError('bad-name', '技能名必须是小写字母、数字和单个连字符')
  }
  return name
}

/** 解析出技能目录，并确认它确实落在给定技能根之内。 */
export function resolveSkillDir(root, name) {
  assertSkillName(name)
  const dir = resolve(root, name)
  const parent = resolve(root)
  if (dir !== join(parent, name) || !dir.startsWith(parent)) {
    throw new ActionError('bad-path', '技能路径越界')
  }
  return dir
}

/** 把一个工作区路径收敛成它的项目技能根。 */
export function projectSkillsRoot(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new ActionError('bad-workspace', '缺少工作区路径')
  return join(resolve(workspace), SKILLS_SUBDIR)
}

/** 取正文第一段可用作描述的文字（跳过标题、代码块、列表符号）。 */
export function firstParagraph(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const picked = []
  let inCode = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if (!line) {
      if (picked.length) break
      continue
    }
    if (line.startsWith('#')) continue
    if (/^[-*>]\s/.test(line)) continue
    if (/^\|/.test(line)) continue
    picked.push(line)
    if (picked.join(' ').length > 240) break
  }
  return picked.join(' ').replace(/\s+/g, ' ').trim()
}

/** 把 frontmatter 与正文拆开。没有 frontmatter 时 frontmatter 为空串。 */
export function splitDocument(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { frontmatter: '', body: String(text ?? '') }
  return { frontmatter: match[1], body: text.slice(match[0].length) }
}

/**
 * 纯函数：算出「蒸馏后应该长什么样」以及改了哪些字段。
 * 规则（无模型调用，可复现）：
 *   - 没有 frontmatter / 没有 name → 用目录名补；
 *   - 没有 description 或短于 40 字 → 用正文第一段补/续；
 *   - 其余字段原样保留；顺序固定为 name, description，其后是原有其它键。
 */
export function planDistill(text, dirName) {
  const { frontmatter, body } = splitDocument(text)
  const lines = frontmatter ? frontmatter.split(/\r?\n/) : []
  const fields = []
  let name = ''
  let description = ''
  for (const line of lines) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!m) {
      fields.push({ raw: line })
      continue
    }
    const [, key, value] = m
    if (key === 'name') {
      name = value.trim()
      continue
    }
    if (key === 'description') {
      description = value.trim()
      continue
    }
    fields.push({ key, value })
  }

  const changes = []
  if (!name || !NAME_RE.test(name)) {
    name = dirName
    changes.push('name')
  }
  const paragraph = firstParagraph(body)
  if (!description) {
    description = paragraph.slice(0, 240)
    if (description) changes.push('description')
  } else {
    // 只在描述短到几乎没信息量时补一次，且描述里已经含这段正文就不再追加（保证幂等）。
    const thin = description.replace(/\s/g, '').length < MIN_DESCRIPTION_CHARS
    const alreadyCovered = paragraph && (description.includes(paragraph) || paragraph.startsWith(description.slice(0, 12)))
    if (thin && paragraph && !alreadyCovered) {
      description = (description + ' ' + paragraph).replace(/\s+/g, ' ').trim().slice(0, 400)
      changes.push('description')
    }
  }

  const rendered = ['---', 'name: ' + name]
  if (description) rendered.push('description: ' + description)
  for (const field of fields) {
    if (field.raw !== undefined) {
      if (field.raw.trim()) rendered.push(field.raw)
      continue
    }
    rendered.push(field.key + ': ' + field.value)
  }
  rendered.push('---', '')
  const separator = body.startsWith('\n') ? '' : '\n'
  const next = rendered.join('\n') + separator + body
  return { text: next, changes, name, description }
}

async function backup(versionsDir, dirName, original) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(versionsDir, dirName)
  await mkdir(target, { recursive: true })
  const file = join(target, stamp + '.md')
  await writeFile(file, original, 'utf8')
  return file
}

/** 原子写：先写同级临时文件，再 rename 覆盖。 */
async function writeAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/**
 * 蒸馏一个技能：规范化 frontmatter，原文件留版本，返回改了哪些字段。
 * 已经合规时什么都不写（changes 为空），幂等。
 */
export async function distillSkill({ workspace, name }) {
  const root = projectSkillsRoot(workspace)
  const dir = resolveSkillDir(root, name)
  const file = join(dir, 'SKILL.md')
  let original
  try {
    original = await readFile(file, 'utf8')
  } catch {
    throw new ActionError('missing', '这个技能没有 SKILL.md（可能只有目录）', 404)
  }
  const plan = planDistill(original, basename(dir))
  if (plan.changes.length === 0) {
    return { ok: true, changed: [], file, backup: null }
  }
  const backupFile = await backup(join(resolve(workspace), VERSIONS_SUBDIR), basename(dir), original)
  await writeAtomic(file, plan.text)
  return { ok: true, changed: plan.changes, file, backup: backupFile }
}

/** 移入回收站（不是真删）：整目录搬到 `<工作区>/.dsh/skills-trash/<时间戳>-<name>/`。
 *  给了 mnemonRoot 时，顺手把账本里针对这个技能的建议/草案/版本记录一起清掉（先备份账本）。 */
export async function trashSkill({ workspace, name, loads, mnemonRoot }) {
  if (Number(loads) > REMOVABLE_MAX_LOADS) {
    throw new ActionError('too-used', '使用次数超过阈值的技能不允许在这里删除', 409)
  }
  const root = projectSkillsRoot(workspace)
  const dir = resolveSkillDir(root, name)
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new ActionError('not-a-directory', '目标不是技能目录')
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError('missing', '技能目录不存在', 404)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trashRoot = join(resolve(workspace), TRASH_SUBDIR)
  await mkdir(trashRoot, { recursive: true })
  const target = join(trashRoot, stamp + '-' + name)
  await rename(dir, target)
  let ledger = null
  if (mnemonRoot) {
    try {
      ledger = await cascadeLedger({ mnemonRoot, name })
    } catch (error) {
      // 账本清理失败不该把「已经搬走的技能」回滚；如实报告。
      ledger = { ok: false, message: String((error && error.message) || error) }
    }
  }
  return { ok: true, movedTo: target, ledger }
}

/**
 * 级联清理 mnemon 账本里属于这个技能的记录：建议、草案、版本。
 * 只动这三类；复盘记录与对话轨迹是历史证据，保留。写之前先备份账本。
 */
export async function cascadeLedger({ mnemonRoot, name }) {
  assertSkillName(name)
  const file = join(resolve(mnemonRoot), 'skills', 'ledger.json')
  let ledger
  try {
    ledger = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { ok: true, skipped: 'no-ledger', removed: { suggestions: 0, drafts: 0, versions: 0 } }
  }
  const before = {
    suggestions: Array.isArray(ledger.suggestions) ? ledger.suggestions.length : 0,
    drafts: Array.isArray(ledger.drafts) ? ledger.drafts.length : 0,
    versions: Array.isArray(ledger.versions) ? ledger.versions.length : 0,
  }
  if (Array.isArray(ledger.suggestions)) ledger.suggestions = ledger.suggestions.filter((row) => row?.skillName !== name)
  if (Array.isArray(ledger.drafts)) ledger.drafts = ledger.drafts.filter((row) => row?.skillName !== name)
  if (Array.isArray(ledger.versions)) {
    ledger.versions = ledger.versions.filter((row) => !String(row?.skillKey ?? '').endsWith(':' + name))
  }
  const removed = {
    suggestions: before.suggestions - (ledger.suggestions?.length ?? 0),
    drafts: before.drafts - (ledger.drafts?.length ?? 0),
    versions: before.versions - (ledger.versions?.length ?? 0),
  }
  if (!removed.suggestions && !removed.drafts && !removed.versions) return { ok: true, removed, backup: null }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(resolve(mnemonRoot), 'skills', `ledger.backup-${stamp}.json`)
  await writeFile(backupPath, await readFile(file, 'utf8'), 'utf8')
  await writeAtomic(file, JSON.stringify(ledger, null, 2))
  return { ok: true, removed, backup: backupPath }
}

/** 「忽略推荐」的持久化文件：放在 DSH_HOME 下，跨工作区生效。 */
export function ignoredFile(dshHome) {
  return join(resolve(dshHome), 'skill-distill-ignored.json')
}

/** 读忽略清单；文件不存在或坏了都返回空清单，不让它拖垮页面。 */
export async function readIgnored(dshHome) {
  try {
    const doc = JSON.parse(await readFile(ignoredFile(dshHome), 'utf8'))
    const items = Array.isArray(doc?.items) ? doc.items : []
    return items.filter((row) => row && typeof row.name === 'string')
  } catch {
    return []
  }
}

async function writeIgnored(dshHome, items) {
  await mkdir(resolve(dshHome), { recursive: true })
  await writeAtomic(ignoredFile(dshHome), JSON.stringify({ version: 1, items }, null, 2))
}

/**
 * 「已加入全局」的状态账本，放在 DSH_HOME 下，跨工作区生效。
 *
 * 只记录事实：谁在什么时候、从哪个工作区、以什么内容指纹加入的全局。
 * 它不写"已验证通用"——那需要人工验收，本期没有任何自动写入口。
 */
export function scopeFile(dshHome) {
  return join(resolve(dshHome), 'skill-distill-scope.json')
}

const isScopeRow = (row) => row && typeof row === 'object' && typeof row.name === 'string'

/** 读状态账本；没有文件是正常状态（还没加入过任何技能），文件坏了才需要提示。 */
export async function readScope(dshHome) {
  try {
    const doc = JSON.parse(await readFile(scopeFile(dshHome), 'utf8'))
    return {
      available: true,
      reason: '',
      promotions: (Array.isArray(doc?.promotions) ? doc.promotions : []).filter(isScopeRow),
      verifications: (Array.isArray(doc?.verifications) ? doc.verifications : []).filter(isScopeRow),
    }
  } catch (error) {
    return {
      available: false,
      reason: error && error.code === 'ENOENT' ? 'missing' : 'broken',
      promotions: [],
      verifications: [],
    }
  }
}

async function writeScope(dshHome, doc) {
  await mkdir(resolve(dshHome), { recursive: true })
  await writeAtomic(
    scopeFile(dshHome),
    JSON.stringify({ version: 1, promotions: doc.promotions ?? [], verifications: doc.verifications ?? [] }, null, 2),
  )
}

/**
 * 记录一次「加入全局」。
 *
 * 幂等：同名 + 同来源 + 同指纹只留一条，并保留最早的加入时间（那才是"什么时候加入的"）。
 * 指纹是复制那一刻的内容；之后正文再改，账本不会跟着改，面板据此显示"已改动"。
 */
export async function recordPromotion({ dshHome, name, from, hash, loads }) {
  assertSkillName(name)
  const doc = await readScope(dshHome)
  // 来源归一化：路径分隔符、尾分隔符、大小写都按 Windows 语义收敛，
  // `E:\work\a` / `E:\work\a\` / `E:/work/a` / `E:\WORK\A` 是同一个工作区，只留一条。
  const normalizeSource = (value) =>
    typeof value === 'string' && value.trim() ? resolve(value).replace(/[\\/]+$/, '') : ''
  const source = normalizeSource(from)
  const sameSource = (row) => normalizeSource(String(row.from ?? '')).toLowerCase() === source.toLowerCase()
  const fingerprint = String(hash ?? '')
  const exists = doc.promotions.some(
    (row) => row.name === name && sameSource(row) && String(row.hash ?? '') === fingerprint,
  )
  if (exists) return { ok: true, added: false, total: doc.promotions.length }
  const promotions = doc.promotions.concat([
    { name, from: source, hash: fingerprint, loads: Number(loads) || 0, at: new Date().toISOString() },
  ])
  await writeScope(dshHome, { promotions, verifications: doc.verifications })
  return { ok: true, added: true, total: promotions.length }
}

/** 忽略一个技能：同名同工作区只留一条。 */
export async function ignoreSkill({ dshHome, name, workspace }) {
  assertSkillName(name)
  const items = await readIgnored(dshHome)
  const exists = items.some((row) => row.name === name && (row.workspace ?? '') === (workspace ?? ''))
  if (!exists) {
    items.push({ name, workspace: workspace ?? '', at: new Date().toISOString() })
    await writeIgnored(dshHome, items)
  }
  return { ok: true, total: items.length, added: !exists }
}

/** 取消忽略。 */
export async function unignoreSkill({ dshHome, name, workspace }) {
  assertSkillName(name)
  const items = await readIgnored(dshHome)
  const next = items.filter((row) => !(row.name === name && (row.workspace ?? '') === (workspace ?? '')))
  if (next.length !== items.length) await writeIgnored(dshHome, next)
  return { ok: true, total: next.length, removed: items.length - next.length }
}

/** 提升为全局：复制到 `~/.dsh/skills/<name>`；目标已存在就拒绝，绝不覆盖。 */
export async function globalizeSkill({ workspace, name, userRoot }) {
  const root = projectSkillsRoot(workspace)
  const from = resolveSkillDir(root, name)
  const to = join(resolve(userRoot), name)
  try {
    await stat(to)
    throw new ActionError('exists', '全局目录里已经有同名技能', 409)
  } catch (error) {
    if (error instanceof ActionError) throw error
    /* 不存在才是我们要的 */
  }
  await mkdir(resolve(userRoot), { recursive: true })
  await mkdir(to, { recursive: false })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true })
      for (const child of await readdir(source, { withFileTypes: true })) {
        if (child.isFile()) {
          await writeFile(join(target, child.name), await readFile(join(source, child.name)))
        }
      }
    } else if (entry.isFile()) {
      await writeFile(target, await readFile(source))
    }
  }
  // 加入全局那一刻的内容指纹：写进状态账本，之后正文一改就能看出"已改动"（不追认历史）。
  let hash = ''
  try {
    hash = contentHash(await readFile(join(to, 'SKILL.md'), 'utf8'))
  } catch {
    hash = ''
  }
  return { ok: true, copiedTo: to, keptOriginal: from, hash }
}

/** 只读：把某个技能的 SKILL.md 前 N 字节拿出来，供「加入全局」之前预览。 */
export async function readSkillDocument({ workspace, name, limitBytes = 8192 }) {
  const root = projectSkillsRoot(workspace)
  const dir = resolveSkillDir(root, name)
  const file = join(dir, 'SKILL.md')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new ActionError('missing', '这个技能没有 SKILL.md', 404)
  }
  const cap = Number(limitBytes) > 0 ? Math.min(Number(limitBytes), 65536) : 8192
  const truncated = text.length > cap
  return { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), text: truncated ? text.slice(0, cap) : text, truncated }
}

/** 列出回收站里的条目，供后续「恢复」用（本版只读展示）。 */
export async function listTrash(workspace) {
  const root = join(resolve(workspace), TRASH_SUBDIR)
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ id: entry.name, path: join(root, entry.name) }))
  } catch {
    return []
  }
}

/** 清空一个临时文件残留（测试与异常路径用）。 */
export async function removePath(target) {
  await rm(target, { recursive: true, force: true })
}
