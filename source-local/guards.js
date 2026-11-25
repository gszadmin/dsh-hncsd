/**
 * Host-side path guards, and the canonical implementation of the boundary rules.
 *
 * The browser bundle cannot import this file (the client module loader does not resolve
 * relative requires between a package's own artifacts), so `client.js` carries a copy for
 * display-time checks. `tests/parity.test.mjs` asserts the two copies agree, and the Host
 * remains authoritative: only the values it returns reach the panel.
 */

export const DEFAULT_IGNORE_NAMES = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.venv',
  'vendor',
])

export const SCAN_LIMITS = Object.freeze({
  maxDepth: { fallback: 5, min: 1, max: 32 },
  // The scanner honours any positive budget; the HTTP route applies a stricter floor (100)
  // because a request-supplied budget that low can only produce a useless partial scan.
  maxDirs: { fallback: 20000, min: 1, max: 200000 },
  timeoutMs: { fallback: 8000, min: 250, max: 30000 },
})

/**
 * Collapse a path into one canonical form: forward slashes become backslashes on
 * Windows-style input, `.`/`..` are resolved, trailing separators dropped, and a bare
 * drive root keeps its trailing separator.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizePath(input) {
  const raw = String(input === null || input === undefined ? '' : input).trim()
  if (raw === '') return ''

  const windowsStyle = /^[A-Za-z]:/.test(raw) || raw.includes('\\')

  if (windowsStyle) {
    let path = raw.replace(/\//g, '\\')
    if (path.startsWith('\\\\?\\')) path = path.slice(4)
    const unc = path.startsWith('\\\\')
    const parts = []
    for (const segment of path.split('\\')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        parts.pop()
        continue
      }
      parts.push(segment)
    }
    let joined = parts.join('\\')
    if (unc) joined = '\\\\' + joined
    if (/^[A-Za-z]:$/.test(joined)) joined += '\\'
    return joined
  }

  const parts = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const joined = '/' + parts.join('/')
  return joined === '/' ? '/' : joined
}

function fnv1a(text, seed) {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Stable id for a workspace: a case-insensitive hash of the normalized path, so the path
 * never travels inside the id.
 *
 * @param {string} normalized
 * @returns {string} 16 lowercase hex characters
 */
export function hashId(normalized) {
  const key = String(normalized).toLowerCase()
  const first = fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0')
  const second = fnv1a(key, 0x9dc5811c).toString(16).padStart(8, '0')
  return first + second
}

/**
 * Refuse roots that are obviously too broad to mean "my projects".
 *
 * @param {string} normalized
 * @returns {string | null} reason, or null when the root is acceptable
 */
export function tooBroadReason(normalized) {
  if (!normalized) return '路径为空'
  if (/^[A-Za-z]:\\$/.test(normalized)) return '不能选择盘符根目录'
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) return '不能选择网络共享根目录'
  if (normalized === '/') return '不能选择文件系统根目录'

  const lower = normalized.toLowerCase()
  const forbidden = [
    /^[a-z]:\\windows$/,
    /^[a-z]:\\windows\\(system32|syswow64|winsxs|assembly)$/,
    /^[a-z]:\\program files( \(x86\))?$/,
    /^[a-z]:\\programdata$/,
    /^[a-z]:\\users$/,
    /^\/usr$/,
    /^\/etc$/,
  ]
  for (const pattern of forbidden) {
    if (pattern.test(lower)) return '这个目录过宽，请选择更具体的根目录'
  }
  return null
}

/** True when the path is fully qualified (drive-letter, UNC, or POSIX absolute). */
export function isFullyQualified(normalized) {
  if (!normalized) return false
  if (/^[A-Za-z]:\\/.test(normalized)) return true
  if (/^\\\\[^\\]+\\[^\\]+/.test(normalized)) return true
  return normalized.startsWith('/')
}

export function isIgnoredName(name, ignoreNames) {
  if (typeof name !== 'string' || name === '') return false
  const needle = name.toLowerCase()
  for (const entry of ignoreNames) {
    if (needle === String(entry).toLowerCase()) return true
  }
  return false
}

/** True when `child` is inside `root` (or equal to it) after normalization. */
export function inScope(child, root) {
  const inner = normalizePath(child).toLowerCase()
  const outer = normalizePath(root).toLowerCase()
  if (!inner || !outer) return false
  if (inner === outer) return true
  const separator = outer.includes('\\') || outer.endsWith(':') ? '\\' : '/'
  const prefix = outer.endsWith(separator) ? outer : outer + separator
  return inner.startsWith(prefix)
}

export function basename(normalized) {
  if (!normalized) return ''
  const trimmed = normalized.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export function clampInt(value, limits) {
  const number = Number(value)
  if (!Number.isFinite(number)) return limits.fallback
  const integer = Math.trunc(number)
  if (integer < limits.min) return limits.min
  if (integer > limits.max) return limits.max
  return integer
}
