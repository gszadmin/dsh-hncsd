/**
 * 可迁移性判断与内容指纹：纯函数，不碰磁盘、不调模型、结果稳定可复现。
 *
 * 这里的定位是**提示**，不是裁决：命中项目标识只说明「这个技能正文里写着某个工作区的路径、
 * 包名或内网地址」，不代表它一定不能跨工作区用；没命中也不代表它一定通用。
 * 面板上把它显示成推荐依据的一行文字，最终由用户判断（用户 2026-11-22 确认）。
 *
 * 另一个用途是内容指纹：`contentHash` 标识**当前文件内容**。历史加载记录的版本无法还原，
 * 因此任何跨工作区证据都必须带 `evidenceVersion: 'unknown'`，绝不能拿当前指纹去追认。
 */
import { createHash } from 'node:crypto'

/** 内容指纹：sha256 前 16 位十六进制。空内容没有指纹（返回空串，不编造）。 */
export function contentHash(text) {
  if (typeof text !== 'string' || !text) return ''
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 工作区名里过于通用的词不做命中（否则 'work'、'app' 这类会满屏误报）。 */
const GENERIC_WORKSPACE_NAMES = new Set([
  'work',
  'works',
  'src',
  'app',
  'apps',
  'code',
  'project',
  'projects',
  'demo',
  'test',
  'tests',
  'docs',
  'doc',
  'home',
  'tmp',
  'temp',
  'data',
  'local',
  'default',
])

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 每条规则：kind + 全局正则；workspace 规则按调用参数动态生成。 */
const STATIC_RULES = [
  // Windows 盘符路径：`E:\work\my-app`（反斜杠形式）。
  // 前面不能是字母/数字，否则 `https:/`、`apps:/app` 里的 `s:/`、`p:/` 会被误认成盘符。
  { kind: 'drive', pattern: /(?<![A-Za-z0-9])[A-Za-z]:\\[^\s'"`<>|，。；：、（）()[\]]+/g },
  // 正斜杠形式 `E:/work/x`：同样排除 `://`，避免把 URL 当路径。
  { kind: 'drive', pattern: /(?<![A-Za-z0-9])[A-Za-z]:\/(?!\/)[^\s'"`<>|，。；：、（）()[\]]+/g },
  // UNC 共享：`\\nas\share`
  { kind: 'drive', pattern: /\\\\[^\s'"`<>|，。；：、（）()[\]]+/g },
  // 项目内自建包：本仓库约定 `@local/<name>`（产品自带的作用域如 @deepseek-ai 不算）
  { kind: 'package', pattern: /@local\/[a-z0-9][a-z0-9._-]*/gi },
  // 内网地址：私有网段 IP（可带端口）
  { kind: 'host', pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}(?::\d{2,5})?\b/g },
  // 内网域名后缀
  { kind: 'host', pattern: /https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lan|local|internal)(?::\d{2,5})?/gi },
  // 本机端口：弱提示（很多通用排障文档也会写 localhost 端口），单独归为 port。
  { kind: 'port', pattern: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/g },
]

// 「不适用场景」里也含"适用场景"四个字，所以正向判断要排除前面那个"不"。
const TRIGGER_RE =
  /(触发条件|触发时机|触发场景|何时使用|使用场景|(?<!不)适用场景|适用范围|when to use|use when|trigger)/i
const SCOPE_RE = /(不适用|不适用场景|不要使用|out of scope|don't use|do not use)/i
const STEP_LINE_RE = /^\s*(?:\d+[.)、]\s|步骤\s*\d|step\s*\d)/gim

const MAX_PER_KIND = 2
const MAX_MARKERS = 6
const SNIPPET_MAX = 80

function cleanSnippet(raw) {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1) + '…' : text
}

/**
 * 判断一段技能正文里有哪些「项目依赖提示」与哪些「可迁移结构」。
 *
 * @param {string} text SKILL.md 原文
 * @param {{ workspacePath?: string, workspaceName?: string }} [context]
 * @returns {{
 *   markers: Array<{ kind: 'drive'|'workspace'|'package'|'host'|'port', snippet: string }>,
 *   structure: { trigger: boolean, steps: boolean, scope: boolean },
 *   transferable: boolean,
 * }}
 */
export function lintPortability(text, context) {
  const source = typeof text === 'string' ? text : ''
  const options = context || {}
  const markers = []
  const seen = new Set()
  const perKind = new Map()

  const push = (kind, raw) => {
    const snippet = cleanSnippet(raw)
    if (!snippet) return
    const dedupe = kind + '\u0000' + snippet.toLowerCase()
    if (seen.has(dedupe)) return
    if ((perKind.get(kind) ?? 0) >= MAX_PER_KIND) return
    if (markers.length >= MAX_MARKERS) return
    seen.add(dedupe)
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1)
    markers.push({ kind, snippet })
  }

  const rules = STATIC_RULES.slice()
  const workspaceName = String(options.workspaceName ?? '').trim()
  if (workspaceName.length >= 3 && !GENERIC_WORKSPACE_NAMES.has(workspaceName.toLowerCase())) {
    rules.unshift({
      kind: 'workspace',
      pattern: new RegExp('(?<![A-Za-z0-9_-])' + escapeRegExp(workspaceName) + '(?![A-Za-z0-9_-])', 'gi'),
    })
  }

  for (const rule of rules) {
    // 每条规则都要独立的正则实例：全局正则会带 lastIndex，复用会漏匹配。
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    let match
    while ((match = pattern.exec(source)) !== null) {
      push(rule.kind, match[0])
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1
    }
  }

  const stepLines = source.match(STEP_LINE_RE)
  const structure = {
    trigger: TRIGGER_RE.test(source),
    steps: Array.isArray(stepLines) && stepLines.length >= 2,
    scope: SCOPE_RE.test(source),
  }

  // 「可迁移」= 没有强项目标识（本机端口这类弱提示不算），并且写了触发条件或操作步骤。
  const strongMarkers = markers.filter((marker) => marker.kind !== 'port')
  return {
    markers,
    structure,
    transferable: strongMarkers.length === 0 && (structure.trigger || structure.steps),
  }
}
