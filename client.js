/**
 * Client half of the brain-workspaces bundle.
 *
 * The browser module loader only supports self-contained bundles (no relative
 * `require` between a package's own client artifacts), so this file carries the whole
 * client side. It is still layered internally, and every layer is exported through
 * `factory(...).__testables` so Node tests exercise the exact shipped implementation:
 *
 *   [contracts] constants and DTO-shaped helpers
 *   [guards]    path normalization, stable ids, ignore/hidden policy, boundary checks
 *   [layout]    deterministic slot layout inside the brain outline
 *   [source]    read-only scanner over the Host's directory Remote
 *   [store]     localStorage snapshot + slot-assignment persistence
 *   [view]      the panel page and the sidebar icon
 *
 * Boundaries this file must never cross: no file reads, no writes, no network, and
 * never rendering the selected path anywhere but the local panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-hncsd',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PARTICIPANT_ID = 'brain-workspaces'
    const SIDEBAR_ORDER = 25

    // ---------------------------------------------------------------- [contracts]

    const SCHEMA_VERSION = 1

    const DEFAULT_IGNORE_NAMES = Object.freeze([
      '.git',
      'node_modules',
      'dist',
      'build',
      '.cache',
      '.venv',
      'vendor',
    ])

    // Scan budgets (depth, directory cap, timeout, ignore list, hidden policy) belong to the
    // Host row's `config`: the panel deliberately sends only the root path, so editing
    // `cordis.patch.yml` actually changes what a scan does.

    // ------------------------------------------------------------------- [guards]

    /**
     * Collapse a path into one canonical form: forward slashes become backslashes on
     * Windows-style input, `.`/`..` are resolved, trailing separators dropped, and a
     * bare drive root keeps its trailing separator.
     *
     * @param {unknown} input
     * @returns {string}
     */
    function normalizePath(input) {
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
     * Stable id for a workspace: a case-insensitive hash of the normalized path, so the
     * path itself never leaves this panel and case-only renames keep their point.
     *
     * @param {string} normalized
     * @returns {string} 16 lowercase hex characters
     */
    function hashId(normalized) {
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
    function tooBroadReason(normalized) {
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

    function isIgnoredName(name, ignoreNames) {
      if (typeof name !== 'string' || name === '') return false
      const needle = name.toLowerCase()
      for (const entry of ignoreNames) {
        if (needle === String(entry).toLowerCase()) return true
      }
      return false
    }

    /** True when `child` is inside `root` (or equal to it) after normalization. */
    function inScope(child, root) {
      const inner = normalizePath(child).toLowerCase()
      const outer = normalizePath(root).toLowerCase()
      if (!inner || !outer) return false
      if (inner === outer) return true
      const separator = outer.includes('\\') || outer.endsWith(':') ? '\\' : '/'
      const prefix = outer.endsWith(separator) ? outer : outer + separator
      return inner.startsWith(prefix)
    }

    function basename(normalized) {
      if (!normalized) return ''
      const trimmed = normalized.replace(/[\\/]+$/, '')
      const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
      return index === -1 ? trimmed : trimmed.slice(index + 1)
    }

    function isAbortError(error) {
      if (!error) return false
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return true
      const message = String(error.message || '').toLowerCase()
      return message.includes('abort') || message.includes('cancel')
    }

    /**
     * Resolve the Host directory service.
     *
     * `uiWorkspace` is declared as an optional dependency by the Client composition
     * (`ctx.get("uiWorkspace")`), so reading `ctx.uiWorkspace` only works when the name
     * is listed in this module's `inject`. Both paths are tried here, and a caller that
     * gets `undefined` must surface an error instead of doing nothing.
     */
    function resolveUiWorkspace(ctx) {
      if (!ctx) return undefined
      try {
        if (ctx.uiWorkspace) return ctx.uiWorkspace
      } catch {
        /* the getter throws when the dependency was not declared */
      }
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get('uiWorkspace')
          if (service) return service
        }
      } catch {
        /* fall through */
      }
      return undefined
    }

    function describeError(error) {
      if (!error) return '未知错误'
      const message = typeof error.message === 'string' ? error.message : String(error)
      const code = error.code || (error.name && error.name !== 'Error' ? error.name : '')
      if (!code) return message
      return message.includes(String(code)) ? message : code + ': ' + message
    }

    // ------------------------------------------------------------------- [layout]

    /**
     * Stylized side-view brain. The polygon is the single source of truth: the SVG
     * outline is drawn from it and containment tests run against it, so a point can
     * never be painted outside the shape the user sees.
     */
    /**
     * Whole brain, seen from the front: one smooth blob with a dimple at the top and bottom
     * midline, which is what reads as the interhemispheric fissure.
     *
     * Parametric on purpose: a union of two ellipse arcs produced a flat-topped shape, so the
     * radius is modulated by two narrow gaussian notches instead. The result is always a
     * simple closed polygon, which the containment test relies on.
     */
    function wholeBrainOutline() {
      const cx = 500
      const cy = 402
      const rx = 285
      const ry = 250
      const steps = 72
      const points = []

      for (let index = 0; index < steps; index += 1) {
        const angle = (index / steps) * Math.PI * 2
        const sin = Math.sin(angle)
        const cos = Math.cos(angle)
        // dimple only where cos ≈ 0, i.e. at the top and bottom midline
        const notch = 0.17 * Math.exp(-Math.pow(cos / 0.3, 2))
        const scale = 1 - notch
        points.push([
          Math.round(cx + cos * rx * scale),
          Math.round(cy + sin * ry * scale),
        ])
      }
      return points
    }

    const BRAIN_SHAPE = Object.freeze({
      id: 'brain-whole-v1',
      width: 1000,
      height: 800,
      cellSize: 64,
      levels: Object.freeze([1, 3, 5, 7, 9]),
      outline: Object.freeze(wholeBrainOutline()),
      /** Lobe centres in normalized world space, used to inflate each hemisphere. */
      lobes: Object.freeze([
        { x: -0.26, y: 0, rx: 0.36, ry: 0.62 },
        { x: 0.26, y: 0, rx: 0.36, ry: 0.62 },
      ]),
    })

    const REGION_ORDER = Object.freeze(['left', 'right'])

    const REGION_LABEL_KEYS = Object.freeze({
      left: 'regionLeft',
      right: 'regionRight',
    })

    function pointInPolygon(x, y, polygon) {
      let inside = false
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const xi = polygon[i][0]
        const yi = polygon[i][1]
        const xj = polygon[j][0]
        const yj = polygon[j][1]
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
        if (intersects) inside = !inside
      }
      return inside
    }

    function insideWithMargin(x, y, polygon, margin) {
      if (!pointInPolygon(x, y, polygon)) return false
      return (
        pointInPolygon(x - margin, y, polygon) &&
        pointInPolygon(x + margin, y, polygon) &&
        pointInPolygon(x, y - margin, polygon) &&
        pointInPolygon(x, y + margin, polygon)
      )
    }

    function centroidOf(polygon) {
      let sx = 0
      let sy = 0
      for (const point of polygon) {
        sx += point[0]
        sy += point[1]
      }
      return [sx / polygon.length, sy / polygon.length]
    }

    /** Visual lobe partition used only to order slots and to label a region. */
    /** Hemisphere a point belongs to. A front view has exactly two regions. */
    function regionOf(x, y, polygon) {
      const center = centroidOf(polygon)
      return x < center[0] ? 'left' : 'right'
    }

    const round = (value) => Math.round(value * 100) / 100

    /** Smooth closed path through the outline polygon (Catmull-Rom to cubic Bezier). */
    function outlinePath(polygon, tension = 1) {
      const n = polygon.length
      let path = 'M ' + round(polygon[0][0]) + ' ' + round(polygon[0][1])
      for (let i = 0; i < n; i += 1) {
        const p0 = polygon[(i - 1 + n) % n]
        const p1 = polygon[i]
        const p2 = polygon[(i + 1) % n]
        const p3 = polygon[(i + 2) % n]
        const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension
        const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension
        const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension
        const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension
        path +=
          ' C ' + round(c1x) + ' ' + round(c1y) +
          ', ' + round(c2x) + ' ' + round(c2y) +
          ', ' + round(p2[0]) + ' ' + round(p2[1])
      }
      return path + ' Z'
    }

    const slotCache = new Map()

    /**
     * Ordered slot list. Level 1 fills the brain sparsely; later levels subdivide the
     * same cells, so growing from 5 to 500 workspaces only ever appends candidates and
     * never moves an already-assigned point.
     */
    function buildSlots(shape) {
      const cacheKey = shape.id + ':' + shape.cellSize + ':' + shape.levels.join(',')
      const cached = slotCache.get(cacheKey)
      if (cached) return cached

      const polygon = shape.outline
      const slots = []
      // Coarser levels sit on their own lattice, and different lattices interleave: a
      // 64/3 point and a 64/5 point can end up ~4px apart even though neither duplicates
      // the other. So every accepted slot must clear a minimum separation from all
      // previously accepted slots, which is what keeps dense levels readable.
      const accepted = []
      for (const level of shape.levels) {
        const spacing = shape.cellSize / level
        const margin = Math.max(2.5, spacing * 0.32)
        const minDistance = spacing * 0.75
        const bucketSize = minDistance
        const buckets = new Map()
        const bucketKey = (x, y) => Math.floor(x / bucketSize) + ':' + Math.floor(y / bucketSize)
        const remember = (x, y) => {
          const key = bucketKey(x, y)
          const list = buckets.get(key)
          if (list) list.push({ x, y })
          else buckets.set(key, [{ x, y }])
        }
        const tooClose = (x, y) => {
          const bx = Math.floor(x / bucketSize)
          const by = Math.floor(y / bucketSize)
          for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
              const list = buckets.get(bx + dx + ':' + (by + dy))
              if (!list) continue
              for (const point of list) {
                if (Math.hypot(point.x - x, point.y - y) < minDistance) return true
              }
            }
          }
          return false
        }
        for (const point of accepted) remember(point.x, point.y)
        const cols = Math.ceil(shape.width / spacing)
        const rows = Math.ceil(shape.height / spacing)
        const levelSlots = []
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const x = (col + 0.5) * spacing
            const y = (row + 0.5) * spacing
            if (x < 1 || y < 1 || x > shape.width - 1 || y > shape.height - 1) continue
            if (!insideWithMargin(x, y, polygon, margin)) continue
            if (tooClose(x, y)) continue
            remember(x, y)
            accepted.push({ x: round(x), y: round(y) })
            levelSlots.push({
              x: round(x),
              y: round(y),
              level,
              spacing,
              region: regionOf(x, y, polygon),
              rank: REGION_ORDER.indexOf(regionOf(x, y, polygon)),
            })
          }
        }
        levelSlots.sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank
          if (a.y !== b.y) return a.y - b.y
          return a.x - b.x
        })
        for (const slot of levelSlots) slots.push(slot)
      }

      slotCache.set(cacheKey, slots)
      return slots
    }

    function compareNodes(a, b) {
      const an = String(a.name || '').toLowerCase()
      const bn = String(b.name || '').toLowerCase()
      if (an < bn) return -1
      if (an > bn) return 1
      const ap = String(a.path || '').toLowerCase()
      const bp = String(b.path || '').toLowerCase()
      if (ap < bp) return -1
      if (ap > bp) return 1
      return 0
    }

    /**
     * `layout(nodes, brainShape, options) -> { positions, assignments }`
     *
     * Deterministic: the only inputs are the node set, the shape, and the persisted
     * assignment map. Nodes keep their slot across scans; new nodes take the lowest
     * free slot, so deletion leaves a hole that the next addition refills first.
     */
    function layout(nodes, shape = BRAIN_SHAPE, options = {}) {
      const slots = buildSlots(shape)
      const ordered = (Array.isArray(nodes) ? nodes.slice() : []).sort(compareNodes)
      const previous = options.assignments && typeof options.assignments === 'object' ? options.assignments : {}

      const used = new Set()
      const assignments = {}
      const placed = []
      const fresh = []

      for (const node of ordered) {
        const candidate = previous[node.id]
        if (Number.isInteger(candidate) && candidate >= 0 && candidate < slots.length && !used.has(candidate)) {
          used.add(candidate)
          assignments[node.id] = candidate
          placed.push({ node, slot: slots[candidate] })
        } else {
          fresh.push(node)
        }
      }

      let cursor = 0
      for (const node of fresh) {
        while (cursor < slots.length && used.has(cursor)) cursor += 1
        const index = cursor < slots.length ? cursor : slots.length - 1
        used.add(index)
        assignments[node.id] = index
        placed.push({ node, slot: slots[index] })
      }

      const positions = placed.map(({ node, slot }) => ({
        id: node.id,
        name: node.name,
        x: slot.x,
        y: slot.y,
        radius: Math.max(2.2, Math.min(6.5, slot.spacing * 0.26)),
        region: slot.region,
        slot: assignments[node.id],
      }))
      positions.sort((a, b) => a.slot - b.slot)

      return { positions, assignments }
    }

    // ------------------------------------------------------------------- [galaxy]

    /**
     * Round five: "personal workspace galaxy".
     *
     * C1 mapping — the slot table and `layout()` keep full ownership of *which* slot a workspace
     * gets (that is what `assignments` persists); only the slot → world position mapping changes.
     * So switching skins never re-assigns anything, and switching back restores the brain
     * position bit for bit.
     *
     * The azimuth MUST come from the persisted slot index, never from the array index of
     * `positions`: `positions` is sorted by slot, so deleting one workspace shifts every later
     * array index (measured: 3 of 5 survivors moved, worst 84 px, before this was fixed) and the
     * whole galaxy would jump.
     */
    const GALAXY = Object.freeze({
      /** Disc radius in normalised world units (default view ≈ 388 px wide). */
      radius: 1.25,
      /**
       * Radial compression: keeps the core from collapsing into one point.
       *
       * Round five P2: 0.62 → 0.85. Measured at 900x640 (33 / 80 / 200 workspaces): the nearest
       * neighbour stays 14.4→14.1 / 5.8→5.3 / 2.2→2.1 px, while the share of workspaces in the
       * inner third goes 6 %→15 % and the outer third 58 %→45 %. Anything above ~1.1 buys centre
       * density by halving click spacing, so 0.85 is the last cheap step.
       *
       * Still a single tunable number: pass `{...GALAXY, exponent: 0.62}` to `galaxyPoint` to get
       * the previous mapping back bit for bit (there is a test for it).
       */
      exponent: 0.85,
      /** Disc plane tilt about x. Negative, i.e. the same sense as the default camera pitch. */
      tilt: -0.62,
      /** Disc half-thickness (z), which is what produces the near/far size difference. */
      thickness: 0.06,
      /** Spiral arm strength; 0 = pure golden-angle disc. */
      arc: 0,
      /** Golden angle. */
      golden: 2.399963229728653,
      /** Design-space radius the slot table lives in (0.6 ≈ the outline's half extent). */
      designRadius: 0.6,
    })

    /**
     * Slot → galaxy position. Pure: depends only on the slot's own design-space point and the
     * persisted slot index, so adding or removing any *other* workspace cannot move this one.
     *
     * @param {number} slotX design-space x (0..1000)
     * @param {number} slotY design-space y (0..800)
     * @param {number} slotIndex persisted slot index (`positions[].slot`, i.e. `assignments[id]`)
     * @param {object} [options] overrides for GALAXY
     * @returns {{x: number, y: number, z: number} | null} null when the index is not a real slot
     */
    function galaxyPoint(slotX, slotY, slotIndex, options) {
      // Guard the contract instead of silently falling back to an array index.
      if (!Number.isInteger(slotIndex) || slotIndex < 0) return null
      const tuning = options || GALAXY
      const radius = Number(tuning.radius) || GALAXY.radius
      const exponent = Number.isFinite(tuning.exponent) ? tuning.exponent : GALAXY.exponent
      const tilt = Number.isFinite(tuning.tilt) ? tuning.tilt : GALAXY.tilt
      const thickness = Number.isFinite(tuning.thickness) ? tuning.thickness : GALAXY.thickness
      const arc = Number(tuning.arc) || 0

      const dx = (Number(slotX) - 500) / 500
      const dy = (Number(slotY) - 400) / 400
      const rl = Math.min(1, Math.hypot(dx, dy) / (tuning.designRadius || GALAXY.designRadius))
      const r = radius * Math.pow(Math.max(0, rl), exponent)
      const theta = slotIndex * (tuning.golden || GALAXY.golden) + 0.6 + arc * Math.sin(r * 5.2 + 0.7)

      const a = r * Math.cos(theta)
      const b = r * Math.sin(theta)
      const c = Math.sin(theta * 2 + 1.1) * thickness * (0.35 + 0.65 * Math.exp(-r * 2.4))
      const cosTilt = Math.cos(tilt)
      const sinTilt = Math.sin(tilt)
      return {
        x: a,
        y: b * cosTilt - c * sinTilt,
        z: b * sinTilt + c * cosTilt,
      }
    }

    // -------------------------------------------------------------------- [artwork]

    /**
     * The brain canvas is artwork: it paints its own dark scene instead of inheriting the
     * host surface, so its colors are literal by design (the theme tokens still rule every
     * surrounding control). Two hemispheres are dyed gold and violet purely for looks —
     * that color carries no data meaning, which is why workspace beads stay uniform white.
     */
    const ART = Object.freeze({
      backdropInner: '#0d1526',
      backdropMid: '#080c17',
      backdropEdge: '#04060c',
      goldDeep: '#7a4d10',
      goldMid: '#f0a63c',
      goldCore: '#ffe6bd',
      violetDeep: '#3a2470',
      violetMid: '#8b5cf6',
      violetCore: '#dfd0ff',
      rim: 'rgba(190,214,255,0.42)',
      fissure: 'rgba(200,220,255,0.13)',
    })

    /**
     * Directory-count ramp: violet = few, gold = many (9 discrete steps so the same bead
     * color is reused by a bounded number of gradients instead of one gradient per node).
     *
     * Color now carries the count, which is why scan status moved to a shape channel
     * (dashed / hollow ring) — two meanings may not share one channel.
     */
    const BEAD_RAMP = Object.freeze([
      '#7c5cff',
      '#8a6bf4',
      '#987ae8',
      '#a689da',
      '#b698c8',
      '#c4a5b4',
      '#d2a99c',
      '#e2a87c',
      '#f0a63c',
    ])

    function mixHex(from, to, amount) {
      const parse = (hex) => {
        const value = hex.replace('#', '')
        return [
          parseInt(value.slice(0, 2), 16),
          parseInt(value.slice(2, 4), 16),
          parseInt(value.slice(4, 6), 16),
        ]
      }
      const a = parse(from)
      const b = parse(to)
      const channel = (index) => {
        const mixed = Math.round(a[index] + (b[index] - a[index]) * amount)
        return Math.max(0, Math.min(255, mixed)).toString(16).padStart(2, '0')
      }
      return '#' + channel(0) + channel(1) + channel(2)
    }

    /**
     * Map a directory count onto the ramp. Log scale, so one huge workspace cannot flatten
     * every other bead into the violet end.
     */
    function beadStep(count, maxCount) {
      const top = Math.max(0, Number(maxCount) || 0)
      const value = Math.max(0, Number(count) || 0)
      if (top <= 0 || value <= 0) return 0
      const normalized = Math.min(1, Math.log1p(value) / Math.log1p(top))
      return Math.round(normalized * (BEAD_RAMP.length - 1))
    }

    function beadColors(count, maxCount, ramp) {
      const palette = Array.isArray(ramp) && ramp.length > 1 ? ramp : BEAD_RAMP
      const step = beadStep(count, maxCount)
      return {
        step,
        color: palette[step],
      }
    }

    /**
     * Artwork skins. A theme only repaints the nebula (backdrop, filaments, rim) and the
     * ends of the data ramp; it never changes what color *means* — bead colour stays
     * "directory count", bead size stays "session count".
     */
    const THEMES = Object.freeze([
      Object.freeze({
        id: 'nebula',
        backdropInner: ART.backdropInner,
        backdropMid: ART.backdropMid,
        backdropEdge: ART.backdropEdge,
        meshLeft: ART.goldMid,
        meshRight: ART.violetMid,
        synapseLeft: ART.goldCore,
        synapseRight: ART.violetCore,
        core: ART.violetMid,
        rim: ART.rim,
        rimColor: '#cdd9ff',
        fissure: ART.fissure,
        rampLow: BEAD_RAMP[0],
        rampHigh: BEAD_RAMP[BEAD_RAMP.length - 1],
      }),
      Object.freeze({
        id: 'aurora',
        backdropInner: '#07171c',
        backdropMid: '#04101a',
        backdropEdge: '#02070c',
        rimColor: '#a8f0ff',
        meshLeft: '#34d5c0',
        meshRight: '#3f8cff',
        synapseLeft: '#c9fff4',
        synapseRight: '#cfe0ff',
        core: '#34d5c0',
        rim: 'rgba(170,240,255,0.42)',
        fissure: 'rgba(200,255,250,0.13)',
        rampLow: '#2b6cff',
        rampHigh: '#34d5c0',
      }),
      Object.freeze({
        id: 'magma',
        backdropInner: '#1b0b09',
        backdropMid: '#120705',
        backdropEdge: '#080302',
        rimColor: '#ffc2a8',
        meshLeft: '#ff7a3d',
        meshRight: '#ff3d6e',
        synapseLeft: '#ffe0c2',
        synapseRight: '#ffd0dc',
        core: '#ff5a3d',
        rim: 'rgba(255,180,150,0.4)',
        fissure: 'rgba(255,210,190,0.12)',
        rampLow: '#8b3dff',
        rampHigh: '#ff7a3d',
      }),
      Object.freeze({
        id: 'mono',
        backdropInner: '#0b1016',
        backdropMid: '#070b11',
        backdropEdge: '#04070b',
        rimColor: '#dfe8f5',
        meshLeft: '#b9c6d8',
        meshRight: '#7d8ea6',
        synapseLeft: '#f2f7ff',
        synapseRight: '#dfe8f5',
        core: '#9fb3ca',
        rim: 'rgba(210,225,245,0.38)',
        fissure: 'rgba(220,235,255,0.1)',
        rampLow: '#5f7691',
        rampHigh: '#e8f1ff',
      }),
    ])

    function themeById(id) {
      for (const theme of THEMES) {
        if (theme.id === id) return theme
      }
      return THEMES[0]
    }

    const rampCache = new Map()

    /**
     * Nine ramp steps for a theme, optionally overridden by a custom accent colour. The
     * default nebula ramp is kept verbatim so the shipped palette stays curated.
     */
    function rampFor(theme, accent) {
      const base = theme || THEMES[0]
      const high = typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : ''
      if (!high && base.id === 'nebula') return BEAD_RAMP

      const cacheKey = base.id + '|' + high
      const cached = rampCache.get(cacheKey)
      if (cached) return cached

      const top = high || base.rampHigh
      const ramp = []
      for (let index = 0; index < 9; index += 1) {
        ramp.push(mixHex(base.rampLow, top, Math.pow(index / 8, 0.9)))
      }
      rampCache.set(cacheKey, ramp)
      return ramp
    }

    /**
     * Level of detail: labels appear when the camera is close, when there are only a few
     * beads, or for the bead under the pointer / keyboard focus.
     */
    function shouldShowLabel(bead, context) {
      if (!bead) return false
      if (bead.selected || bead.hovered || bead.focused) return true
      const count = Number(context && context.beadCount) || 0
      const zoom = Number(context && context.zoom) || 1
      if (count > 0 && count <= 14) return true
      return zoom >= 1.55
    }

    /**
     * Bead size carries the session count (color already carries the directory count).
     * Log scale again, and a neutral 1× when no profile data exists so a brain without
     * session information does not suddenly shrink.
     */
    function beadScale(sessionCount, maxSessions) {
      const top = Math.max(0, Number(maxSessions) || 0)
      if (top <= 0) return 1
      const value = Math.max(0, Number(sessionCount) || 0)
      if (value <= 0) return 0.68
      return 0.68 + 0.92 * Math.min(1, Math.log1p(value) / Math.log1p(top))
    }

    /**
     * P5.1 — session satellites: a workspace's *history* as a bounded set of small glyphs.
     *
     * The only data that exists is a single number (`sessionCount`, plus the newest session time),
     * so a satellite is an AGGREGATE, not one session: no id, no title, no timestamp, nothing
     * clickable, nothing to open. The count decides how many glyphs exist (hard cap 6) and how
     * wide the local orbit is; the layout is a pure function of the stable workspace id, so it
     * never reshuffles across renders, camera moves, scans or reloads.
     */
    const SATELLITE_STYLE = Object.freeze({
      max: 6,
      /** Glyph radius in CSS px (a diameter of ~3.2–5.6), scaled with the star it orbits. */
      size: [1.6, 2.8],
      /** Glyph radius as a fraction of its star's radius, so a big star gets bigger satellites. */
      sizeOfStar: 0.34,
      alpha: [0.32, 0.58],
      /** Orbit, in bead radii: base + per glyph + a capped log term for very large counts. */
      orbitBase: 1.5,
      orbitPerGlyph: 0.22,
      orbitSpread: 0.9,
      orbitCeiling: 4,
      /** Flattened orbit: it reads as the tilted disc, not as a ring around the star. */
      squash: 0.55,
      /** Golden angle, so glyph i keeps its direction whatever the total count is. */
      golden: 2.399963229728653,
    })

    /** Glyph budget of one workspace: 0, then 1…6 with a hard cap (spec §3.1). */
    function satelliteCount(sessionCount) {
      const count = Math.floor(Number(sessionCount) || 0)
      if (count <= 0) return 0
      if (count <= 2) return 1
      if (count <= 5) return 2
      if (count <= 10) return 3
      if (count <= 20) return 4
      if (count <= 50) return 5
      return SATELLITE_STYLE.max
    }

    /** Orbit radius in CSS px for one workspace (0 when it has no sessions). */
    function satelliteOrbit(beadRadius, sessionCount) {
      const count = Math.floor(Number(sessionCount) || 0)
      if (count <= 0) return 0
      const radius = Math.max(2, Number(beadRadius) || 2)
      const glyphs = satelliteCount(count)
      const spread = Math.min(
        SATELLITE_STYLE.orbitSpread,
        (SATELLITE_STYLE.orbitSpread * Math.log1p(count)) / Math.log1p(300),
      )
      const factor = Math.min(
        SATELLITE_STYLE.orbitCeiling,
        SATELLITE_STYLE.orbitBase + SATELLITE_STYLE.orbitPerGlyph * glyphs + spread,
      )
      return radius * factor
    }

    /**
     * The deterministic glyph list of one workspace.
     *
     * @param {string} workspaceId stable id — its hash seeds the phase, never the clock or order
     * @param {number} sessionCount aggregate session count (missing / illegal ⇒ 0 ⇒ no glyphs)
     * @param {{ x?: number, y?: number, radius?: number, color?: string }} [position]
     */
    function workspaceSatellites(workspaceId, sessionCount, position) {
      const at = position || {}
      const count = Math.floor(Number(sessionCount) || 0)
      const glyphs = satelliteCount(count)
      if (glyphs === 0) return []
      const cx = Number(at.x) || 0
      const cy = Number(at.y) || 0
      const radius = Math.max(2, Number(at.radius) || 2)
      const orbit = satelliteOrbit(radius, count)
      const seed = parseInt(hashId(String(workspaceId)).slice(0, 8), 16) || 0
      const random = mulberry32(seed + 0x51f3)
      const base = ((seed % 997) / 997) * Math.PI * 2
      const color = typeof at.color === 'string' ? at.color : '#cfe0ff'
      // Glyph radius follows the star's radius (a big star reads as a bigger system), clamped to
      // the style range so a satellite can never grow to the star's own size.
      const baseSize = Math.min(
        SATELLITE_STYLE.size[1],
        Math.max(SATELLITE_STYLE.size[0], radius * SATELLITE_STYLE.sizeOfStar),
      )
      const out = []
      for (let index = 0; index < glyphs; index += 1) {
        // Index-only geometry: a larger count adds glyphs, it never rotates the existing ones.
        const angle = base + index * SATELLITE_STYLE.golden
        // Jitter goes inward only, so every glyph stays inside the nominal orbit (and the orbit
        // ceiling stays a real ceiling).
        const reach = orbit * (0.86 + random() * 0.14)
        const size = baseSize * (0.82 + random() * 0.18)
        const alpha = SATELLITE_STYLE.alpha[0] + random() * (SATELLITE_STYLE.alpha[1] - SATELLITE_STYLE.alpha[0])
        out.push({
          workspaceId: String(workspaceId),
          index,
          angle,
          orbitRadius: reach,
          x: cx + Math.cos(angle) * reach,
          y: cy + Math.sin(angle) * reach * SATELLITE_STYLE.squash,
          radius: size,
          alpha,
          color,
        })
      }
      return out
    }

    /**
     * P5.4 — orbital tracks: every star shows a short arc of its own orbit around the disc centre.
     *
     * The disc is a rotating ellipse, so a star's track is the ellipse concentric with the disc that
     * passes through its own (u, v) position; the arc runs along the rotation direction from the
     * star. Only a short span is drawn — one full ellipse per star would double the stage rings and
     * turn the sky into a chart. It is a dotted track (the same glyph as the wake grains), so it
     * stays visible on a HiDPI screen where a one-device-pixel line would not.
     */
    const ORBIT_STYLE = Object.freeze({
      /** Angular span of the visible arc, in radians (~115°). */
      span: 2,
      /** Dots along the arc (odd, so one dot sits exactly on the star). */
      dots: 27,
      /** Dot radius at the star and at the arc ends, CSS px. */
      radius: [1.8, 0.6],
      /** Alpha at the star and at the arc ends. */
      alpha: [0.55, 0.06],
    })

    /**
     * Orbital tracks for every drawn star, in screen pixels.
     *
     * @param {Array} beads drawn representatives — a cluster marker has no orbit of its own
     * @param {{ extent: { cx: number, cy: number, halfWidth: number, halfHeight: number } }} options
     */
    function starOrbits(beads, options) {
      const list = Array.isArray(beads) ? beads : []
      const extent = options && options.extent
      if (!extent) return []
      const cx = Number(extent.cx) || 0
      const cy = Number(extent.cy) || 0
      const halfWidth = Number(extent.halfWidth) || 0
      const halfHeight = Number(extent.halfHeight) || 0
      if (!(halfWidth > 0) || !(halfHeight > 0)) return []
      const out = []
      for (const bead of list) {
        if (!bead || bead.cluster || typeof bead.id !== 'string') continue
        const u = (bead.x - cx) / halfWidth
        const v = (bead.y - cy) / halfHeight
        const reach = Math.hypot(u, v)
        // A star sitting on the disc centre has no orbital radius to trace.
        if (!(reach > 0.02)) continue
        const baseAngle = Math.atan2(v, u)
        const particles = []
        for (let index = 0; index < ORBIT_STYLE.dots; index += 1) {
          const along = index / Math.max(1, ORBIT_STYLE.dots - 1)
          // 0 at the star, 1 at either end of the arc
          const edge = Math.abs(along - 0.5) * 2
          const fade = 1 - edge
          const angle = baseAngle + (along - 0.5) * ORBIT_STYLE.span
          particles.push({
            x: cx + Math.cos(angle) * reach * halfWidth,
            y: cy + Math.sin(angle) * reach * halfHeight,
            radius: ORBIT_STYLE.radius[1] + (ORBIT_STYLE.radius[0] - ORBIT_STYLE.radius[1]) * fade,
            alpha: ORBIT_STYLE.alpha[1] + (ORBIT_STYLE.alpha[0] - ORBIT_STYLE.alpha[1]) * fade,
          })
        }
        out.push({
          workspaceId: bead.id,
          color: typeof bead.color === 'string' ? bead.color : '#cfe0ff',
          /** Radial position in disc units (1 = disc half extent). */
          reach,
          particles,
        })
      }
      return out
    }

    /**
     * P5.3 — star wakes: every workspace star drags a short wake behind it, and the wake LENGTH
     * carries the session count.
     *
     * This is a second expression of the same number the satellites already show (a redundant,
     * artistic echo — never a new meaning on a shared channel). The wake is tangential: it points
     * against the disc's rotation (perpendicular to the star's radius, bending slightly inward), so
     * a field of wakes reads as one rotating disc.
     *
     * A wake is a STREAM OF PARTICLES, not a ribbon: small grains that shrink and fade along the
     * path stage and scatter sideways as they fall behind, which is what a spent wake looks like.
     * It is static by design — no orbit animation — and both renderers draw it under the satellites
     * and the stars.
     */
    const TRAIL_STYLE = Object.freeze({
      /** Shortest visible wake, its span and the hard cap, in CSS px. */
      min: 13,
      span: 30,
      max: 43,
      /** sessionCount that fills the range (same log family as the satellite orbit). */
      spanCount: 300,
      /** Inward bend as a fraction of the wake length. */
      curve: 0.22,
      /** Where the wake starts, in star radii, so it never covers the star core or its glow. */
      startOffset: 1.9,
      /** Base alpha range at the root. */
      alpha: [0.35, 0.7],
      /** Particle radius at the root and at the tip, in CSS px. */
      particle: [1.9, 0.55],
      /** Particles per wake: a short wake gets fewer, a long one more (hard bounds). */
      particles: [8, 18],
      /** Sideways scatter at the root and at the tip, in CSS px: the stream widens as it fades. */
      scatter: [0.5, 2.4],
    })

    /** Wake length in CSS px for a session count: 0 when there is nothing to show. */
    function trailLength(sessionCount) {
      const count = Math.floor(Number(sessionCount) || 0)
      if (count <= 0) return 0
      const t = Math.min(1, Math.log1p(count) / Math.log1p(TRAIL_STYLE.spanCount))
      return Math.min(TRAIL_STYLE.max, TRAIL_STYLE.min + TRAIL_STYLE.span * t)
    }

    /** How many grains one wake of this length carries. */
    function trailParticleCount(length) {
      const t = Math.min(1, Math.max(0, (Number(length) - TRAIL_STYLE.min) / TRAIL_STYLE.span))
      const span = TRAIL_STYLE.particles[1] - TRAIL_STYLE.particles[0]
      return Math.max(4, Math.min(TRAIL_STYLE.particles[1], Math.round(TRAIL_STYLE.particles[0] + span * t)))
    }

    /**
     * Wake geometry for every drawn star, in screen pixels.
     *
     * @param {Array} beads drawn representatives — a cluster marker is not a star, so it gets none
     * @param {{ extent: { cx: number, cy: number } }} options disc centre the rotation is measured from
     */
    function starTrails(beads, options) {
      const list = Array.isArray(beads) ? beads : []
      const extent = options && options.extent
      if (!extent) return []
      const discX = Number(extent.cx) || 0
      const discY = Number(extent.cy) || 0
      const out = []
      for (const bead of list) {
        if (!bead || bead.cluster || typeof bead.id !== 'string') continue
        const length = trailLength(bead.node ? bead.node.sessionCount : 0)
        if (length <= 0) continue
        const radius = Math.max(2, Number(bead.radius) || 2)
        const awayX = bead.x - discX
        const awayY = bead.y - discY
        const distance = Math.hypot(awayX, awayY)
        // Counter-clockwise rotation: the wake trails the tangential direction. A star sitting on
        // the disc centre has no orbital direction, so it keeps one fixed deterministic one.
        let tangentX = 1
        let tangentY = 0
        let inwardX = 0
        let inwardY = 0
        if (distance > 1e-6) {
          const nx = awayX / distance
          const ny = awayY / distance
          tangentX = -ny
          tangentY = nx
          inwardX = -nx
          inwardY = -ny
        }
        const t = Math.min(1, Math.max(0, (length - TRAIL_STYLE.min) / TRAIL_STYLE.span))
        const alpha = TRAIL_STYLE.alpha[0] + (TRAIL_STYLE.alpha[1] - TRAIL_STYLE.alpha[0]) * t
        const start = radius * TRAIL_STYLE.startOffset
        const count = trailParticleCount(length)
        const random = mulberry32((parseInt(hashId(bead.id).slice(0, 8), 16) || 0) + 0x7a11)
        const particles = []
        for (let index = 0; index < count; index += 1) {
          // Grains start just behind the star and spread to the tip; the last one sits at the cap.
          const along = (index + 0.55) / count
          const travel = start + (length - start) * along
          const bend = length * TRAIL_STYLE.curve * along * along
          const spread = TRAIL_STYLE.scatter[0] + (TRAIL_STYLE.scatter[1] - TRAIL_STYLE.scatter[0]) * along
          const sideways = (random() - 0.5) * 2 * spread
          const jitter = 0.8 + random() * 0.4
          const grain = TRAIL_STYLE.particle[0] + (TRAIL_STYLE.particle[1] - TRAIL_STYLE.particle[0]) * along
          particles.push({
            x: bead.x - tangentX * travel + inwardX * bend + tangentY * sideways,
            y: bead.y - tangentY * travel + inwardY * bend - tangentX * sideways,
            radius: Math.max(0.45, grain * jitter),
            alpha: Math.max(0, alpha * (1 - 0.9 * along) * (0.75 + random() * 0.25)),
          })
        }
        out.push({
          workspaceId: bead.id,
          x: bead.x,
          y: bead.y,
          length,
          alpha,
          color: typeof bead.color === 'string' ? bead.color : '#cfe0ff',
          particles,
        })
      }
      return out
    }

    /**
     * Every visible workspace's glyphs, flattened into the list both renderers consume.
     *
     * A cluster marker is not a star, so it gets no satellites: the glyphs belong to a workspace
     * that is drawn as its own point. A clustered member therefore shows none until the cluster is
     * expanded (zoom / search) — and a group centroid never grows a satellite ring.
     */
    function buildSessionSatellites(beads, options) {
      const list = Array.isArray(beads) ? beads : []
      const settings = options || {}
      const cap = Number.isFinite(settings.maxPerWorkspace) ? settings.maxPerWorkspace : SATELLITE_STYLE.max
      const out = []
      for (const bead of list) {
        if (!bead || bead.cluster || typeof bead.id !== 'string') continue
        const glyphs = workspaceSatellites(bead.id, bead.node ? bead.node.sessionCount : 0, {
          x: bead.x,
          y: bead.y,
          radius: bead.radius,
          color: bead.color,
        })
        for (const glyph of glyphs.slice(0, cap)) out.push(glyph)
      }
      return out
    }

    /**
     * P5.1 — directory names as a text overlay (a renderer never draws text).
     *
     * `shouldShowLabel()` above stays the per-bead predicate the scene stores in `labelVisible`;
     * this is the layer that decides which names actually reach the screen:
     *
     *  - up to `LABEL_ALL_FROM` drawn markers: every name is shown;
     *  - above it: only the markers that have a DOM button (the same virtualization the buttons
     *    use) plus the selected / hovered / focused workspace and every search hit — so a name and
     *    its button never disagree;
     *  - a cluster marker is labelled "N workspaces", never one member's name;
     *  - an avoid pass flips or drops a label that would overlap another label, leave the
     *    viewport, or land on the control strip. Only text moves: bead x/y, slot, radius and the
     *    hit radius are read-only inputs here.
     */
    const LABEL_ALL_FROM = 40
    const LABEL_OFFSET_X = 9
    const LABEL_OFFSET_Y = -9
    const LABEL_HEIGHT = 14
    const LABEL_MARGIN = 4
    /** A long directory name is truncated on screen; the full name stays in the button/详情. */
    const LABEL_MAX_CHARS = 18
    /** Bottom strip kept clear for the zoom / reset / magnifier controls and the notice. */
    const LABEL_RESERVED_BOTTOM = 44

    /** Rough advance width at 11 px: full width for CJK, about half for ASCII. */
    function labelWidth(text) {
      let width = 0
      for (const character of String(text || '')) {
        const code = character.codePointAt(0) || 0
        width += code > 0x2e80 ? 11 : 6
      }
      return width
    }

    /** On-screen form of a name: long ones are cut, the accessible name is never cut. */
    function labelText(value) {
      const text = String(value || '')
      if (text.length <= LABEL_MAX_CHARS) return text
      return text.slice(0, LABEL_MAX_CHARS - 1) + '…'
    }

    /**
     * Inline style of one label. Kept next to the placement rules so there is exactly one source
     * for "where does a name sit and how loud is it" — the panel and the render checks both use it.
     */
    function labelStyle(label) {
      return {
        position: 'absolute',
        left: label.x + 'px',
        top: label.y + 'px',
        height: LABEL_HEIGHT + 'px',
        fontSize: 11,
        lineHeight: LABEL_HEIGHT + 'px',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        color: label.emphasis ? 'rgba(255,255,255,0.94)' : 'rgba(220,232,255,0.66)',
        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
        pointerEvents: 'none',
        userSelect: 'none',
      }
    }

    function workspaceLabels(items, options) {
      const list = Array.isArray(items) ? items : []
      const settings = options || {}
      const width = Number(settings.width) || 0
      const height = Number(settings.height) || 0
      if (width <= 0 || height <= 0 || list.length === 0) return []
      const labelAllFrom = Number.isFinite(settings.labelAllFrom) ? settings.labelAllFrom : LABEL_ALL_FROM
      const dense = list.length > labelAllFrom
      const pinnedIds = new Set()
      for (const id of [settings.selectedId, settings.hoverId, settings.focusId]) {
        if (typeof id === 'string') pinnedIds.add(id)
      }
      const searchActive = settings.searchActive === true
      const mounted = new Set()
      if (settings.mountedIds instanceof Set) {
        for (const id of settings.mountedIds) if (typeof id === 'string') mounted.add(id)
      } else if (Array.isArray(settings.mountedIds)) {
        // accept either ids or the beads themselves, so callers cannot get this wrong
        for (const entry of settings.mountedIds) {
          if (typeof entry === 'string') mounted.add(entry)
          else if (entry && typeof entry.id === 'string') mounted.add(entry.id)
        }
      }
      const formatCluster = typeof settings.formatCluster === 'function'
        ? settings.formatCluster
        : (count) => count + ' workspaces'

      // Pinned names first, so a dense scene always keeps the name the user is acting on.
      const ordered = []
      const seen = new Set()
      for (const id of [settings.selectedId, settings.hoverId, settings.focusId]) {
        if (typeof id !== 'string' || seen.has(id)) continue
        const item = list.find((entry) => entry && entry.id === id)
        if (!item) continue
        seen.add(id)
        ordered.push({ item, emphasis: true })
      }
      for (const item of list) {
        if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue
        const isHit = searchActive && item.dimmed !== true
        if (dense && !isHit && !mounted.has(item.id)) continue
        ordered.push({ item, emphasis: isHit })
      }

      const bottom = height - LABEL_RESERVED_BOTTOM
      const placed = []
      const labels = []
      for (const entry of ordered) {
        const item = entry.item
        const text = item.cluster
          ? formatCluster(Math.max(1, Math.floor(Number(item.count) || 1)))
          : labelText(item.node && item.node.name)
        if (text === '') continue
        const boxWidth = labelWidth(text)
        // Candidate anchors around the star, in order of preference: above / level / below, then
        // two wider fallbacks; each to the right first then flipped to the left. Avoidance only
        // ever moves text.
        const candidates = []
        for (const dy of [LABEL_OFFSET_Y - LABEL_HEIGHT, LABEL_OFFSET_Y, LABEL_OFFSET_Y + LABEL_HEIGHT, LABEL_OFFSET_Y - LABEL_HEIGHT * 2, LABEL_OFFSET_Y + LABEL_HEIGHT * 2]) {
          candidates.push({ x: item.x + LABEL_OFFSET_X, y: item.y + dy })
          candidates.push({ x: item.x - LABEL_OFFSET_X - boxWidth, y: item.y + dy })
        }
        let chosen = null
        for (const candidate of candidates) {
          const x = candidate.x
          const y = candidate.y
          if (x < LABEL_MARGIN || x + boxWidth > width - LABEL_MARGIN) continue
          if (y < LABEL_MARGIN || y + LABEL_HEIGHT > bottom) continue
          let clash = false
          for (const other of placed) {
            if (
              x < other.x + other.w &&
              other.x < x + boxWidth &&
              y < other.y + other.h &&
              other.y < y + LABEL_HEIGHT
            ) {
              clash = true
              break
            }
          }
          if (clash) continue
          chosen = { x, y }
          break
        }
        if (!chosen) continue
        placed.push({ x: chosen.x, y: chosen.y, w: boxWidth, h: LABEL_HEIGHT })
        labels.push({
          key: item.id,
          text,
          x: chosen.x,
          y: chosen.y,
          kind: item.cluster ? 'cluster' : 'workspace',
          emphasis: entry.emphasis,
        })
      }
      return labels
    }

    /** Small deterministic PRNG so the filament mesh is identical on every render. */    function mulberry32(seed) {
      let state = seed >>> 0
      return function random() {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    const GALAXY_STYLE = {
      /** Fixed: the background field never depends on how many workspaces exist. */
      farCount: 180,
      nearCount: 80,
      farSize: [0.7, 1.4],
      nearSize: [1.3, 2.2],
      farAlpha: [0.08, 0.3],
      nearAlpha: [0.16, 0.46],
      /** Background stars spread wider than the disc so they read as "space", not a ring. */
      fieldRadius: 1.75,
      fieldDepth: 0.45,
      seed: 0x5eed1234,
      hazeAlpha: 0.42,
      ringAlphas: [0.09, 0.055],
      ringScales: [1, 1.14],
      /** How far outside the disc the outer ring sits (keeps bead glow inside the frame). */
      ringMargin: 1.08,
      /** Halo pulse: only for workspaces with real activity data. */
      pulseSpeed: 1.35,
      pulseStrength: 0.38,
    }

    /**
     * Canvas-side galaxy profile (P3). Three stays the primary renderer; these numbers make the
     * Canvas *fallback* read as the same object without copying three's implementation: every
     * value is expressed in CSS pixels or as a ratio of the bead radius, so it can be compared
     * with `aSize` (radius × 3.2) and `PointsMaterial.size` (1.4 / 2.2).
     *
     * Read by the Canvas renderer for every scene: the galaxy is the only skin now.
     */
    const GALAXY_CANVAS_STYLE = {
      /** Glow sprite diameter ÷ bead radius. three: aSize = radius × 3.2 × (1 + 0.35·depth). */
      glowDiameter: 4.8,
      /** Core disc: bead colour mixed this far toward white (three: mix(vColor, white, 0.6)). */
      coreWhiteMix: 0.6,
      coreScale: 0.58,
      /** Depth alpha: floor + gain × perspective / 0.62. Numbers unchanged; documented for P3. */
      alphaFloor: 0.34,
      alphaGain: 0.66,
      /** Background star diameter in CSS px, far / near (three: 1.4 / 2.2). */
      starSize: [1.4, 2.2],
      /** Activity halo: radius = radius × (inner + span × wave); peak alpha. */
      activityRing: [1.35, 0.4],
      activityAlpha: 0.26,
      /** Flare: real activity only, fixed length ÷ radius, thin and dim. */
      flareLength: 1.9,
      flareAlpha: 0.3,
      flareWidth: 0.8,
    }

    const starCache = new Map()

    /**
     * Deterministic background star field. Same seed ⇒ same stars, in the same order, forever —
     * nothing here depends on the workspace set, the camera or the clock.
     *
     * P5 splits each layer into two populations: a disc-plane share (the galaxy's own stars) and
     * a sky share (fills the frame outside the disc). Both totals stay fixed at 180 far + 80 near
     * and the split is a constant fraction, never a function of how many workspaces exist.
     *
     * @param {number} count
     * @param {{ seed?: number, layer?: 'far' | 'near', discShare?: number }} [options]
     */
    function createStarField(count, options) {
      const settings = options || {}
      const layer = settings.layer === 'near' ? 'near' : 'far'
      const total = Math.max(0, Math.floor(Number(count) || 0))
      const seed = (settings.seed === undefined ? GALAXY_STYLE.seed : settings.seed) >>> 0
      const discShare = Math.max(
        0,
        Math.min(
          1,
          settings.discShare === undefined
            ? (layer === 'near' ? GALAXY_STRUCTURE_STYLE.nearDiscShare : GALAXY_STRUCTURE_STYLE.farDiscShare)
            : Number(settings.discShare) || 0,
        ),
      )
      if (total === 0) return []
      const cacheKey = layer + ':' + seed + ':' + total + ':' + discShare + ':' + GALAXY_ARM_STYLE.version
      const cached = starCache.get(cacheKey)
      if (cached) return cached

      // Separate streams per layer so changing one count cannot reshuffle the other.
      const random = mulberry32(seed + (layer === 'near' ? 0x9e37 : 0x1b1b))
      const sizeRange = layer === 'near' ? GALAXY_STYLE.nearSize : GALAXY_STYLE.farSize
      const alphaRange = layer === 'near' ? GALAXY_STYLE.nearAlpha : GALAXY_STYLE.farAlpha
      const cosTilt = Math.cos(GALAXY.tilt)
      const sinTilt = Math.sin(GALAXY.tilt)
      const stars = []

      // Quota stratification instead of rejection sampling: every disc star is assigned to
      // bulge, arm or gap up front, so totals stay exact and no loop ever retries.
      const armStyle = GALAXY_ARM_STYLE
      const bulgeCut = armStyle.bulgeShare
      const armCut = armStyle.bulgeShare + armStyle.armShare

      for (let index = 0; index < total; index += 1) {
        const onDisc = random() < discShare
        const reach = onDisc ? GALAXY_STYLE.fieldRadius * GALAXY_STRUCTURE_STYLE.discReach : GALAXY_STYLE.fieldRadius
        let normalized = 0
        let angle = 0
        let thickness = 0

        if (!onDisc) {
          normalized = Math.sqrt(random())
          angle = random() * Math.PI * 2
        } else {
          const roll = random()
          if (roll < bulgeCut) {
            normalized = GALAXY_STRUCTURE_STYLE.bulgeRadius * Math.sqrt(random())
            angle = random() * Math.PI * 2
          } else if (roll < armCut) {
            const arm = index % armStyle.armCount
            normalized = armStyle.armInner + random() * (0.98 - armStyle.armInner)
            const spread = (random() + random() - 1) * armWidthAt(normalized, armStyle)
            angle = armThetaAt(normalized, arm, armStyle) + spread
          } else {
            normalized = Math.sqrt(random()) * 0.98
            angle = random() * Math.PI * 2
          }
          thickness = armStyle.discThickness * (1 - armStyle.thicknessFade * normalized)
        }

        const radius = reach * normalized
        const depthRandom = random()
        const depth = onDisc
          ? (depthRandom - 0.5) * 2 * thickness * reach
          : (depthRandom - 0.5) * 2 * GALAXY_STYLE.fieldDepth
        const a = radius * Math.cos(angle)
        const b = radius * Math.sin(angle)
        const x = a
        const y = onDisc ? b * cosTilt - depth * sinTilt : b
        const z = onDisc ? b * sinTilt + depth * cosTilt : depth

        // near side of the plate reads a touch brighter, far side a touch dimmer
        const parallax = onDisc && thickness > 0 ? 1 + (z / (reach * thickness)) * 0.12 : 1

        stars.push({
          x,
          y,
          z,
          radius: sizeRange[0] + random() * (sizeRange[1] - sizeRange[0]),
          alpha: Math.max(
            0.02,
            Math.min(alphaRange[1], (alphaRange[0] + random() * (alphaRange[1] - alphaRange[0])) * parallax),
          ),
          layer,
          onDisc,
        })
      }
      starCache.set(cacheKey, stars)
      return stars
    }

    /**
     * P5 — galaxy structure: the layers *under* the workspace light points.
     *
     * Everything here is derived artwork. No workspace id, path, session, scan state or camera
     * ever reaches the generator, so the sky cannot change when the workspace set changes. The
     * numbers below are budgets first (sample counts, maximum alpha) and taste second, because
     * the Canvas fallback consumes exactly the same data as the Three primary renderer.
     *
     * Each layer has its own seed stream, so changing one layer's count can never reshuffle
     * another layer's samples.
     */
    const GALAXY_STRUCTURE_STYLE = Object.freeze({
      seed: 0x5a6c0f31,
      /** Interstellar gas: one connected band of overlapping elliptical samples (contract ≤ 12). */
      gasCount: 4,
      /** Interstellar dust: short dark streaks inside the disc (contract ≤ 96). */
      dustCount: 96,
      /** Halo: sparse samples outside the disc (contract ≤ 64). */
      haloCount: 64,
      haloInner: 1.08,
      haloOuter: 1.62,
      haloSize: [0.9, 1.9],
      haloAlpha: [0.04, 0.12],
      dustInner: 0.34,
      dustOuter: 0.94,
      dustLength: [0.08, 0.22],
      dustAlpha: [0.05, 0.14],
      /** Tangential jitter in radians: dust follows the disc instead of scattering at random. */
      dustSkew: 0.55,
      /** Bulge: exactly one continuous centre distribution, in disc radii. */
      bulgeRadius: 0.24,
      bulgeAlpha: 0.2,
      /** Share of each star layer that lives in the disc plane (the rest fills the sky). */
      nearDiscShare: 0.74,
      farDiscShare: 0.42,
      /** Disc-plane stars stay inside this fraction of the star field's reach. */
      discReach: 0.72,
    })

    /**
     * P5.2 — spiral arms.
     *
     * Two logarithmic arms expressed in normalised disc coordinates (r in [0, 1], theta in
     * radians). Everything here is pure geometry: no clock, no camera, no workspace data, and no
     * per-frame randomness. The low-frequency perturbation is a fixed sine of r, so the arms read
     * as organic without ever shimmering.
     */
    const GALAXY_ARM_STYLE = Object.freeze({
      /** Bump when the arm geometry changes so cached star/structure samples cannot be reused. */
      version: 1,
      armCount: 2,
      /** Turns of the spiral over r ∈ [armInner, 1]. */
      armTurns: 0.95,
      /** Angular half-width at the inner radius, and how much it grows outward. */
      armWidth: 0.09,
      armWidthGrowth: 0.045,
      /** Star-density modulation ceiling (contract: ≤ 1.8× the gap baseline). */
      armStrength: 1.6,
      /** Centreline wobble amplitude, in units of the local arm width (contract: ≤ 0.2). */
      armPerturbation: 0.14,
      armInner: 0.18,
      /** Disc half-thickness, and how much thinner the outer disc gets. */
      discThickness: 0.045,
      thicknessFade: 0.6,
      /** Star quotas inside the disc (must sum to 1). */
      bulgeShare: 0.18,
      armShare: 0.56,
      gapShare: 0.26,
      /** Two tapered gas clouds per arm, so canvas needs at most 4 gradients. */
      gasPerArm: 2,
      /** Share of dust samples placed on the arms (the rest fills the gaps). */
      dustArmBias: 0.72,
      /** Arm phase offset, radians. */
      armPhase: 0,
    })

    /** Shortest signed angular difference, in (-π, π]. */
    function angleDelta(a, b) {
      const raw = (Number(a) || 0) - (Number(b) || 0)
      return Math.atan2(Math.sin(raw), Math.cos(raw))
    }

    /**
     * Centreline angle of one arm at normalised radius r.
     * Logarithmic spiral mapped so that r = armInner is angle 0 and r = 1 is armTurns turns.
     */
    function armThetaAt(r, armIndex, style) {
      const tuning = style || GALAXY_ARM_STYLE
      const inner = tuning.armInner
      const clamped = Math.max(inner, Math.min(1, Number(r) || inner))
      const t = Math.log(clamped / inner) / Math.log(1 / inner)
      return (
        tuning.armPhase +
        t * tuning.armTurns * Math.PI * 2 +
        ((Number(armIndex) || 0) * Math.PI * 2) / Math.max(1, tuning.armCount)
      )
    }

    /** Local angular half-width of an arm at radius r. */
    function armWidthAt(r, style) {
      const tuning = style || GALAXY_ARM_STYLE
      const clamped = Math.max(0, Math.min(1.2, Number(r) || 0))
      return tuning.armWidth + tuning.armWidthGrowth * Math.max(0, clamped - tuning.armInner)
    }

    /** Deterministic, bounded centreline wobble (no randomness, no time). */
    function armWobbleAt(r, armIndex, style) {
      const tuning = style || GALAXY_ARM_STYLE
      const width = armWidthAt(r, tuning)
      return (
        Math.sin(r * 6.2 + (Number(armIndex) || 0) * 1.7) * tuning.armPerturbation * width
      )
    }

    /**
     * Normalised arm density at a disc position: 0 in the gaps, 1 on a centreline.
     * Sum of gaussians over the arms, clamped, with the centreline wobble folded in.
     */
    function armDensityAt(r, theta, style) {
      const tuning = style || GALAXY_ARM_STYLE
      const radius = Number(r)
      if (!Number.isFinite(radius) || radius <= 0.02 || radius > 1.05) return 0
      const angle = Number(theta) || 0
      let total = 0
      for (let arm = 0; arm < tuning.armCount; arm += 1) {
        const centre = armThetaAt(radius, arm, tuning) + armWobbleAt(radius, arm, tuning)
        const delta = angleDelta(angle, centre)
        const width = armWidthAt(radius, tuning)
        total += Math.exp(-Math.pow(delta / width, 2) * 1.8)
      }
      return Math.min(1, total)
    }

    /**
     * The gas band, in disc-local units (1 = the disc's half extent).
     *
     * The P5 shape rules are encoded here, not in a shader branch:
     *  - every sample sits on the same side of the centre (the first *is* the centre), so the
     *    union can never read as two lobes or a pair of "eyes";
     *  - each next sample is smaller and dimmer, so the band tapers into a single tail;
     *  - consecutive centres are closer than the sum of their radii, so the union is connected.
     */
    /**
     * One tapered chain per arm, in *arm-local* units: the structure layer rotates each entry by
     * the arm's centreline angle. Two entries per arm keeps the band continuous while staying
     * inside the canvas gradient budget (2 arms × 2 = 4).
     *
     * Radii are elliptical on purpose: the projection scales x and y by the disc extents, so a
     * round sample in disc space reads as a band lying in the tilted disc.
     */
    const GAS_CHAIN = Object.freeze([
      // rx is deliberately wide: a log spiral moves fast in angle, so each sample has to cover a
      // visible arc segment and overlap its neighbour for the band to stay continuous.
      Object.freeze({ radius: 0.5, rx: 0.58, ry: 0.13, alpha: 0.075 }),
      Object.freeze({ radius: 0.82, rx: 0.53, ry: 0.15, alpha: 0.045 }),
    ])

    const structureCache = new Map()

    /**
     * The deterministic galaxy structure. Same seed ⇒ same samples, in the same order, forever.
     * Pure: it never sees positions, beads, workspace ids, the camera or the clock.
     *
     * @param {{ seed?: number, gasCount?: number, dustCount?: number, haloCount?: number }} [options]
     */
    function createGalaxyStructure(options) {
      const tuning = options || {}
      const seed = (tuning.seed === undefined ? GALAXY_STRUCTURE_STYLE.seed : tuning.seed) >>> 0
      const budget = (key, limit) => {
        const wanted = tuning[key] === undefined ? GALAXY_STRUCTURE_STYLE[key] : Number(tuning[key])
        return Math.max(0, Math.min(limit, Math.floor(Number.isFinite(wanted) ? wanted : 0)))
      }
      const counts = {
        gas: budget('gasCount', GALAXY_ARM_STYLE.armCount * GAS_CHAIN.length),
        dust: budget('dustCount', 96),
        halo: budget('haloCount', 64),
      }
      const cacheKey = [seed, counts.gas, counts.dust, counts.halo, GALAXY_ARM_STYLE.version].join(':')
      const cached = structureCache.get(cacheKey)
      if (cached) return cached

      // Separate streams: a count change touches its own layer only.
      const gasRandom = mulberry32(seed + 0x4a2d)
      const clouds = []
      // One tapered chain of samples per arm: r increases along the chain, and both the radius
      // and the alpha shrink, so each arm reads as a single band that fades outward.
      for (let arm = 0; arm < GALAXY_ARM_STYLE.armCount; arm += 1) {
        for (let link = 0; link < GALAXY_ARM_STYLE.gasPerArm; link += 1) {
          const chain = GAS_CHAIN[link]
          if (!chain) continue
          if (clouds.length >= counts.gas) break
          const radius = chain.radius + (gasRandom() - 0.5) * 0.02
          const angle = armThetaAt(radius, arm) + (gasRandom() - 0.5) * GALAXY_ARM_STYLE.armWidth * 0.6
          // No extra taper: the template already shrinks rx/alpha per link, and any further
          // shrink breaks the overlap that keeps the band continuous.
          const taper = 1
          clouds.push({
            x: radius * Math.cos(angle),
            y: radius * Math.sin(angle),
            rx: Math.max(0.05, chain.rx * taper * (0.97 + gasRandom() * 0.06)),
            ry: Math.max(0.04, chain.ry * taper * (0.97 + gasRandom() * 0.06)),
            alpha: chain.alpha * (0.95 + gasRandom() * 0.1),
            arm,
          })
        }
      }

      const dustRandom = mulberry32(seed + 0x2b3c)
      const pick = (range, random) => range[0] + random() * (range[1] - range[0])
      const dust = []
      const dustSpan = GALAXY_STRUCTURE_STYLE.dustOuter - GALAXY_STRUCTURE_STYLE.dustInner
      for (let index = 0; index < counts.dust; index += 1) {
        const onArm = dustRandom() < GALAXY_ARM_STYLE.dustArmBias
        const radius = GALAXY_STRUCTURE_STYLE.dustInner + Math.sqrt(dustRandom()) * dustSpan
        let angle
        if (onArm) {
          // inner edge of an arm: offset by roughly one arm width, on the trailing side
          const arm = index % GALAXY_ARM_STYLE.armCount
          angle =
            armThetaAt(radius, arm) -
            armWidthAt(radius) * (0.55 + dustRandom() * 0.5) +
            (dustRandom() - 0.5) * 0.12
        } else {
          angle = dustRandom() * Math.PI * 2
        }
        dust.push({
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
          angle: angle + Math.PI / 2 + (dustRandom() - 0.5) * 2 * GALAXY_STRUCTURE_STYLE.dustSkew,
          length: pick(GALAXY_STRUCTURE_STYLE.dustLength, dustRandom),
          // gap dust is weaker, but never outside the declared range (tests assert the bound)
          alpha: onArm
            ? pick(GALAXY_STRUCTURE_STYLE.dustAlpha, dustRandom)
            : GALAXY_STRUCTURE_STYLE.dustAlpha[0] +
              (GALAXY_STRUCTURE_STYLE.dustAlpha[1] - GALAXY_STRUCTURE_STYLE.dustAlpha[0]) * 0.4 * dustRandom(),
          onArm,
        })
      }

      const haloRandom = mulberry32(seed + 0x7d1e)
      const halo = []
      for (let index = 0; index < counts.halo; index += 1) {
        const reach = pick([GALAXY_STRUCTURE_STYLE.haloInner, GALAXY_STRUCTURE_STYLE.haloOuter], haloRandom)
        const angle = haloRandom() * Math.PI * 2
        halo.push({
          x: reach * Math.cos(angle),
          y: reach * Math.sin(angle),
          radius: pick(GALAXY_STRUCTURE_STYLE.haloSize, haloRandom),
          alpha: pick(GALAXY_STRUCTURE_STYLE.haloAlpha, haloRandom),
        })
      }

      const structure = {
        seed,
        counts,
        arms: {
          version: GALAXY_ARM_STYLE.version,
          count: GALAXY_ARM_STYLE.armCount,
          turns: GALAXY_ARM_STYLE.armTurns,
          width: GALAXY_ARM_STYLE.armWidth,
          strength: GALAXY_ARM_STYLE.armStrength,
          inner: GALAXY_ARM_STYLE.armInner,
        },
        disc: { radius: GALAXY.radius, tilt: GALAXY.tilt },
        gas: { clouds },
        dust,
        halo,
        bulge: {
          x: 0,
          y: 0,
          radius: GALAXY_STRUCTURE_STYLE.bulgeRadius,
          alpha: GALAXY_STRUCTURE_STYLE.bulgeAlpha,
        },
      }
      structureCache.set(cacheKey, structure)
      return structure
    }

    /**
     * Project the structure into CSS pixels.
     *
     * The only visual anchor is `galaxyDiscExtent()` — the projected disc, which is also what the
     * stage rings are derived from. A camera move, a pan, a zoom or a resize therefore changes
     * the mapping and nothing else: the samples are never re-sampled, and gas, dust, bulge and
     * halo move and scale together with the disc they belong to.
     *
     * @param {object} structure result of `createGalaxyStructure`
     * @param {{ extent: {cx:number, cy:number, halfWidth:number, halfHeight:number} }} options
     */
    function projectGalaxyStructure(structure, options) {
      if (!structure || !options) return null
      const extent = options.extent
      if (!extent || !(extent.halfWidth > 0) || !(extent.halfHeight > 0)) return null
      const toX = (u) => extent.cx + (Number(u) || 0) * extent.halfWidth
      const toY = (v) => extent.cy + (Number(v) || 0) * extent.halfHeight

      const clouds = []
      for (const cloud of structure.gas.clouds) {
        clouds.push({
          x: toX(cloud.x),
          y: toY(cloud.y),
          rx: Math.max(1, cloud.rx * extent.halfWidth),
          ry: Math.max(1, cloud.ry * extent.halfHeight),
          alpha: cloud.alpha,
        })
      }

      const dust = []
      for (const band of structure.dust) {
        dust.push({
          x: toX(band.x),
          y: toY(band.y),
          angle: band.angle,
          // one disc-unit streak is a different length on each axis; the diagonal average keeps
          // a streak the same apparent length in both directions
          length: Math.max(1, band.length * (extent.halfWidth + extent.halfHeight) * 0.5),
          alpha: band.alpha,
        })
      }

      const halo = []
      for (const star of structure.halo) {
        halo.push({ x: toX(star.x), y: toY(star.y), radius: star.radius, alpha: star.alpha })
      }

      const bulgeAt = { x: toX(structure.bulge.x), y: toY(structure.bulge.y) }
      return {
        disc: { cx: extent.cx, cy: extent.cy, halfWidth: extent.halfWidth, halfHeight: extent.halfHeight },
        gas: { clouds },
        dust,
        halo,
        bulge: {
          cx: bulgeAt.x,
          cy: bulgeAt.y,
          radius: structure.bulge.radius * extent.halfWidth,
          alpha: structure.bulge.alpha,
        },
      }
    }

    /**
     * Shared visual coefficients for the brain body. Canvas and three read the same numbers;
     * only the drawing technique (and a couple of alphas) may differ per renderer.
     *
     * Beads keep scale 1 on purpose: the tissue must never dim the information layer.
     */
    // ------------------------------------------------------------------- [source]

    const SCAN_ENDPOINT = '/plugins/dsh-brain-workspaces/api/scan'

    /** Asking for this media type turns the scan route into a line-delimited event stream. */
    const STREAM_ACCEPT = 'application/x-ndjson'

    function scanFailure(code, message, status) {
      const error = new Error(message || code)
      error.code = code
      if (status) error.status = status
      return error
    }

    /** One accepted snapshot shape, shared by the JSON path and the stream's `done` line. */
    function readSnapshot(snapshot) {
      if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.workspaces)) {
        throw scanFailure('bad-response', '返回的数据不是有效的快照')
      }
      if (!Array.isArray(snapshot.warnings)) snapshot.warnings = []
      return snapshot
    }

    /**
     * Incremental NDJSON splitter. One event per line; a chunk may end mid-line, so the tail
     * is buffered until its newline arrives. Malformed lines are dropped rather than fatal:
     * the stream still ends with a `done` line carrying the authoritative snapshot.
     *
     * @param {(event: object) => void} onEvent
     */
    function createNdjsonReader(onEvent) {
      let buffer = ''

      const accept = (text) => {
        let event
        try {
          event = JSON.parse(text)
        } catch {
          return
        }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
        try {
          onEvent(event)
        } catch {
          /* a listener must not break the stream */
        }
      }

      const drain = () => {
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.trim() !== '') accept(line)
          index = buffer.indexOf('\n')
        }
      }

      return {
        push(text) {
          buffer += String(text === undefined || text === null ? '' : text)
          drain()
        },
        finish() {
          const rest = buffer.trim()
          buffer = ''
          if (rest !== '') accept(rest)
        },
      }
    }

    function responseIsStream(response) {
      try {
        const headers = response && response.headers
        const type = headers && typeof headers.get === 'function' ? String(headers.get('content-type') || '') : ''
        if (!type.toLowerCase().includes(STREAM_ACCEPT)) return false
        return Boolean(response.body && typeof response.body.getReader === 'function')
      } catch {
        return false
      }
    }

    function abortFailure() {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return error
    }

    /**
     * Consume the event stream. Progress callbacks fire as lines arrive; the promise
     * resolves with the snapshot from the `done` line, and rejects for a real failure, an
     * aborted request, or a stream that ended without a `done` (a cancelled sweep).
     */
    async function readStreamSnapshot(response, onEvent, signal) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let snapshot = null
      let failure = null

      const parser = createNdjsonReader((event) => {
        if (event.type === 'done') {
          snapshot = event.snapshot || null
          return
        }
        if (event.type === 'error') {
          failure = scanFailure('scan-failed', String(event.message || event.error || '扫描失败'))
          return
        }
        if (failure) return
        onEvent(event)
      })

      try {
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          if (step.value) parser.push(decoder.decode(step.value, { stream: true }))
        }
        const tail = decoder.decode()
        if (tail) parser.push(tail)
        parser.finish()
      } catch (error) {
        if (isAbortError(error)) throw error
        throw failure || scanFailure('stream-broken', describeError(error))
      }

      if (failure) throw failure
      if (signal && signal.aborted) throw abortFailure()
      if (!snapshot) throw scanFailure('truncated-stream', '扫描流在结束前中断，没有收到完成事件')
      return readSnapshot(snapshot)
    }

    /**
     * Read-only scanner: one same-origin GET to the Host's scan route.
     *
     * The listing itself happens in the Host half (`source-local/scan-host.js`), because
     * this deployment composes the native directory picker and therefore has no browse
     * capability behind `uiWorkspace.listDirectory`. Nothing here reads a file: the route
     * answers directory metadata for a root the user picked.
     *
     * A caller that passes `onEvent` gets the progress stream (`accept: application/x-ndjson`);
     * without it the request and the parsing are byte-for-byte what they were before, which is
     * also how an older Host keeps working: it answers JSON, and this falls back to `json()`.
     *
     * @param {{ fetch?: Function, endpoint?: string }} [deps]
     */
    function createHttpScanner(deps) {
      const call = (deps && deps.fetch) || ((input, init) => fetch(input, init))
      const endpoint = (deps && deps.endpoint) || SCAN_ENDPOINT

      return {
        /**
         * @param {{ rootPath: string, options?: object, signal?: AbortSignal, onEvent?: Function }} request
         * @returns {Promise<object>} WorkspaceSnapshot
         */
        async scan(request) {
          const root = normalizePath(request.rootPath)
          const streaming = typeof request.onEvent === 'function'

          const params = new URLSearchParams()
          params.set('root', root)

          let response
          try {
            response = await call(endpoint + '?' + params.toString(), {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: streaming ? STREAM_ACCEPT : 'application/json' },
              signal: request.signal,
            })
          } catch (error) {
            if (isAbortError(error)) throw error
            throw scanFailure('route-unreachable', describeError(error))
          }

          if (!response.ok) {
            let detail = ''
            try {
              const body = await response.json()
              if (body && (body.message || body.error)) detail = String(body.message || body.error)
            } catch {
              /* error body was not JSON */
            }
            throw scanFailure('route-' + response.status, detail, response.status)
          }

          if (streaming && responseIsStream(response)) {
            return readStreamSnapshot(response, request.onEvent, request.signal)
          }

          let snapshot
          try {
            snapshot = await response.json()
          } catch (error) {
            throw scanFailure('bad-response', describeError(error))
          }
          return readSnapshot(snapshot)
        },
      }
    }

    // ---------------------------------------------------------------- [scan model]

    /**
     * Minimum gap between two published partial results. A wide sweep finishes several
     * workspaces per millisecond; re-laying out and repainting the brain for each of those
     * would cost more than the scan itself.
     */
    const PROGRESS_FLUSH_MS = 120

    /**
     * Progressive state of one sweep.
     *
     * Deliberately plain data: every field is either copied from a stream event or counted
     * from the nodes received so far, so the whole progress story is testable without React.
     * `nodes` is the partial result the panel keeps painting while the sweep runs.
     */
    function emptyScanModel(rootPath) {
      return {
        rootPath: normalizePath(rootPath),
        started: false,
        complete: false,
        startedAt: 0,
        declared: 0,
        done: 0,
        visitedDirs: 0,
        maxDirs: 0,
        maxDepth: 0,
        timeoutMs: 0,
        elapsedMs: 0,
        nodes: [],
        warnings: [],
        limits: { dirs: false, time: false, depth: false },
        limitNotes: [],
        error: '',
        /** Slot assignments carried across updates, so beads never jump mid-sweep. */
        assignments: {},
        /** The authoritative snapshot of the `done` line. */
        snapshot: null,
      }
    }

    function countOr(value, fallback) {
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
    }

    function warningKey(warning) {
      if (!warning || typeof warning !== 'object') return ''
      return String(warning.code || '') + '|' + String(warning.workspaceId || '') + '|' +
        String(warning.path || '') + '|' + String(warning.message || '')
    }

    /**
     * Collapse warnings into one row per (code, message), keeping a count and a few sample paths.
     *
     * A real scan emits one `truncated-depth` warning per directory that sits at the depth cap:
     * 4492 of 4493 warnings on a 33-workspace root, collapsing to two kinds. Listing them one by
     * one buries every other warning, so the panel shows one row per kind and a count instead.
     */
    function groupWarnings(warnings, limit) {
      if (!Array.isArray(warnings)) return { groups: [], hidden: 0, kinds: 0, total: 0 }
      const order = []
      const seen = new Map()
      let total = 0

      for (const warning of warnings) {
        if (!warning || typeof warning !== 'object') continue
        total += 1
        const code = String(warning.code || '')
        const message = String(warning.message || '')
        const key = code + '|' + message
        let entry = seen.get(key)
        if (!entry) {
          entry = { key, code, message, count: 0, paths: [] }
          seen.set(key, entry)
          order.push(entry)
        }
        entry.count += 1
        if (entry.paths.length < 3 && typeof warning.path === 'string' && warning.path !== '') {
          entry.paths.push(warning.path)
        }
      }

      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : order.length
      return {
        groups: order.slice(0, max),
        hidden: Math.max(0, order.length - max),
        kinds: order.length,
        total,
      }
    }

    function mergeWarnings(existing, incoming) {
      if (!Array.isArray(incoming) || incoming.length === 0) return existing
      const known = new Set(existing.map(warningKey))
      const next = existing.slice()
      for (const warning of incoming) {
        if (!warning || typeof warning !== 'object') continue
        const key = warningKey(warning)
        if (known.has(key)) continue
        known.add(key)
        next.push(warning)
      }
      return next
    }

    /**
     * Fold one stream event into the sweep model. Unknown event types are ignored, and a
     * repeated workspace id never duplicates a node.
     *
     * @param {object} model
     * @param {object} event
     */
    function reduceScanEvent(model, event) {
      const base = model && typeof model === 'object' ? model : emptyScanModel('')
      if (!event || typeof event.type !== 'string') return base
      const next = Object.assign({}, base)

      if (event.type === 'start') {
        next.started = true
        next.declared = countOr(event.declared, base.declared)
        next.maxDirs = countOr(event.maxDirs, base.maxDirs)
        next.maxDepth = countOr(event.maxDepth, base.maxDepth)
        next.timeoutMs = countOr(event.timeoutMs, base.timeoutMs)
        next.startedAt = countOr(event.startedAt, base.startedAt)
        return next
      }

      if (event.type === 'warning') {
        next.warnings = mergeWarnings(base.warnings, [event.warning])
        return next
      }

      if (event.type === 'workspace') {
        const node = event.node
        next.started = true
        if (node && typeof node.id === 'string' && !base.nodes.some((item) => item.id === node.id)) {
          next.nodes = base.nodes.concat([node])
        }
        next.warnings = mergeWarnings(base.warnings, Array.isArray(event.warnings) ? event.warnings : [])
        next.done = countOr(event.done, next.nodes.length)
        next.declared = countOr(event.declared, base.declared)
        next.visitedDirs = countOr(event.visitedDirs, base.visitedDirs)
        next.elapsedMs = countOr(event.elapsedMs, base.elapsedMs)
        return next
      }

      if (event.type === 'limit') {
        if (!event.kind) return next
        next.limits = Object.assign({}, base.limits, { [event.kind]: true })
        next.limitNotes = base.limitNotes.concat([
          { kind: event.kind, limit: countOr(event.limit, 0), used: countOr(event.used, 0) },
        ])
        return next
      }

      if (event.type === 'done') {
        const snapshot = event.snapshot
        if (!snapshot || !Array.isArray(snapshot.workspaces)) return next
        const summary = snapshot.scan && typeof snapshot.scan === 'object' ? snapshot.scan : {}
        next.complete = true
        next.started = true
        next.snapshot = snapshot
        next.nodes = snapshot.workspaces.slice()
        next.warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.slice() : base.warnings
        next.declared = countOr(summary.declared, next.nodes.length)
        next.done = countOr(summary.scanned, next.nodes.length)
        next.visitedDirs = countOr(summary.visitedDirs, base.visitedDirs)
        next.maxDirs = countOr(summary.maxDirs, base.maxDirs)
        next.maxDepth = countOr(summary.maxDepth, base.maxDepth)
        next.timeoutMs = countOr(summary.timeoutMs, base.timeoutMs)
        next.elapsedMs = countOr(summary.elapsedMs, base.elapsedMs)
        if (summary.limits && typeof summary.limits === 'object') {
          next.limits = Object.assign({}, base.limits, {
            dirs: summary.limits.dirs === true,
            time: summary.limits.time === true,
            depth: summary.limits.depth === true,
          })
        }
        return next
      }

      if (event.type === 'error') {
        next.error = String(event.message || event.error || '扫描失败')
        return next
      }

      return next
    }

    /**
     * Summary for a sweep that has not produced its `done` line yet.
     *
     * `partial` is the only flag the panel trusts for "these results are incomplete"; while a
     * sweep is running it is true by definition, which is what keeps a cancelled sweep from
     * looking like a finished one.
     */
    function scanSummaryFromModel(model) {
      const declared = countOr(model.declared, 0)
      const scanned = model.nodes.length
      const limits = model.limits || { dirs: false, time: false, depth: false }
      return {
        declared: declared || scanned,
        scanned,
        visitedDirs: countOr(model.visitedDirs, 0),
        maxDirs: countOr(model.maxDirs, 0),
        maxDepth: countOr(model.maxDepth, 0),
        timeoutMs: countOr(model.timeoutMs, 0),
        elapsedMs: countOr(model.elapsedMs, 0),
        partial: !model.complete || scanned < declared || Boolean(limits.dirs) || Boolean(limits.time),
        limits: {
          dirs: Boolean(limits.dirs),
          time: Boolean(limits.time),
          depth: Boolean(limits.depth),
        },
      }
    }

    /** Drawable snapshot for a running or aborted sweep (the `done` line wins when present). */
    function scanSnapshotFromModel(model) {
      if (model.snapshot) return model.snapshot
      return {
        schemaVersion: 1,
        rootPath: model.rootPath,
        scannedAt: Date.now(),
        workspaces: model.nodes,
        warnings: model.warnings,
        scan: scanSummaryFromModel(model),
      }
    }

    // -------------------------------------------------------------------- [store]

    // v3: snapshots now carry `modifiedAt`; a v2 cache would show a brain with no activity
    // data, so pulses could never fire until the next scan.
    const STORAGE_PREFIX = 'dsh-brain-workspaces:v3:'
    const STORAGE_LAST_ROOT = STORAGE_PREFIX + 'last'

    function trimSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null
      return {
        schemaVersion: snapshot.schemaVersion || SCHEMA_VERSION,
        rootPath: snapshot.rootPath,
        scannedAt: snapshot.scannedAt,
        workspaces: (snapshot.workspaces || []).slice(0, 2000),
        warnings: (snapshot.warnings || []).slice(0, 50),
      }
    }

    /**
     * Snapshot and slot-assignment persistence. Deliberately tiny (a few KB): the
     * point of the 2000-node / 50-warning caps is that this never grows into
     * something worth putting on another drive.
     */
    function createStore(storage) {
      const usable = storage && typeof storage.getItem === 'function'
      const keyFor = (rootPath) => STORAGE_PREFIX + hashId(normalizePath(rootPath))

      return {
        available: Boolean(usable),
        loadLastRoot() {
          if (!usable) return null
          try {
            return storage.getItem(STORAGE_LAST_ROOT) || null
          } catch {
            return null
          }
        },
        saveLastRoot(rootPath) {
          if (!usable) return
          try {
            if (rootPath) storage.setItem(STORAGE_LAST_ROOT, rootPath)
            else storage.removeItem(STORAGE_LAST_ROOT)
          } catch {
            /* quota or disabled storage: the panel still works, it just rescans */
          }
        },
        load(rootPath) {
          if (!usable || !rootPath) return null
          try {
            const raw = storage.getItem(keyFor(rootPath))
            return raw ? JSON.parse(raw) : null
          } catch {
            return null
          }
        },
        save(rootPath, data) {
          if (!usable || !rootPath) return
          try {
            const payload = {
              rootPath: normalizePath(rootPath),
              savedAt: Date.now(),
              assignments: (data && data.assignments) || {},
              snapshot: trimSnapshot(data && data.snapshot),
            }
            storage.setItem(keyFor(rootPath), JSON.stringify(payload))
          } catch {
            /* see saveLastRoot */
          }
        },
        clear(rootPath) {
          if (!usable || !rootPath) return
          try {
            storage.removeItem(keyFor(rootPath))
          } catch {
            /* ignore */
          }
        },
      }
    }

    function safeStorage() {
      try {
        const storage = window.localStorage
        if (!storage) return null
        return storage
      } catch {
        return null
      }
    }

    // ---------------------------------------------------------------------- [i18n]

    const DICTS = {
      zh: {
        title: '元婴识海',
        subtitle: '每个光点是一个一级子目录',
        pickRoot: '选择根目录',
        rescan: '扫描',
        refresh: '刷新',
        cancel: '取消',
        scanning: '扫描中…',
        progress: (done, total) => done + '/' + total + ' 工作区',
        preparing: '准备中…',
        progressAria: '扫描进度',
        budgetDirs: '目录',
        budgetTime: '耗时',
        partialResult: '部分结果',
        partialCount: (done, total) => '已扫描 ' + done + '/' + total + ' 工作区',
        limitDirs: (limit) => '已达目录上限 ' + limit + '，剩余工作区只列名不再计数',
        limitTime: (seconds) => '已达 ' + seconds + 's 超时，剩余工作区未扫描',
        limitDepth: (depth) => '子目录超过 ' + depth + ' 层，更深层未统计',
        raiseBudget: '可在插件配置里调大 maxDirs / timeoutMs',
        cancelledPartial: (done, total) => '扫描已取消 · 已扫描 ' + done + '/' + total + ' 工作区，以下为已完成的部分结果。',
        searchPlaceholder: '搜索工作区名称',
        clearSearch: '清除搜索',
        root: '根目录',
        noRoot: '未选择根目录',
        emptyNoRoot: '还没有选择根目录。选择一个本地目录后，它下面的每个一级子目录都会成为大脑上的一个光点。',
        emptyNoWorkspaces: '这个根目录下没有任何一级子目录。',
        emptyTitle: '没有可显示的工作区',
        selectHint: '点击光点查看详情，或直接搜索名称。',
        details: '详情',
        noSelection: '未选中工作区',
        path: '路径',
        dirCount: '子目录数',
        clusterGroup: '个工作区',
        clusterZoom: '放大查看',
        magnifier: '放大镜',
        scannedAt: '扫描时间',
        status: '状态',
        region: '脑区',
        copyPath: '复制路径',
        copied: '已复制',
        copyFailed: '复制失败',
        statusReady: '正常',
        statusUnavailable: '不可读',
        statusError: '错误',
        partial: '部分统计',
        warnings: '警告',
        noWarnings: '无警告',
        warningAffected: (count) => '涉及 ' + count + ' 个目录',
        warningMore: (count) => '还有 ' + count + ' 种未显示',
        warningKinds: (count) => '共 ' + count + ' 种',
        cancelled: '扫描已取消，以下为已完成的部分结果。',
        scanFailed: '扫描失败',
        missingApi: '这个面板拿不到目录服务（uiWorkspace），无法读取本地目录。请重启 DSH 或报告该问题。',
        dimmed: '未命中搜索的光点已变暗',
        countNodes: (n) => n + ' 个工作区',
        countLow: '目录少',
        countHigh: '目录多',
        sessions: '会话数',
        lastSession: '最近新建会话',
        sizeHint: '大小 = 会话数（大 = 多）',
        satelliteHint: '卫星 = 历史会话数的聚合表达，不是可点开的一条会话',
        archivedSessions: (count) => '已归档 ' + count,
        skillsDistill: '术法蒸馏',
        skillsDistillHint: '看各工作区沉淀的技能，以及它们被真实加载过多少次',
        skillsSubtitle: '各工作区沉淀的技能，以及它们被真实加载过多少次',
        skillsLoading: '正在清点技能…',
        skillsFailed: '读取技能失败',
        skillsRetry: '重试',
        skillsClose: '关闭',
        skillsEmpty: '还没有工作区沉淀出技能',
        skillsWorkspaces: '有技能加载的工作区',
        skillsCount: '技能',
        skillsLoadsTotal: '技能加载总次数',
        skillsUsed: '被用过的不同技能',
        skillsSessionsUsed: '用过技能的会话',
        skillsUnusedTitle: '沉淀了但还没用过',
        skillsLoadsUnit: '次',
        skillsSessionsUnit: '会话',
        skillsNever: '从未使用',
        skillsCurrent: '当前光点',
        skillsScopeProject: '项目级',
        skillsScopeUser: '用户级',
        skillsEvolution: '自进化',
        skillsPending: '待处理建议',
        skillsGenerated: '生成于',
        skillsSessionsScanned: '已扫会话',
        skillsExpandAll: '全部展开',
        skillsCollapseAll: '全部收起',
        skillsRecommended: '可提升为全局的项目技能',
        skillsRecommendedEmpty: '暂时没有可提升的项目技能',
        skillsHintNotVerdict: '热度只说明经常用；项目标识只是提示，不构成否决。最终由你判断，不会自动加入全局。',
        skillsStatusProject: '项目专用（提示）',
        skillsStatusPortable: '可迁移，待验证',
        skillsStatusNeedsStructure: '缺结构与标识',
        skillsStatusPending: '已加入全局，待验证',
        skillsStatusVerified: '已验证通用',
        skillsStatusUnknown: '状态未知',
        skillsBasisVersionUnknown: '历史加载版本未知',
        skillsBasisWorkspaceRecord: '个工作区有使用记录',
        skillsBasisSameContent: '个工作区当前内容相同',
        skillsBasisMarkers: '命中项目标识',
        skillsBasisNoMarkers: '未命中项目标识',
        skillsBasisTrigger: '有触发条件',
        skillsBasisSteps: '有操作步骤',
        skillsMarkerDrive: '路径',
        skillsMarkerWorkspace: '工作区名',
        skillsMarkerPackage: '本地包名',
        skillsMarkerHost: '内网地址',
        skillsMarkerPort: '本机端口',
        skillsPromotedTitle: '已加入全局（记录）',
        skillsScopeLedgerBroken: '状态账本不可读（文件已损坏），「已加入全局」的记录暂时看不到',
        skillsPromotedAt: '加入于',
        skillsPromotedHash: '指纹',
        skillsPromotedUsage: '使用记录（版本未知）',
        skillsPromotedChanged: '加入后内容已改动，历史使用无法对应版本',
        skillsPromotedMissing: '全局目录里没有这份副本',
        skillsGlobalizeConfirm: '确认加入全局',
        skillsIgnoredShow: '查看已忽略',
        skillsIgnoredHide: '收起已忽略',
        skillsIgnoredUnmatched: '当前已无对应技能',
        skillsPreview: '预览',
        skillsPreviewHide: '收起预览',
        skillsPreviewLoading: '读取中…',
        skillsPreviewFailed: '读取失败',
        skillsIgnore: '忽略',
        skillsIgnoreHint: '不再把这条列为可提升候选（落盘，跨会话生效）',
        skillsRestore: '恢复',
        skillsFilterSearch: '搜索技能名 / 工作区 / 描述',
        skillsFilterAllScopes: '全部来源',
        skillsFilterAllWorkspaces: '全部工作区',
        skillsFilterUnusedOnly: '只看未使用',
        skillsFilterEmpty: '当前筛选下没有技能',        skillsShowAll: '展开全部',
        skillsShowLess: '收起列表',
        skillsGlobalize: '加入全局',
        skillsDistillAction: '蒸馏',
        skillsTrash: '删除',
        skillsTrashConfirm: '确认删除',
        skillsTrashCancel: '取消',
        skillsWorking: '处理中…',
        skillsSuggestions: '自进化累计建议',
        skillsAdopted: '已采纳',
        skillsDistilledOk: '已蒸馏',
        skillsTrashedOk: '已移入回收站',
        skillsGlobalizedOk: '已加入全局',
        skillsIgnoredOk: '已忽略（跨会话生效）',
        skillsRestoredOk: '已恢复候选',
        skillsLedgerCleaned: '账本已清理 建议/草案/版本',
        skillsActionFailed: '操作失败',
        skillsNoop: '已经是合规形态，没有改动',
        zoomIn: '放大',
        zoomOut: '缩小',
        resetView: '复位视角',
        dragHint: '拖拽旋转 · 滚轮缩放',
        renderer: '渲染器',
        noticeNoWebgl2: '此环境不支持 WebGL 2，已使用 Canvas 渲染。',
        noticeBootMissing: '读不到启动清单（__DSH_BOOT__），已回退 Canvas。',
        noticeRevMissing: '启动清单里没有本包的版本号，已回退 Canvas。',
        noticeNotJavaScript: 'Three.js 分块返回的不是 JavaScript（可能落到首页兜底），已回退 Canvas。',
        noticeImportFailed: 'Three.js 分块加载失败，已回退 Canvas。',
        noticeNotThree: '分块内容不是 Three.js，已回退 Canvas。',
        noticeInitFailed: 'Three.js 初始化失败，已回退 Canvas。',
        noticeContextLost: 'WebGL 上下文丢失，已切换回 Canvas 渲染。',
        noticeHttp: 'Three.js 分块请求失败（HTTP），已回退 Canvas。',
        noticeUnknown: '渲染器降级，已使用 Canvas。',
        theme: '主题',
        accent: '强调色',
        spinStart: '开始缓慢旋转',
        spinStop: '暂停旋转',
        pulseStart: '开启动效（呼吸 / 涟漪 / 思绪）',
        pulseStop: '关闭动效',
        lastSession: '最近新建会话',
        regionLeft: '左半球',
        regionRight: '右半球',
        warningCodes: {
          'too-broad-root': '根目录过宽',
          'root-unavailable': '根目录不可读',
          'permission-denied': '目录无权限',
          'truncated-depth': '超出深度上限',
          'truncated-count': '超出数量上限',
          'timed-out': '扫描超时',
          'hidden-skipped': '已跳过隐藏目录',
        },
      },
      en: {
        title: 'Nascent Soul Sea',
        subtitle: 'One point per top-level folder',
        pickRoot: 'Choose root',
        rescan: 'Scan',
        refresh: 'Refresh',
        cancel: 'Cancel',
        scanning: 'Scanning…',
        progress: (done, total) => done + '/' + total + ' workspaces',
        preparing: 'Preparing…',
        progressAria: 'Scan progress',
        budgetDirs: 'Folders',
        budgetTime: 'Time',
        partialResult: 'Partial results',
        partialCount: (done, total) => done + '/' + total + ' workspaces scanned',
        limitDirs: (limit) => 'directory limit ' + limit + ' reached; remaining workspaces are listed without counting',
        limitTime: (seconds) => 'timed out at ' + seconds + 's; remaining workspaces were not scanned',
        limitDepth: (depth) => 'deeper than ' + depth + ' levels; nested folders were not counted',
        raiseBudget: 'raise maxDirs / timeoutMs in the plugin config',
        cancelledPartial: (done, total) => 'Scan cancelled · ' + done + '/' + total + ' workspaces scanned; the rest is missing.',
        searchPlaceholder: 'Search workspace names',
        clearSearch: 'Clear search',
        root: 'Root',
        noRoot: 'No root chosen',
        emptyNoRoot: 'No root chosen yet. Pick a local folder and every folder directly inside it becomes one point in the brain.',
        emptyNoWorkspaces: 'This root has no subfolders.',
        emptyTitle: 'Nothing to show',
        selectHint: 'Select a point for details, or search by name.',
        details: 'Details',
        noSelection: 'No workspace selected',
        path: 'Path',
        dirCount: 'Subfolders',
        clusterGroup: 'workspaces',
        clusterZoom: 'zoom in',
        magnifier: 'Magnifier',
        scannedAt: 'Scanned',
        status: 'Status',
        region: 'Region',
        copyPath: 'Copy path',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        statusReady: 'Ready',
        statusUnavailable: 'Unreadable',
        statusError: 'Error',
        partial: 'Partial',
        warnings: 'Warnings',
        noWarnings: 'No warnings',
        warningAffected: (count) => count + ' folders affected',
        warningMore: (count) => count + ' more kinds hidden',
        warningKinds: (count) => count + ' kinds',
        cancelled: 'Scan cancelled; showing the workspaces that finished.',
        scanFailed: 'Scan failed',
        missingApi: 'This panel cannot reach the directory service (uiWorkspace), so it cannot read local folders. Restart DSH or report this.',
        dimmed: 'Points that do not match the search are dimmed',
        countNodes: (n) => n + (n === 1 ? ' workspace' : ' workspaces'),
        countLow: 'few',
        countHigh: 'many',
        sessions: 'Sessions',
        lastSession: 'Newest session',
        skillsDistill: 'Skill distill',
        skillsDistillHint: 'Skills distilled per workspace, with real load counts',
        skillsSubtitle: 'Skills each workspace distilled, and how often they were really loaded',
        skillsLoading: 'Counting skills…',
        skillsFailed: 'Could not read skills',
        skillsRetry: 'Retry',
        skillsClose: 'Close',
        skillsEmpty: 'No workspace has distilled a skill yet',
        skillsWorkspaces: 'Workspaces with skills',
        skillsCount: 'Skills',
        skillsLoadsTotal: 'Skill loads',
        skillsUsed: 'Distinct skills used',
        skillsSessionsUsed: 'Sessions using skills',
        skillsUnusedTitle: 'Distilled but never used',
        skillsLoadsUnit: 'loads',
        skillsSessionsUnit: 'sessions',
        skillsNever: 'never used',
        skillsCurrent: 'this point',
        skillsScopeProject: 'project',
        skillsScopeUser: 'user',
        skillsEvolution: 'Evolution',
        skillsPending: 'pending',
        skillsGenerated: 'generated',
        skillsSessionsScanned: 'sessions',
        skillsExpandAll: 'Expand all',
        skillsCollapseAll: 'Collapse all',
        skillsRecommended: 'Project skills you could make global',
        skillsRecommendedEmpty: 'No project skill can be promoted right now',
        skillsHintNotVerdict: 'Heat only means "used often"; project markers are a hint, not a veto. You decide — nothing is promoted automatically.',
        skillsStatusProject: 'project-specific (hint)',
        skillsStatusPortable: 'portable, unverified',
        skillsStatusNeedsStructure: 'no structure or markers',
        skillsStatusPending: 'global, unverified',
        skillsStatusVerified: 'verified general',
        skillsStatusUnknown: 'unknown',
        skillsBasisVersionUnknown: 'loaded version unknown',
        skillsBasisWorkspaceRecord: 'workspaces with usage records',
        skillsBasisSameContent: 'workspaces share this content',
        skillsBasisMarkers: 'project markers',
        skillsBasisNoMarkers: 'no project markers',
        skillsBasisTrigger: 'has trigger conditions',
        skillsBasisSteps: 'has steps',
        skillsMarkerDrive: 'path',
        skillsMarkerWorkspace: 'workspace name',
        skillsMarkerPackage: 'local package',
        skillsMarkerHost: 'internal host',
        skillsMarkerPort: 'local port',
        skillsPromotedTitle: 'Made global (ledger)',
        skillsScopeLedgerBroken: 'Ledger unreadable (corrupt file); "made global" records are hidden for now',
        skillsPromotedAt: 'added',
        skillsPromotedHash: 'fingerprint',
        skillsPromotedUsage: 'usage records (version unknown)',
        skillsPromotedChanged: 'content changed after promotion; past usage cannot be tied to this version',
        skillsPromotedMissing: 'no copy in the global directory',
        skillsGlobalizeConfirm: 'Confirm make global',
        skillsIgnoredShow: 'Show ignored',
        skillsIgnoredHide: 'Hide ignored',
        skillsIgnoredUnmatched: 'no matching skill now',
        skillsPreview: 'Preview',
        skillsPreviewHide: 'Hide preview',
        skillsPreviewLoading: 'Loading…',
        skillsPreviewFailed: 'Preview failed',
        skillsIgnore: 'Ignore',
        skillsIgnoreHint: 'Stop listing this candidate (persisted across sessions)',
        skillsRestore: 'Restore',
        skillsFilterSearch: 'Search name / workspace / description',
        skillsFilterAllScopes: 'All sources',
        skillsFilterAllWorkspaces: 'All workspaces',
        skillsFilterUnusedOnly: 'Unused only',
        skillsFilterEmpty: 'No skills match these filters',        skillsShowAll: 'Show all',
        skillsShowLess: 'Collapse list',
        skillsGlobalize: 'Make global',
        skillsDistillAction: 'Distill',
        skillsTrash: 'Delete',
        skillsTrashConfirm: 'Confirm delete',
        skillsTrashCancel: 'Cancel',
        skillsWorking: 'Working…',
        skillsSuggestions: 'Suggestions',
        skillsAdopted: 'adopted',
        skillsDistilledOk: 'Distilled',
        skillsTrashedOk: 'Moved to trash',
        skillsGlobalizedOk: 'Copied to global',
        skillsIgnoredOk: 'Ignored (persisted)',
        skillsRestoredOk: 'Restored',
        skillsLedgerCleaned: 'Ledger cleaned (suggestions/drafts/versions)',
        skillsActionFailed: 'Action failed',
        skillsNoop: 'Already well-formed, nothing changed',
        sizeHint: 'size = sessions',
        satelliteHint: 'satellites = an aggregate of the session count, not individual sessions',
        archivedSessions: (count) => count + ' archived',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        resetView: 'Reset view',
        dragHint: 'drag to rotate · wheel to zoom',
        renderer: 'Renderer',
        noticeNoWebgl2: 'This environment has no WebGL 2, so the canvas renderer is in use.',
        noticeBootMissing: 'No boot manifest (__DSH_BOOT__) found; fell back to canvas.',
        noticeRevMissing: 'The boot manifest carries no revision for this package; fell back to canvas.',
        noticeNotJavaScript: 'The three.js chunk did not return JavaScript (SPA fallback?); fell back to canvas.',
        noticeImportFailed: 'Failed to load the three.js chunk; fell back to canvas.',
        noticeNotThree: 'The chunk was not three.js; fell back to canvas.',
        noticeInitFailed: 'three.js failed to initialise; fell back to canvas.',
        noticeContextLost: 'The WebGL context was lost; switched back to the canvas renderer.',
        noticeHttp: 'The three.js chunk request failed (HTTP); fell back to canvas.',
        noticeUnknown: 'Renderer fell back to canvas.',
        theme: 'Theme',
        accent: 'Accent colour',
        spinStart: 'Start slow orbit',
        spinStop: 'Pause orbit',
        pulseStart: 'Enable ambient motion',
        pulseStop: 'Disable ambient motion',
        regionLeft: 'Left hemisphere',
        regionRight: 'Right hemisphere',
        warningCodes: {
          'too-broad-root': 'Root too broad',
          'root-unavailable': 'Root unreadable',
          'permission-denied': 'Directory denied',
          'truncated-depth': 'Depth limit',
          'truncated-count': 'Count limit',
          'timed-out': 'Timed out',
          'hidden-skipped': 'Hidden folders skipped',
        },
      },
    }

    function dictFor(localeId) {
      return String(localeId || '').toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en
    }

    function readLocaleId(ctx) {
      try {
        const locale = ctx && ctx.locale
        if (locale) {
          const snapshot =
            typeof locale.getLocale === 'function' ? locale.getLocale()
              : typeof locale.getSnapshot === 'function' ? locale.getSnapshot()
                : null
          const id = snapshot && (snapshot.id || snapshot.locale || snapshot.current)
          if (typeof id === 'string' && id) return id
        }
      } catch {
        /* fall through to the browser language */
      }
      try {
        const language = window.navigator && window.navigator.language
        if (typeof language === 'string' && language) return language
      } catch {
        /* ignore */
      }
      return 'zh'
    }

    function useDict(ctx) {
      const [localeId, setLocaleId] = useState(() => readLocaleId(ctx))
      useEffect(() => {
        let dispose
        try {
          if (ctx && ctx.locale && typeof ctx.locale.subscribe === 'function') {
            dispose = ctx.locale.subscribe(() => setLocaleId(readLocaleId(ctx)))
          }
        } catch {
          /* ignore: the panel keeps the locale it started with */
        }
        return typeof dispose === 'function' ? dispose : undefined
      }, [ctx])
      return dictFor(localeId)
    }

    // ---------------------------------------------------------------------- [view]

    const PALETTE = {
      text: 'var(--dsw-alias-label-primary)',
      textSoft: 'var(--dsw-alias-label-secondary)',
      textFaint: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-base)',
      surfaceRaised: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const BRAIN_GLYPH =
      'M15.2 27.4c-2.9 0-5.2 2.3-5.2 5.2 0 2.2 1.4 4.1 3.4 4.9-.3.9-.4 1.8-.4 2.7 0 4.3 3.5 7.8 7.8 7.8 1 0 2-.2 2.9-.6 1.4 3.1 4.5 5.2 8.1 5.2 3.8 0 7.1-2.4 8.3-5.8.7.2 1.5.3 2.3.3 4.8 0 8.7-3.9 8.7-8.7 0-1.9-.6-3.6-1.6-5 1.9-1 3.2-3 3.2-5.3 0-3.3-2.6-5.9-5.9-5.9-.4 0-.9 0-1.3.1C45.1 15 39.7 10 33.2 10c-4.2 0-7.9 2.2-10 5.5-1-.4-2.1-.6-3.3-.6-4.6 0-8.4 3.5-8.9 8 2.4.6 4.2 2.7 4.2 5.3z'

    function createPanelIcon(ctx) {
      return function BrainWorkspacesPanelIcon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 64 64',
            fill: 'none',
            'aria-hidden': true,
            focusable: false,
            style: { display: 'block' },
          },
          h('path', {
            d: BRAIN_GLYPH,
            stroke: 'currentColor',
            strokeWidth: 3,
            strokeLinejoin: 'round',
          }),
        )
      }
    }

    /**
     * Scan status rides on shapes only (solid ring = ready, dashed = partial count,
     * hollow + dotted = unreadable), because the fill color already carries the count.
     */

    function formatTime(timestamp, localeId) {
      if (!timestamp) return '—'
      try {
        return new Date(timestamp).toLocaleString(localeId, { hour12: false })
      } catch {
        return new Date(timestamp).toISOString()
      }
    }

    /**
     * Details row for a workspace's sessions: `12`, or `12 · 已归档 3` once the Host measured the
     * archive set (P5.2). An unknown archive set (no registry in this profile, or a snapshot from
     * before P5.2) shows the plain count instead of inventing "已归档 0".
     */
    function sessionCountText(node, dict) {
      const total = Math.max(0, Math.floor(Number(node && node.sessionCount) || 0))
      const archived = Math.floor(Number(node && node.archivedSessionCount))
      if (!Number.isFinite(archived) || archived <= 0) return String(total)
      const label = dict && typeof dict.archivedSessions === 'function'
        ? dict.archivedSessions(archived)
        : archived + ' archived'
      return total + ' · ' + label
    }

    function renderEmptyState(dict, state) {
      const failure = state && state.failure
      const hasRoot = Boolean(state && state.hasRoot)
      const scanning = Boolean(state && state.scanning)
      const progress = state && state.progress
      const title = scanning ? dict.scanning : failure ? dict.scanFailed : dict.emptyTitle
      const body = scanning
        ? progress && progress.started
          ? dict.progress(Number(progress.done) || 0, Number(progress.declared) || 0)
          : dict.preparing
        : failure || (hasRoot ? dict.emptyNoWorkspaces : dict.emptyNoRoot)
      return h(
        'div',
        {
          style: {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 32,
            textAlign: 'center',
            color: PALETTE.textSoft,
          },
        },
        h(
          'div',
          { style: { fontSize: 15, fontWeight: 600, color: failure && !scanning ? PALETTE.error : PALETTE.text } },
          title,
        ),
        h('div', { style: { fontSize: 13, maxWidth: 460, lineHeight: 1.6 } }, body),
      )
    }

    // ------------------------------------------------------------ [scan progress ui]
    //
    // Three numbers, one bar. The bar fills with workspaces (the thing the user asked for),
    // and takes its colour from the directory budget (the thing that truncates results).
    // Text is derived by pure helpers so the wording is testable without a DOM.

    function formatCount(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0'
      return Math.round(number).toLocaleString('en-US')
    }

    function formatSeconds(ms) {
      return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1)
    }

    function progressRatios(progress) {
      const value = (key) => {
        const number = Number(progress && progress[key])
        return Number.isFinite(number) && number > 0 ? number : 0
      }
      const declared = value('declared')
      const maxDirs = value('maxDirs')
      const timeoutMs = value('timeoutMs')
      return {
        workspaces: declared > 0 ? Math.min(1, value('done') / declared) : 0,
        dirs: maxDirs > 0 ? Math.min(1, value('visitedDirs') / maxDirs) : 0,
        time: timeoutMs > 0 ? Math.min(1, value('elapsedMs') / timeoutMs) : 0,
      }
    }

    /** Amber from 80%, alert at 100%: early enough to warn, late enough not to cry wolf. */
    function budgetTone(ratio) {
      if (ratio >= 1) return 'alert'
      if (ratio >= 0.8) return 'warn'
      return 'calm'
    }

    function toneColor(tone) {
      if (tone === 'alert') return PALETTE.error
      if (tone === 'warn') return PALETTE.warn
      return PALETTE.brand
    }

    function progressLine(dict, progress) {
      const started = Boolean(progress && progress.started)
      const counts = started
        ? dict.progress(Number(progress.done) || 0, Number(progress.declared) || 0)
        : dict.preparing
      return dict.scanning + ' · ' + counts
    }

    function limitNoteText(dict, note) {
      if (!note || typeof note !== 'object') return ''
      if (note.kind === 'dirs') return dict.limitDirs(formatCount(note.limit))
      if (note.kind === 'time') return dict.limitTime(formatSeconds(note.limit))
      if (note.kind === 'depth') return dict.limitDepth(formatCount(note.limit))
      return ''
    }

    /** One sentence for an incomplete sweep; '' when the sweep was complete. */
    function partialNoticeText(dict, snapshot) {
      const scan = snapshot && snapshot.scan
      if (!scan || scan.partial !== true) return ''
      const parts = [
        dict.partialResult,
        dict.partialCount(formatCount(scan.scanned), formatCount(scan.declared || scan.scanned)),
      ]
      const limits = scan.limits || {}
      if (limits.dirs) parts.push(dict.limitDirs(formatCount(scan.maxDirs)))
      if (limits.time) parts.push(dict.limitTime(formatSeconds(scan.timeoutMs)))
      return parts.join(' · ')
    }

    function renderScanProgress(dict, progress) {
      const ratios = progressRatios(progress)
      const dirTone = budgetTone(ratios.dirs)
      const timeTone = budgetTone(ratios.time)
      const percent = Math.round(ratios.workspaces * 100)
      const notes = progress && Array.isArray(progress.limitNotes) ? progress.limitNotes : []
      const limitText = notes
        .map((note) => limitNoteText(dict, note))
        .filter(Boolean)
        .join(' · ')

      // Before the `start` line arrives neither budget is known; showing "0 / 0" would be noise.
      const chips = []
      if (Number(progress && progress.maxDirs) > 0) {
        chips.push(
          h(
            'span',
            { key: 'dirs', style: { color: toneColor(dirTone) } },
            dict.budgetDirs + ' ' + formatCount(progress.visitedDirs) + ' / ' + formatCount(progress.maxDirs),
          ),
        )
      }
      if (Number(progress && progress.timeoutMs) > 0) {
        chips.push(
          h(
            'span',
            { key: 'time', style: { color: toneColor(timeTone) } },
            dict.budgetTime + ' ' + formatSeconds(progress.elapsedMs) + 's / ' +
              formatSeconds(progress.timeoutMs) + 's',
          ),
        )
      }

      return h(
        'div',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 18px 9px',
            borderBottom: '1px solid ' + PALETTE.border,
          },
        },
        h('div', { style: { fontSize: 12, color: PALETTE.text } }, progressLine(dict, progress)),
        h(
          'div',
          {
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': percent,
            'aria-label': dict.progressAria,
            style: { height: 4, borderRadius: 2, background: PALETTE.border, overflow: 'hidden' },
          },
          h('div', {
            style: {
              width: percent + '%',
              height: '100%',
              background: toneColor(dirTone),
              transition: 'width 120ms linear',
            },
          }),
        ),
        chips.length > 0
          ? h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5 } }, chips)
          : null,
        limitText
          ? h('div', { style: { fontSize: 11.5, color: PALETTE.warn } }, limitText + ' · ' + dict.raiseBudget)
          : null,
      )
    }

    /** After a sweep ends without completing, this strip stays so the gap is not forgotten. */
    function renderPartialStrip(dict, snapshot) {
      const text = partialNoticeText(dict, snapshot)
      if (text === '') return null
      return h(
        'div',
        {
          role: 'status',
          style: {
            padding: '7px 18px',
            fontSize: 12,
            borderBottom: '1px solid ' + PALETTE.border,
            color: PALETTE.warn,
            background: PALETTE.surfaceRaised,
          },
        },
        text,
      )
    }

    // ------------------------------------------------------------- [canvas-renderer]
    //
    // Canvas 2D + a hand-written camera, the approach the referenced plugin takes. The
    // difference that makes it read as 3D is here: points live on an *ellipsoid shell*, not
    // on a flat plate, so the near hemisphere is visibly larger and brighter than the far
    // one, and orbiting the camera produces real parallax.
    //
    // Data placement stays deterministic: a bead's world position is a pure function of its
    // layout slot, so the same workspace is always the same point in space. Only the camera
    // moves, and it is persisted locally.

    const CAMERA_DEFAULT = Object.freeze({ yaw: -0.22, pitch: -0.42, zoom: 1, panX: 0, panY: 0 })
    const CAMERA_LIMITS = Object.freeze({ pitch: [-1.15, 1.15], zoom: [0.55, 4.5] })
    const CAMERA_STORAGE = 'dsh-brain-workspaces:camera:v1'
    function withAlpha(hex, alpha) {
      const value = String(hex).replace('#', '')
      const r = parseInt(value.slice(0, 2), 16)
      const g = parseInt(value.slice(2, 4), 16)
      const b = parseInt(value.slice(4, 6), 16)
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
    }

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

    /** Deterministic pseudo-random in [0, 1) from an integer seed. */
    function seeded(seed) {
      return mulberry32((Math.imul(seed + 1, 2654435761) >>> 0))()
    }

    /**
     * Push a flat layout point onto an ellipsoid shell.
     *
     * `nx`/`ny` come from the deterministic slot layout, so the planar footprint never
     * changes; only which hemisphere the point sits on and how far out it bulges. That keeps
     * "same workspace, same place" true while giving the cloud real front-to-back depth.
     */
    function projectPoint(point, camera, width, height) {
      const cy = Math.cos(camera.yaw)
      const sy = Math.sin(camera.yaw)
      const cx = Math.cos(camera.pitch)
      const sx = Math.sin(camera.pitch)

      const x1 = point.x * cy + point.z * sy
      const z1 = -point.x * sy + point.z * cy
      const y2 = point.y * cx - z1 * sx
      const z2 = point.y * sx + z1 * cx

      const perspective = 1.55 / (1.55 + z2 * 0.85 + 1.9)
      // Divisor, not a zoom: the disc used to fill only 33-44 % of the panel width (measured, 1200x760),
      // which left three empty margins and pushed neighbouring beads to 16.8 px. `/1.02` is about
      // +81 % and keeps the default camera untouched, so a persisted view never shifts; the disc
      // measures 0.59-0.76 W / 0.51-0.58 H from 900x640 up and stays inside the panel there.
      const scale = Math.min(width, height) / 1.02

      return {
        x: width / 2 + x1 * perspective * camera.zoom * scale + camera.panX,
        y: height / 2 + y2 * perspective * camera.zoom * scale + camera.panY,
        perspective,
        depth: z2,
      }
    }

    const spriteCache = new Map()

    /**
     * Glow sprite reused per ramp colour: far cheaper than a gradient per bead per frame.
     *
     * The gradient also takes the core tint, so the galaxy skin can whiten its centre like the
     * three shader does (`mix(vColor, white, coreWhiteMix)`) instead of showing a flat colour dot.
     */
    function beadSprite(color, coreColor) {
      const key = coreColor ? color + '|' + coreColor : color
      const cached = spriteCache.get(key)
      if (cached) return cached

      const size = 96
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const g = canvas.getContext('2d')
      const center = size / 2
      const inner = coreColor || color
      const gradient = g.createRadialGradient(center, center, 0, center, center, center)
      gradient.addColorStop(0, 'rgba(255,255,255,0.98)')
      gradient.addColorStop(0.18, withAlpha(inner, 0.92))
      gradient.addColorStop(0.5, withAlpha(color, 0.34))
      gradient.addColorStop(1, withAlpha(color, 0))
      g.fillStyle = gradient
      g.beginPath()
      g.arc(center, center, center, 0, Math.PI * 2)
      g.fill()

      spriteCache.set(key, canvas)
      return canvas
    }

    /**
     * P4 / magnifier — a small Canvas2D loupe over the pointer.
     *
     * It draws only the workspace light points (representatives), magnified about center by
     * actor, inside a square of size. Three stays the primary renderer for the main view; the
     * loupe is deliberately a plain 2D rasterisation: it answers "which of these two dots is
     * which", so fidelity of shading does not matter and a second WebGL context would be far too
     * expensive for it.
     *
     * Coordinates are CSS pixels relative to the main canvas. The radius follows eadHitRadius,
     * so what the loupe shows is exactly what a click would pick.
     */
    function drawLoupe(g, scene, center, factor, size) {
      if (!g || !scene) return
      const scale = Number.isFinite(factor) && factor > 0 ? factor : 2.5
      const side = Number.isFinite(size) && size > 0 ? size : 220
      const half = side / 2
      const beads = Array.isArray(scene.representatives)
        ? scene.representatives
        : Array.isArray(scene.beads)
          ? scene.beads
          : []
      g.clearRect(0, 0, side, side)
      for (const bead of beads) {
        if (!bead || !Number.isFinite(bead.x) || !Number.isFinite(bead.y)) continue
        const x = half + (bead.x - center.x) * scale
        const y = half + (bead.y - center.y) * scale
        const reach = Math.max(2, Number(bead.radius) || 2) * scale
        if (x < -reach || y < -reach || x > side + reach || y > side + reach) continue
        const glow = reach * (GALAXY_CANVAS_STYLE.glowDiameter / 2)
        const core = bead.unreadable
          ? withAlpha(bead.color, 0.28)
          : mixHex(bead.color, '#ffffff', GALAXY_CANVAS_STYLE.coreWhiteMix)
        g.globalAlpha = bead.dimmed ? 0.18 : 1
        g.drawImage(beadSprite(bead.color, core), x - glow, y - glow, glow * 2, glow * 2)
        g.fillStyle = core
        g.beginPath()
        g.arc(x, y, Math.max(1.4, reach * GALAXY_CANVAS_STYLE.coreScale), 0, Math.PI * 2)
        g.fill()
        // hit radius, so the loupe shows the clickable area, not just the glow
        g.strokeStyle = withAlpha(bead.color, 0.35)
        g.lineWidth = 1
        g.beginPath()
        g.arc(x, y, beadHitRadius(bead.radius) * scale, 0, Math.PI * 2)
        g.stroke()
      }
      g.globalAlpha = 1
      return side
    }
    function roundedPath(g, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2)
      g.beginPath()
      g.moveTo(x + r, y)
      g.lineTo(x + width - r, y)
      g.quadraticCurveTo(x + width, y, x + width, y + r)
      g.lineTo(x + width, y + height - r)
      g.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
      g.lineTo(x + r, y + height)
      g.quadraticCurveTo(x, y + height, x, y + height - r)
      g.lineTo(x, y + r)
      g.quadraticCurveTo(x, y, x + r, y)
      g.closePath()
    }

    /**
     * Screen-space extent of the galaxy disc, measured by projecting its own rim.
     *
     * This is the fix for the round-five P0: the stage rings used a *damped* zoom (35 % of the
     * zoom delta) while the disc scales linearly with zoom, so from ~1.1x on the disc burst out of
     * the frame (measured disc/ring = 1.16 at 1.5625x, 1.29 at 1.9x). Deriving the frame from the
     * disc's real projection makes the two share one scale factor by construction: whatever the
     * camera and the zoom, the ring is a fixed margin outside the disc.
     *
     * Sampled from the disc *plane* rather than from the workspace set, so adding or removing a
     * workspace can never make the frame jump.
     *
     * @param {(point: {x:number,y:number,z:number}) => {x:number,y:number}} project
     * @param {{radius?:number,tilt?:number,samples?:number}} [options]
     * @returns {{cx:number, cy:number, halfWidth:number, halfHeight:number} | null}
     */
    function galaxyDiscExtent(project, options) {
      if (typeof project !== 'function') return null
      const tuning = options || {}
      const radius = Number(tuning.radius) || GALAXY.radius
      const tilt = Number.isFinite(tuning.tilt) ? tuning.tilt : GALAXY.tilt
      const samples = Math.max(8, Math.floor(Number(tuning.samples) || 24))
      const cosTilt = Math.cos(tilt)
      const sinTilt = Math.sin(tilt)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let index = 0; index < samples; index += 1) {
        const angle = (index / samples) * Math.PI * 2
        const a = radius * Math.cos(angle)
        const b = radius * Math.sin(angle)
        const projected = project({ x: a, y: b * cosTilt, z: b * sinTilt })
        if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue
        if (projected.x < minX) minX = projected.x
        if (projected.x > maxX) maxX = projected.x
        if (projected.y < minY) minY = projected.y
        if (projected.y > maxY) maxY = projected.y
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) return null
      return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        halfWidth: (maxX - minX) / 2,
        halfHeight: (maxY - minY) / 2,
      }
    }

    /**
     * Galaxy frame: two very faint ellipses derived from `galaxyDiscExtent`, so they always frame
     * the disc at every zoom level. No beam, no horizon, no sea ripples — the frame only gives the
     * disc a scale.
     *
     * @param {number} width canvas CSS width
     * @param {number} height canvas CSS height
     * @param {{cx:number,cy:number,halfWidth:number,halfHeight:number}|null} extent
     */
    function galaxyStageFor(width, height, extent) {
      if (!(width > 0) || !(height > 0) || !extent) return { rings: [], scale: 1 }
      const margin = GALAXY_STYLE.ringMargin
      const rings = GALAXY_STYLE.ringScales.map((factor, index) => ({
        cx: extent.cx,
        cy: extent.cy,
        rx: extent.halfWidth * margin * factor,
        ry: extent.halfHeight * margin * factor,
        rotation: 0,
        alpha: GALAXY_STYLE.ringAlphas[index] || 0.05,
        width: 1,
      }))
      return { rings, scale: 1 }
    }

    const backingStore = new WeakMap()

    function ensureBackingStore(canvas, width, height, dpr) {
      const pixelWidth = Math.round(width * dpr)
      const pixelHeight = Math.round(height * dpr)
      const last = backingStore.get(canvas)
      if (last && last.pixelWidth === pixelWidth && last.pixelHeight === pixelHeight) return
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      backingStore.set(canvas, { pixelWidth, pixelHeight })
    }

    /**
     * Paint one frame.
     *
     * Returns `false` when the canvas has no layout box yet instead of returning silently: a
     * skipped first frame is exactly the "only the workspace names show up" blank panel, and the
     * caller needs a value it can act on (see `createCanvasRenderer`'s single retry).
     */
    function drawScene(canvas, scene) {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return false

      ensureBackingStore(canvas, width, height, dpr)
      const g = canvas.getContext('2d')
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, width, height)

      const camera = scene.camera
      const theme = scene.theme || THEMES[0]

      // backdrop
      const backdrop = g.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, Math.max(width, height) * 0.74)
      backdrop.addColorStop(0, theme.backdropInner)
      backdrop.addColorStop(0.62, theme.backdropMid)
      backdrop.addColorStop(1, theme.backdropEdge)
      g.fillStyle = backdrop
      roundedPath(g, 0, 0, width, height, 24)
      g.fill()

      // volumetric core glow behind the cloud
      const core = g.createRadialGradient(width * 0.5, height * 0.48, 0, width * 0.5, height * 0.48, Math.min(width, height) * 0.46)
      core.addColorStop(0, withAlpha(theme.core, 0.18))
      core.addColorStop(0.5, withAlpha(theme.core, 0.09))
      core.addColorStop(1, withAlpha(theme.core, 0))
      g.fillStyle = core
      g.fillRect(0, 0, width, height)

      // One soft core plus one wide halo, both centred: the sky has no hemispheres to tint.
      for (const haze of [
        { radius: Math.min(width, height) * 0.26, color: theme.meshLeft, alpha: 0.12 },
        { radius: Math.min(width, height) * 0.62, color: theme.meshRight, alpha: 0.07 },
      ]) {
        const cloud = g.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, haze.radius)
        cloud.addColorStop(0, withAlpha(haze.color, haze.alpha))
        cloud.addColorStop(0.55, withAlpha(haze.color, haze.alpha * 0.4))
        cloud.addColorStop(1, withAlpha(haze.color, 0))
        g.fillStyle = cloud
        g.fillRect(0, 0, width, height)
      }

      // P5 galaxy structure: gas band → bulge → halo → dust. All of it is artwork with a fixed
      // sample count (never derived from the workspace set), it is never a hit target, and every
      // layer stays BELOW the stage rings and the workspace beads so both remain clearly
      // readable. The three renderer draws the same data as one haze quad + two batches.
      const background = scene.background
      if (background) {
        g.globalAlpha = 1
        g.setLineDash([])
        const gasColor = theme.rimColor || '#cdd9ff'
        const bulgeColor = mixHex(theme.core || '#7aa2ff', '#ffffff', 0.35)

        // gas: at most three elliptical gradients — one connected band along the disc
        if (background.gas && Array.isArray(background.gas.clouds)) {
          for (const cloud of background.gas.clouds) {
            const alpha = clamp(Number(cloud.alpha) || 0, 0, 0.2)
            if (alpha <= 0.004 || !(cloud.rx > 0.5) || !(cloud.ry > 0.5)) continue
            g.save()
            g.translate(cloud.x, cloud.y)
            g.scale(1, Math.max(0.08, cloud.ry / cloud.rx))
            const glow = g.createRadialGradient(0, 0, 0, 0, 0, cloud.rx)
            glow.addColorStop(0, withAlpha(gasColor, alpha))
            glow.addColorStop(0.55, withAlpha(gasColor, alpha * 0.4))
            glow.addColorStop(1, withAlpha(gasColor, 0))
            g.fillStyle = glow
            g.beginPath()
            g.arc(0, 0, cloud.rx, 0, Math.PI * 2)
            g.fill()
            g.restore()
          }
        }

        // bulge: one continuous centre gradient — never two overlapping "clouds"
        if (background.bulge && background.bulge.radius > 0.5) {
          const bulge = background.bulge
          const alpha = clamp(Number(bulge.alpha) || 0, 0, 0.3)
          const core = g.createRadialGradient(bulge.cx, bulge.cy, 0, bulge.cx, bulge.cy, bulge.radius)
          core.addColorStop(0, withAlpha(bulgeColor, alpha))
          core.addColorStop(0.5, withAlpha(bulgeColor, alpha * 0.42))
          core.addColorStop(1, withAlpha(bulgeColor, 0))
          g.fillStyle = core
          g.beginPath()
          g.arc(bulge.cx, bulge.cy, bulge.radius, 0, Math.PI * 2)
          g.fill()
        }

        // halo: sparse, faint, outside the disc — one loop, never a bright outer ring
        if (Array.isArray(background.halo)) {
          for (const star of background.halo) {
            const alpha = clamp(Number(star.alpha) || 0, 0, 0.2)
            if (alpha <= 0.01 || !Number.isFinite(star.x) || !Number.isFinite(star.y)) continue
            g.fillStyle = withAlpha('#c8d6ff', alpha)
            g.beginPath()
            g.arc(star.x, star.y, Math.max(0.5, (Number(star.radius) || 1) / 2), 0, Math.PI * 2)
            g.fill()
          }
        }

        // dust: short dark streaks inside the disc. Canvas keeps at most 48 of the 96 samples
        // (the contract allows the fallback to simplify); three draws all of them in one batch.
        if (Array.isArray(background.dust) && background.dust.length > 0) {
          const bands = background.dust.length > 48 ? background.dust.slice(0, 48) : background.dust
          g.lineWidth = 1
          for (const band of bands) {
            const alpha = clamp(Number(band.alpha) || 0, 0, 0.2)
            if (alpha <= 0.01 || !(band.length > 0.5)) continue
            const half = band.length / 2
            const dx = Math.cos(band.angle) * half
            const dy = Math.sin(band.angle) * half
            g.strokeStyle = withAlpha(theme.backdropEdge || '#04060c', alpha)
            g.beginPath()
            g.moveTo(band.x - dx, band.y - dy)
            g.lineTo(band.x + dx, band.y + dy)
            g.stroke()
          }
        }

        // explicit reset: no background state may leak into the foreground layers
        g.globalAlpha = 1
        g.setLineDash([])
        g.lineWidth = 1
      }

      // stage rings: the galaxy frame, drawn from the projected disc extent
      if (scene.stage && Array.isArray(scene.stage.rings)) {
        for (const ring of scene.stage.rings) {
          g.beginPath()
          g.ellipse(ring.cx, ring.cy, ring.rx, ring.ry, ring.rotation, 0, Math.PI * 2)
          g.strokeStyle = withAlpha(theme.rimColor || '#cdd9ff', Math.max(0.02, Math.min(1, ring.alpha)))
          g.lineWidth = ring.width
          g.stroke()
        }
      }

      // background star field: tiny, dim, never a hit target
      if (Array.isArray(scene.stars)) {
        // P3: far first, then near (the three renderer uses two batches with orders 2 / 3), and
        // the diameter comes from GALAXY_CANVAS_STYLE so both renderers agree on star size.
        for (const layer of ['far', 'near']) {
          const starDiameter = layer === 'near' ? GALAXY_CANVAS_STYLE.starSize[1] : GALAXY_CANVAS_STYLE.starSize[0]
          for (const star of scene.stars) {
            if (!star) continue
            if ((star.layer === 'near' ? 'near' : 'far') !== layer) continue
            const alpha = Math.max(0, Math.min(1, Number(star.alpha) || 0)) * (0.6 + 0.4 * (Number(star.perspective) || 0.45))
            if (alpha <= 0.01) continue
            g.fillStyle = withAlpha(layer === 'near' ? '#dfe8ff' : '#aec2ea', Math.min(0.6, alpha))
            g.beginPath()
            g.arc(star.x, star.y, starDiameter / 2, 0, Math.PI * 2)
            g.fill()
          }
        }
      }

      // P5.4 orbital tracks: a dotted arc of each star's own orbit around the disc centre, the
      // faintest foreground layer — drawn before the wakes and the stars.
      if (Array.isArray(scene.orbits) && scene.orbits.length > 0) {
        for (const orbit of scene.orbits) {
          const particles = orbit && orbit.particles
          if (!Array.isArray(particles) || particles.length === 0) continue
          const color = orbit.color || '#cfe0ff'
          for (const dot of particles) {
            const alpha = clamp(Number(dot.alpha) || 0, 0, 0.5)
            if (alpha <= 0.005) continue
            g.fillStyle = withAlpha(color, alpha)
            g.beginPath()
            g.arc(dot.x, dot.y, Math.max(0.4, Number(dot.radius) || 0.4), 0, Math.PI * 2)
            g.fill()
          }
        }
        g.globalAlpha = 1
      }

      // P5.3 star wakes: a stream of grains per star, each fading and shrinking as it falls behind.
      // Drawn before the satellites and the stars, so a wake always sits under its own light point.
      if (Array.isArray(scene.trails) && scene.trails.length > 0) {
        for (const trail of scene.trails) {
          const particles = trail && trail.particles
          if (!Array.isArray(particles) || particles.length === 0) continue
          const color = trail.color || '#cfe0ff'
          for (const grain of particles) {
            const alpha = clamp(Number(grain.alpha) || 0, 0, 0.8)
            if (alpha <= 0.01) continue
            g.fillStyle = withAlpha(color, alpha)
            g.beginPath()
            g.arc(grain.x, grain.y, Math.max(0.45, Number(grain.radius) || 0.45), 0, Math.PI * 2)
            g.fill()
          }
        }
        g.globalAlpha = 1
      }

      // P5.1 session satellites: one small dot per glyph, drawn BEFORE its star so the star core
      // always wins. Fixed cost per visible workspace (≤ 6), no per-session expansion, and never
      // part of the hit-test / button set. Colour is the workspace's own ramp colour, dimmed.
      if (Array.isArray(scene.satellites) && scene.satellites.length > 0) {
        for (const glyph of scene.satellites) {
          const alpha = clamp(Number(glyph.alpha) || 0, 0, 0.6)
          if (alpha <= 0.01) continue
          const reach = Math.max(0.6, Number(glyph.radius) || 0.6)
          g.fillStyle = withAlpha(glyph.color || '#cfe0ff', alpha)
          g.beginPath()
          g.arc(glyph.x, glyph.y, reach, 0, Math.PI * 2)
          g.fill()
        }
      }

      // workspace beads: far to near, sized and dimmed by depth
      const ordered = (scene.representatives || scene.beads).slice().sort((a, b) => b.depth - a.depth)
      for (const bead of ordered) {
        const fog = clamp(
          GALAXY_CANVAS_STYLE.alphaFloor + GALAXY_CANVAS_STYLE.alphaGain * (bead.perspective / 0.62),
          0.22,
          1,
        )
        const alpha = bead.dimmed ? 0.16 : fog
        const radius = Math.max(2, bead.radius * (0.5 + bead.perspective * 1.15))
        bead.screenRadius = radius
        const glowRadius = radius * (GALAXY_CANVAS_STYLE.glowDiameter / 2)
        const coreColor = bead.unreadable ? bead.color : mixHex(bead.color, '#ffffff', GALAXY_CANVAS_STYLE.coreWhiteMix)

        g.globalAlpha = alpha
        g.drawImage(beadSprite(bead.color, coreColor), bead.x - glowRadius, bead.y - glowRadius, glowRadius * 2, glowRadius * 2)
        g.fillStyle = bead.unreadable ? withAlpha(bead.color, 0.28) : coreColor
        g.beginPath()
        g.arc(bead.x, bead.y, Math.max(1.4, radius * GALAXY_CANVAS_STYLE.coreScale), 0, Math.PI * 2)
        g.fill()

        // a slow halo on the star itself, only for workspaces with real activity data.
        // Phase comes from the stable workspace id, so it never reshuffles between renders.
        if (scene.motion && bead.active) {
          const seed = parseInt(hashId(String(bead.id)).slice(0, 8), 16) || 0
          const wave = 0.5 + 0.5 * Math.sin((Number(scene.clock) || 0) * GALAXY_STYLE.pulseSpeed + (seed % 628318) / 100000)
          g.strokeStyle = withAlpha(bead.color, GALAXY_CANVAS_STYLE.activityAlpha * (1 - wave))
          g.lineWidth = 1
          g.beginPath()
          g.arc(
            bead.x,
            bead.y,
            radius * (GALAXY_CANVAS_STYLE.activityRing[0] + GALAXY_CANVAS_STYLE.activityRing[1] * wave),
            0,
            Math.PI * 2,
          )
          g.stroke()
        }

        // activity marker only: a thin fixed-length cross for workspaces with real activity.
        // The length no longer follows the session count — size already carries that.
        if (bead.active) {
          const flare = radius * GALAXY_CANVAS_STYLE.flareLength
          g.strokeStyle = withAlpha('#ffffff', GALAXY_CANVAS_STYLE.flareAlpha)
          g.lineWidth = GALAXY_CANVAS_STYLE.flareWidth
          g.beginPath()
          g.moveTo(bead.x - flare, bead.y)
          g.lineTo(bead.x + flare, bead.y)
          g.moveTo(bead.x, bead.y - flare)
          g.lineTo(bead.x, bead.y + flare)
          g.stroke()
        }
        if (bead.selected || bead.hovered || bead.focused || bead.ringDash) {
          g.strokeStyle = bead.selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)'
          g.lineWidth = bead.selected ? 1.9 : 1
          g.setLineDash(bead.ringDash || [])
          g.beginPath()
          g.arc(bead.x, bead.y, radius + (bead.selected ? 4.5 : 2.5), 0, Math.PI * 2)
          g.stroke()
          g.setLineDash([])
        }
        g.globalAlpha = 1
      }

      g.restore()
      return true
    }

    function readCamera() {
      try {
        const raw = window.localStorage.getItem(CAMERA_STORAGE)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && Number.isFinite(parsed.yaw) && Number.isFinite(parsed.pitch)) {
            return {
              yaw: parsed.yaw,
              pitch: clamp(parsed.pitch, CAMERA_LIMITS.pitch[0], CAMERA_LIMITS.pitch[1]),
              zoom: clamp(Number(parsed.zoom) || 1, CAMERA_LIMITS.zoom[0], CAMERA_LIMITS.zoom[1]),
              panX: Number(parsed.panX) || 0,
              panY: Number(parsed.panY) || 0,
            }
          }
        }
      } catch {
        /* storage disabled: fall back to the default camera */
      }
      return Object.assign({}, CAMERA_DEFAULT)
    }

    function writeCamera(camera) {
      try {
        window.localStorage.setItem(CAMERA_STORAGE, JSON.stringify(camera))
      } catch {
        /* ignore */
      }
    }

    /**
     * Whether a pointerdown may start a camera drag.
     *
     * Beads are real buttons: a drag (especially one with pointer capture) would retarget
     * the click to the container and swallow the selection, so presses on a bead must never
     * start a drag. Extracted so the rule is testable without a DOM.
     */
    function shouldStartDrag(target) {
      if (!target || typeof target.closest !== 'function') return true
      return target.closest('[data-brain-bead]') === null
    }

    const VIEW_STORAGE = 'dsh-brain-workspaces:view:v1'

    function readViewSettings() {
      const fallback = {
        themeId: 'nebula',
        accent: '',
        spinning: false,
        pulses: !prefersReducedMotion(),
        renderer: 'auto',
      }
      try {
        const raw = window.localStorage.getItem(VIEW_STORAGE)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return {
          themeId: themeById(parsed && parsed.themeId).id,
          accent: typeof parsed.accent === 'string' ? parsed.accent : '',
          spinning: Boolean(parsed && parsed.spinning),
          pulses: parsed && typeof parsed.pulses === 'boolean' ? parsed.pulses : fallback.pulses,
          renderer: ['auto', 'canvas', 'three'].includes(parsed && parsed.renderer) ? parsed.renderer : 'auto',
        }
      } catch {
        return fallback
      }
    }

    function writeViewSettings(settings) {
      try {
        window.localStorage.setItem(VIEW_STORAGE, JSON.stringify(settings))
      } catch {
        /* ignore */
      }
    }

    // ---------------------------------------------------------------- [activity]
    //
    // "Recently active" = the newer of two real timestamps we already hold: the workspace
    // directory's mtime, and the creation time of its newest stored session. There is no
    // session *activity* timestamp in the persistence layer, and reading event logs to
    // fabricate one would break the plugin's read-only boundary — so the UI says
    // "最近活动（改动或新建会话）" and never claims "最近对话过".

    const PULSE_TOP_FRACTION = 0.3
    const PULSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

    function activityFor(node) {
      if (!node) return 0
      const fileTime = Number(node.modifiedAt) || 0
      const sessionTime = Number(node.lastSessionAt) || 0
      return Math.max(fileTime, sessionTime)
    }

    /** Activity ratio in [0, 1]; a single active workspace reads as the most active one. */
    function normalizeActivity(nodes) {
      const entries = []
      const ratios = new Map()
      let min = Infinity
      let max = -Infinity

      for (const node of nodes || []) {
        if (!node || typeof node.id !== 'string') continue
        const value = activityFor(node)
        entries.push({ id: node.id, value })
        if (value > 0) {
          if (value < min) min = value
          if (value > max) max = value
        }
      }

      for (const entry of entries) {
        if (entry.value <= 0) ratios.set(entry.id, 0)
        else if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) ratios.set(entry.id, 1)
        else ratios.set(entry.id, (entry.value - min) / (max - min))
      }
      return ratios
    }

    /**
     * Workspaces that deserve a pulse: the most recently active 30% among those touched
     * inside the window, at least one.
     *
     * Rank-based on purpose. A ratio threshold would silence everything whenever several
     * workspaces were touched within minutes of each other (only the single newest would
     * clear 0.7), which reads as "nothing is happening" exactly when a lot is.
     */
    function pulseTargets(nodes, now) {
      const current = Number(now) || Date.now()
      const candidates = []

      for (const node of nodes || []) {
        if (!node || typeof node.id !== 'string') continue
        const activity = activityFor(node)
        if (activity <= 0) continue
        if (current - activity >= PULSE_WINDOW_MS) continue
        candidates.push({ id: node.id, activity })
      }
      if (candidates.length === 0) return []

      candidates.sort((a, b) => b.activity - a.activity)
      const take = Math.max(1, Math.ceil(candidates.length * PULSE_TOP_FRACTION))
      const ratios = normalizeActivity(nodes)

      return candidates.slice(0, take).map((candidate) => ({
        id: candidate.id,
        ratio: ratios.get(candidate.id) || 0,
      }))
    }

    // Read once: the renderer asks this on every animated frame, and matchMedia is not free.
    let reducedMotionMemo = null

    function prefersReducedMotion() {
      if (reducedMotionMemo !== null) return reducedMotionMemo
      try {
        reducedMotionMemo = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      } catch {
        reducedMotionMemo = false
      }
      return reducedMotionMemo
    }

    // ----------------------------------------------------------------- [renderer]
    //
    // Two interchangeable renderers behind one interface. Both consume the *same* precomputed
    // scene (screen-space beads/fibres/stage produced by `projectPoint`), so hit testing and
    // the DOM button layer stay pixel-aligned no matter which one draws.
    //
    // Interface (see contracts/renderer.d.ts):
    //   kind, mount(container, props), update({ scene, clock }), resize(w, h, dpr),
    //   hitTest(x, y), destroy()
    //
    // `update` takes the clock separately on purpose: during animation the scene identity is
    // stable and only the clock moves, so a renderer must not rebuild geometry every frame.

    const OWN_PACKAGE_ID = 'dsh-hncsd'
    const THREE_CHUNK_FILE = 'client.three.js'

    /** Nearest bead under a screen point, honouring each bead's drawn radius. */
    /**
     * P4 / 4a — which workspace buttons exist in the DOM.
     *
     * Up to `DOM_VIRTUALIZE_FROM` workspaces every bead gets a button, exactly like before P4:
     * Tab walks the workspaces one by one. Above that, only reachable beads get a node — inside
     * the viewport (plus a margin), plus whatever is selected, hovered, focused or matched by
     * the search box. Everything else stays a render-layer bead: still drawn, still hit-testable
     * through `pickBeadAt`, still reachable through search. It just has no DOM node.
     *
     * Members are never modified: the returned objects are the same references, so no bead can
     * move because of this function.
     */
    const DOM_VIRTUALIZE_FROM = 40
    const DOM_VIEWPORT_MARGIN = 64
    /**
     * Hard cap on mounted buttons. A viewport can contain hundreds of beads at 1×; without a cap
     * the DOM node count (and every React reconcile) grows back to the pre-P4 number. Priority:
     * selected/hovered/focused, then search hits, then the rest in slot order. A bead that is
     * visible but past the cap keeps its light point and stays clickable through `pickBeadAt` —
     * it just has no button (search reaches it).
     */
    const DOM_BUTTON_LIMIT = 120

    function buttonsToMount(beads, options) {
      const list = Array.isArray(beads) ? beads : []
      const settings = options || {}
      const limit = Number.isFinite(settings.virtualizeFrom) ? settings.virtualizeFrom : DOM_VIRTUALIZE_FROM
      if (list.length <= limit) return list.slice()
      const width = Number(settings.width) || 0
      const height = Number(settings.height) || 0
      const margin = Number.isFinite(settings.margin) ? settings.margin : DOM_VIEWPORT_MARGIN
      const cap = Number.isFinite(settings.buttonLimit) ? settings.buttonLimit : DOM_BUTTON_LIMIT
      const pinned = new Set()
      for (const id of [settings.selectedId, settings.hoverId, settings.focusId]) {
        if (typeof id === 'string') pinned.add(id)
      }
      const searchActive = settings.searchActive === true
      const first = []
      const rest = []
      for (const bead of list) {
        if (!bead || typeof bead.id !== 'string') continue
        const inViewport =
          bead.x >= -margin && bead.x <= width + margin && bead.y >= -margin && bead.y <= height + margin
        const isHit = searchActive && !bead.dimmed
        if (pinned.has(bead.id) || isHit) first.push(bead)
        else if (inViewport) rest.push(bead)
      }
      const merged = first.concat(rest)
      return merged.length <= cap ? merged : merged.slice(0, Math.max(cap, first.length))
    }

    /**
     * Roving tabindex neighbour inside the mounted list (P4 / 4a).
     * Wraps at both ends; an unknown current id starts at the first (step > 0) or last item.
     */
    function rovingNeighbour(beads, currentId, step) {
      const list = Array.isArray(beads) ? beads : []
      if (list.length === 0) return null
      const direction = step < 0 ? -1 : 1
      const index = list.findIndex((bead) => bead && bead.id === currentId)
      if (index < 0) return direction > 0 ? list[0] : list[list.length - 1]
      const next = (index + direction + list.length) % list.length
      return list[next]
    }

    /**
     * P4 / 3 — semantic-zoom clustering.
     *
     * Above the density at which single pixels stop being distinguishable a bead stops being a
     * target: at 200 workspaces the nearest pair is 2.1 px apart while a button is 22 px. Instead
     * of moving any workspace (the slot index and its coordinates are frozen), nearby beads are
     * collapsed into one *representative*: the marker is drawn at the members' centroid and the
     * members keep their own `x/y/slot` untouched.
     *
     * Determinism: a single pass in slot order, every candidate compared against its cluster's
     * SEED (never a running centroid), so the result depends only on the bead list. Pinned beads
     * (selected / hovered / focused / search hits) are `locked` and never merged — search can
     * always reach an individual workspace.
     *
     * Two levels at most: 500 beads at 1× otherwise merge into a single blob.
     *
     * CLUSTER_GAP = 14 is the largest value that leaves a 33-workspace scene untouched at a
     * 900x640 viewport (its nearest pair is 14.13 px) — the low-density contract. Measured
     * representatives at 900x640: 120 → 81, 200 → 92, 500 → 124.
     */
    const CLUSTER_GAP = 14
    const CLUSTER_MAX_LEVELS = 2

    function clusterBeads(beads, options) {
      const list = (Array.isArray(beads) ? beads : []).filter((bead) => bead && typeof bead.id === 'string')
      const settings = options || {}
      const gap = Number.isFinite(settings.gap) ? settings.gap : CLUSTER_GAP
      const maxLevels = Math.max(1, Math.min(4, Math.floor(Number(settings.maxLevels) || CLUSTER_MAX_LEVELS)))
      const locked = new Set()
      for (const id of [settings.selectedId, settings.hoverId, settings.focusId]) {
        if (typeof id === 'string') locked.add(id)
      }
      const searchActive = settings.searchActive === true

      let nodes = list.map((bead) => ({
        ids: [bead.id],
        members: [bead],
        x: bead.x,
        y: bead.y,
        radius: Math.max(2, Number(bead.radius) || 2),
        locked: locked.has(bead.id) || (searchActive && bead.dimmed === false),
      }))

      for (let level = 0; level < maxLevels; level += 1) {
        if (nodes.length <= 1) break
        const merged = []
        const used = new Array(nodes.length).fill(false)
        for (let index = 0; index < nodes.length; index += 1) {
          if (used[index]) continue
          used[index] = true
          const seed = nodes[index]
          const group = [seed]
          if (!seed.locked) {
            for (let other = index + 1; other < nodes.length; other += 1) {
              if (used[other]) continue
              const candidate = nodes[other]
              if (candidate.locked) continue
              if (Math.hypot(candidate.x - seed.x, candidate.y - seed.y) <= gap) {
                used[other] = true
                group.push(candidate)
              }
            }
          }
          if (group.length === 1) {
            merged.push(seed)
            continue
          }
          let sumX = 0
          let sumY = 0
          let radius = 0
          const ids = []
          const members = []
          for (const node of group) {
            sumX += node.x * node.ids.length
            sumY += node.y * node.ids.length
            for (const member of node.members) members.push(member)
            for (const id of node.ids) ids.push(id)
            radius = Math.max(radius, node.radius)
          }
          const weight = members.length || 1
          merged.push({
            ids,
            members,
            x: sumX / weight,
            y: sumY / weight,
            radius,
            locked: false,
          })
        }
        nodes = merged
        if (nodes.length === list.length) break
      }

      const representatives = []
      const clusters = []
      for (const node of nodes) {
        if (node.members.length === 1) {
          representatives.push(node.members[0])
          continue
        }
        const memberIds = node.members.map((bead) => bead.id)
        const dominant = node.members.reduce(
          (best, bead) => (Math.max(2, Number(bead.radius) || 2) > Math.max(2, Number(best.radius) || 2) ? bead : best),
          node.members[0],
        )
        const cluster = {
          id: 'cluster:' + memberIds.slice().sort().join(','),
          cluster: true,
          count: memberIds.length,
          memberIds,
          x: node.x,
          y: node.y,
          radius: node.radius,
          color: dominant.color,
          dimmed: node.members.every((bead) => bead.dimmed === true),
          active: node.members.some((bead) => bead.active === true),
          node: dominant.node,
        }
        representatives.push(cluster)
        clusters.push(cluster)
      }
      return { representatives, clusters }
    }

    /**
     * Click target size, in CSS pixels. The DOM button and the hit test must be the same number:
     * two different numbers is how a bead becomes "visually there but impossible to click".
     */
    const BEAD_BUTTON_MIN = 22

    function beadButtonSize(radius) {
      return Math.max(BEAD_BUTTON_MIN, (Number(radius) || 0) * 3.2)
    }

    /**
     * P4 / 4b — hit radius derived from the button, not from a renderer-specific splat.
     *
     * Before: max(8, screenRadius || radius) + 6, where screenRadius is written by the Canvas
     * renderer during a draw. That made the reachable area depend on which renderer had painted
     * last, and it disagreed with the 22–31 px button that actually sits on top of the bead.
     * Now: half the button width, computed from ead.radius only.
     */
    function beadHitRadius(radius) {
      return beadButtonSize(radius) / 2
    }

    function pickBeadAt(scene, x, y) {
      if (!scene) return null
      // P4 / 3: hit-testing follows what is actually drawn (representatives), so a cluster marker
      // is a target of its own instead of an arbitrary member underneath it.
      const targets = Array.isArray(scene.representatives) ? scene.representatives : scene.beads
      if (!Array.isArray(targets)) return null
      let best = null
      let bestDistance = Infinity
      let bestSlot = Infinity
      for (const bead of targets) {
        if (!bead || typeof bead.id !== 'string') continue
        const radius = beadHitRadius(bead.radius)
        const dx = bead.x - x
        const dy = bead.y - y
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance > radius) continue
        const slot = Number.isFinite(bead.slot) ? bead.slot : Infinity
        // nearest wins; an exact tie falls back to the earlier slot, so the answer never depends
        // on array order or on which renderer painted last
        if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && slot < bestSlot)) {
          bestDistance = distance
          bestSlot = slot
          best = bead.id
        }
      }
      return best
    }

    /**
     * Our own boot row revision.
     *
     * `window.__DSH_BOOT__` is the page boot manifest the module loader itself parses. It is
     * the only place the per-package revision is visible, and the chunk route demands an
     * exact `?rev=`. This is an undocumented (though public) wire: every read is defensive
     * and returns null rather than throwing, so callers can fall back to canvas.
     */
    function readOwnRowRev(boot, packageId) {
      const target = packageId || OWN_PACKAGE_ID
      try {
        if (!boot || typeof boot !== 'object') return null
        const entries = Array.isArray(boot.entries) ? boot.entries : []
        for (const entry of entries) {
          if (!entry || entry.id !== target) continue
          return typeof entry.rev === 'string' && entry.rev !== '' ? entry.rev : null
        }
        return null
      } catch {
        return null
      }
    }

    function threeChunkUrl(rev) {
      return '/plugins/' + OWN_PACKAGE_ID + '/' + THREE_CHUNK_FILE + '?rev=' + encodeURIComponent(rev)
    }

    /**
     * Load the vendored three.js chunk (P-C: sibling chunk, never inlined into the bundle).
     *
     * Distinct failure reasons let the panel explain the fallback instead of showing a blank
     * brain: boot-missing | rev-missing | http-<status> | not-javascript | import-failed |
     * not-three.
     */
    const REV_ENDPOINT = '/plugins/dsh-brain-workspaces/api/chunk-rev'

    /**
     * Ask the Host for the bundle revision it would accept right now.
     *
     * Preferred over the boot manifest, which is a snapshot taken at page load: after a plugin
     * update that snapshot is stale and the chunk route answers 404. Our own route is fenced the
     * same way the scan route is, and returns the value the Host itself validates.
     */
    async function fetchLiveRev(deps) {
      const options = deps || {}
      const fetchImpl = 'fetch' in options ? options.fetch : (typeof fetch === 'function' ? fetch : undefined)
      if (typeof fetchImpl !== 'function') return null
      try {
        const response = await fetchImpl(REV_ENDPOINT, { credentials: 'same-origin', cache: 'no-store' })
        if (!response || response.ok === false) return null
        const body = await response.json()
        return body && typeof body.rev === 'string' && body.rev !== '' ? body.rev : null
      } catch {
        return null
      }
    }

    /**
     * Load the vendored three.js chunk (P-C: sibling chunk, never inlined).
     *
     * Revision candidates, best first: the live Host revision, then the boot-manifest revision
     * (kept for pages where our own route is unreachable). A 404 means that revision is stale,
     * so the next candidate is tried instead of failing outright.
     *
     * Failure reasons stay distinct so the panel can explain the fallback:
     * boot-missing | rev-missing | http-<status> | not-javascript | import-failed | not-three.
     */
    async function loadThree(deps) {
      const options = deps || {}
      const boot = 'boot' in options ? options.boot : (typeof window === 'undefined' ? undefined : window.__DSH_BOOT__)
      const importModule = options.importModule || ((url) => import(url))
      const fetchImpl = 'fetch' in options ? options.fetch : (typeof fetch === 'function' ? fetch : undefined)

      const liveRev = await fetchLiveRev(options)
      const bootRev = readOwnRowRev(boot, options.packageId)

      const revisions = []
      if (liveRev) revisions.push(liveRev)
      if (bootRev && bootRev !== liveRev) revisions.push(bootRev)
      if (revisions.length === 0) {
        const hasBoot = Boolean(boot && typeof boot === 'object')
        return { ok: false, reason: hasBoot ? 'rev-missing' : 'boot-missing' }
      }

      let worst = null

      for (let index = 0; index < revisions.length; index += 1) {
        const url = threeChunkUrl(revisions[index])

        if (typeof fetchImpl === 'function') {
          try {
            const head = await fetchImpl(url, { method: 'HEAD', credentials: 'same-origin' })
            if (head && head.ok === false) {
              worst = { ok: false, reason: 'http-' + head.status, url }
              continue // stale revision: try the next candidate
            }
            const type = head && head.headers && typeof head.headers.get === 'function'
              ? String(head.headers.get('content-type') || '')
              : ''
            if (type && !/javascript|ecmascript/i.test(type)) {
              worst = { ok: false, reason: 'not-javascript', url, detail: type }
              continue
            }
          } catch {
            /* preflight refused: the import below is the real test */
          }
        }

        let module
        try {
          module = await importModule(url)
        } catch (error) {
          worst = { ok: false, reason: 'import-failed', url, detail: String((error && error.message) || error) }
          continue
        }
        if (!module || typeof module.WebGLRenderer !== 'function') {
          worst = { ok: false, reason: 'not-three', url }
          continue
        }
        return { ok: true, url, THREE: module }
      }

      return worst || { ok: false, reason: 'rev-missing' }
    }

    function detectWebgl2() {
      try {
        const probe = document.createElement('canvas')
        const context = probe.getContext('webgl2')
        if (!context) return false
        const lose = context.getExtension('WEBGL_lose_context')
        if (lose) lose.loseContext()
        return true
      } catch {
        return false
      }
    }

    function asThreeColor(value, fallback) {
      return typeof value === 'string' && value.startsWith('#') ? value : fallback
    }

    /**
     * Size a renderer should be mounted at.
     *
     * The mount effect can run *after an await* (the three.js chunk), and React effects capture
     * the state of the render they ran in: at that point `size` may still be the mount render's
     * `{0, 0}` while the element has been laid out for a while. A renderer mounted at 0x0 keeps
     * a 1x1 drawing buffer and the panel shows nothing but its DOM labels until something else
     * happens to resize it — the reported "open it and I have to hit refresh" symptom.
     *
     * So: ask the DOM at the moment of mounting, and only fall back to the state value when the
     * element has no box (detached or test hosts).
     *
     * @param {{clientWidth?: number, clientHeight?: number}|null} element
     * @param {{width?: number, height?: number}|null|undefined} fallback
     * @returns {{width: number, height: number}}
     */
    function resolveMountSize(element, fallback) {
      // A layout box is a non-negative integer on a real element; anything else is "not measured".
      const read = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
      const width = read(element && element.clientWidth)
      const height = read(element && element.clientHeight)
      if (width > 0 && height > 0) return { width, height }
      const fallbackWidth = read(fallback && fallback.width)
      const fallbackHeight = read(fallback && fallback.height)
      // Per-axis: a half-measured element is no measurement, but mixing one live axis with the
      // stale one is still better than mounting at zero on both.
      return { width: width || fallbackWidth, height: height || fallbackHeight }
    }

    /** Canvas 2D adapter: the original renderer, unchanged behaviour. */
    function createCanvasRenderer(deps) {
      const options = deps || {}
      const draw = options.draw || drawScene
      const createCanvas = options.createCanvas || (() => document.createElement('canvas'))
      const requestFrame =
        options.requestFrame ||
        ((callback) => {
          if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
          return setTimeout(callback, 16)
        })

      let canvas = null
      let scene = null
      let destroyed = false
      let retryPending = false

      /** Draw, and retry exactly once when the canvas had no box yet. */
      const paint = (props) => {
        const next = props || {}
        if (next.scene !== undefined) scene = next.scene
        if (!canvas || !scene) return
        const clock = next.clock !== undefined ? next.clock : scene.clock
        const frame = Object.assign({}, scene, { clock })
        if (draw(canvas, frame) !== false) {
          retryPending = false
          return
        }
        if (retryPending) return
        retryPending = true
        requestFrame(() => {
          retryPending = false
          if (destroyed || !canvas || !scene) return
          // One retry only: if the box is still zero the resize effect owns it from here, and a
          // per-frame retry would burn a frame budget for a panel nobody can see anyway.
          draw(canvas, frame)
        })
      }

      const api = {
        kind: 'canvas',
        mount(container, props) {
          if (destroyed) return
          canvas = createCanvas()
          canvas.style.width = '100%'
          canvas.style.height = '100%'
          canvas.style.display = 'block'
          canvas.setAttribute('aria-hidden', 'true')
          container.appendChild(canvas)
          if (props) api.update(props)
        },
        update(props) {
          if (destroyed) return
          paint(props)
        },
        resize(width, height) {
          if (destroyed || !canvas) return
          // The canvas fills its container; only detached hosts need an explicit hint.
          if (width > 0 && canvas.clientWidth === 0) canvas.style.width = width + 'px'
          if (height > 0 && canvas.clientHeight === 0) canvas.style.height = height + 'px'
        },
        hitTest(x, y) {
          return pickBeadAt(scene, x, y)
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
          canvas = null
          scene = null
        },
      }
      return api
    }

    /**
     * Renderer tuning. Code constants on purpose (no Host config surface): these are view knobs,
     * and the scan pipeline must not grow a renderer-shaped configuration.
     */
    const THREE_TUNING = {
      /** Cap for `devicePixelRatio`: a 3x pass on a 4K/Retina screen triples fill rate for no gain. */
      maxDevicePixelRatio: 2,
      /** Master animation switch for the three renderer (the activity halo). */
      animationEnabled: true,
      /** Frames per second ceiling for the internal loop. */
      targetFps: 30,
      /** The galaxy haze is one full-screen quad; disable if a low-end GPU struggles. */
      hazeEnabled: true,
    }

    /**
     * three.js adapter (WebGL 2).
     *
     * One Scene, a y-down orthographic camera in CSS pixels, an explicit webgl2 context, one
     * batched Points for every workspace, and its own rAF loop. Round two adds volume and motion:
     * hemisphere haze (shader, no textures, no post-processing), a double outline plus midline
     * derived from `scene.hull`, a depth → size/brightness mapping that never moves a point,
     * deterministic per-bead phases from the stable workspace id, and activity pulses batched
     * into one Points + one LineSegments.
     */
    function createThreeRenderer(deps) {
      const options = deps || {}
      const THREE = options.THREE
      if (!THREE || typeof THREE.WebGLRenderer !== 'function') throw new Error('three.js is required')

      const tuning = Object.assign({}, THREE_TUNING, options.tuning || {})
      const requestFrame = options.requestAnimationFrame
        || (typeof requestAnimationFrame === 'function' ? (callback) => requestAnimationFrame(callback) : null)
      const cancelFrame = options.cancelAnimationFrame
        || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : null)
      const createCanvas = options.createCanvas || (() => document.createElement('canvas'))
      const createContext = options.createContext
        || ((canvas) => canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true }))

      const GLOW_VERTEX_SHADER = [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'attribute float aAlpha;',
        'attribute float aPhase;',
        // 0 in the brain skin, 1 for workspaces with real activity in the galaxy skin.
        'attribute float aActive;',
        'uniform float uDpr;',
        'uniform float uTime;',
        'uniform float uAnimate;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'varying float vPulse;',
        'void main() {',
        '  vColor = aColor;',
        '  float breathe = 1.0 + uAnimate * 0.06 * sin(uTime * 1.1 + aPhase);',
        '  float shimmer = 1.0 + uAnimate * 0.10 * sin(uTime * 0.9 + aPhase * 1.7);',
        '  vAlpha = clamp(aAlpha * shimmer, 0.0, 1.0);',
        // A slow halo ring on the star itself — never a travelling dot along a decorative line.
        '  vPulse = aActive * uAnimate * (0.5 + 0.5 * sin(uTime * 1.35 + aPhase));',
        '  gl_PointSize = clamp(aSize * uDpr * breathe, 1.0, 64.0);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n')

      const GLOW_FRAGMENT_SHADER = [
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'varying float vPulse;',
        'void main() {',
        '  vec2 offset = gl_PointCoord - vec2(0.5);',
        '  float distance = length(offset);',
        '  if (distance > 0.5) discard;',
        // P1: a tighter halo (squared falloff) plus a crisp core, so a workspace reads as a star
        // instead of an out-of-focus blob. Size still encodes session count; only the profile of
        // the sprite inside that size changed.
        '  float glow = smoothstep(0.5, 0.0, distance);',
        '  float core = smoothstep(0.18, 0.10, distance);',
        '  vec3 color = mix(vColor, vec3(1.0), core * 0.6);',
        '  float ring = smoothstep(0.5, 0.36, distance) * smoothstep(0.26, 0.36, distance);',
        '  float alpha = clamp(glow * glow * vAlpha + core * vAlpha * 0.9 + ring * vPulse * 0.38, 0.0, 1.0);',
        '  gl_FragColor = vec4(color, alpha);',
        '}',
      ].join('\n')

      const HAZE_VERTEX_SHADER = [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n')

      // Galaxy sky only: one centred disc. The two-lobe brain variant was removed with the brain
      // haze layer itself (user request), so this shader has a single shape and no branch.
      //
      // P5 adds the galaxy structure's two continuous terms to this same full-screen quad instead
      // of new quads (fill rate is the scarce resource here): the interstellar gas is a sum of
      // three overlapping elliptical samples in screen space, the bulge one centred falloff.
      // Both are plain analytic functions — no noise loop, no per-frame work, no animation.
      const HAZE_FRAGMENT_SHADER = [
        'uniform vec2 uSize;',
        'uniform vec3 uLeft;',
        'uniform vec3 uRight;',
        'uniform float uAlpha;',
        // gas samples, CSS pixels: (cx, cy, rx, ry) × 3, plus one alpha each
        'uniform float uGasSample[16];',
        'uniform float uGasAlpha[4];',
        // disc anchor + arm parameters: (cx, cy, halfWidth, halfHeight) / (count, turns, width, strength)
        'uniform vec4 uDisc;',
        'uniform vec4 uArm;',
        'uniform float uArmPhase;',
        // bulge, CSS pixels: (cx, cy, radius, alpha)
        'uniform float uBulgeShape[4];',
        'uniform vec3 uGasColor;',
        'uniform vec3 uBulgeColor;',
        'varying vec2 vUv;',
        'float gasBand(vec2 point) {',
        '  float sum = 0.0;',
        '  for (int i = 0; i < 4; i++) {',
        '    vec2 centre = vec2(uGasSample[i * 4], uGasSample[i * 4 + 1]);',
        '    vec2 radii = vec2(max(uGasSample[i * 4 + 2], 1.0), max(uGasSample[i * 4 + 3], 1.0));',
        '    vec2 offset = (point - centre) / radii;',
        '    sum += uGasAlpha[i] * exp(-dot(offset, offset) * 1.7);',
        '  }',
        '  return sum;',
        '}',
        // Analytic arm band: two log-spiral centre lines in normalised disc coordinates.
        // Two iterations, no texture, no extra pass.
        'float armBand(vec2 point) {',
        '  vec2 local = (point - uDisc.xy) / vec2(max(uDisc.z, 1.0), max(uDisc.w, 1.0));',
        '  float r = length(local);',
        '  if (r < 0.16 || r > 1.02) return 0.0;',
        '  float theta = atan(local.y, local.x);',
        '  float t = log(max(r, 0.18) / 0.18) / log(1.0 / 0.18);',
        '  float width = uArm.z + 0.045 * max(0.0, r - 0.18);',
        '  float sum = 0.0;',
        '  for (int a = 0; a < 2; a++) {',
        '    float centre = uArmPhase + t * uArm.y * 6.2831853 + float(a) * 3.14159265;',
        '    float delta = theta - centre;',
        '    delta = atan(sin(delta), cos(delta));',
        '    sum += exp(-pow(delta / width, 2.0) * 1.8);',
        '  }',
        '  return clamp(sum * 0.55, 0.0, 1.0);',
        '}',
        'void main() {',
        '  vec2 point = vUv * uSize;',
        '  float radius = min(uSize.x, uSize.y) * 0.62;',
        '  float disc = 1.0 - smoothstep(0.0, radius, distance(point, uSize * 0.5));',
        '  float vignette = 1.0 - smoothstep(radius * 0.9, radius * 2.2, distance(point, uSize * 0.5));',
        '  vec3 color = mix(uLeft, uRight, 0.5) * disc;',
        '  float gas = clamp(gasBand(point), 0.0, 0.4);',
        '  vec2 bulgeOffset = point - vec2(uBulgeShape[0], uBulgeShape[1]);',
        '  float bulgeReach = max(uBulgeShape[2], 1.0);',
        '  float bulge = clamp(uBulgeShape[3] * exp(-dot(bulgeOffset, bulgeOffset) / (bulgeReach * bulgeReach) * 1.6), 0.0, 0.4);',
        '  float arm = armBand(point) * uArm.w;',
        '  vec3 structure = uGasColor * (gas * 0.9 + arm * 0.3) + uBulgeColor * bulge * 0.9;',
        '  gl_FragColor = vec4(',
        '    color + structure,',
        '    clamp((disc * 0.55 + 0.05) * uAlpha * vignette + gas + bulge + arm * 0.3, 0.0, 1.0)',
        '  );',
        '}',
      ].join('\n')

      // Dust streaks: dark, short, per-vertex alpha. One batch, one draw call, no texture.
      const DUST_VERTEX_SHADER = [
        'attribute float aAlpha;',
        'varying float vAlpha;',
        'void main() {',
        '  vAlpha = aAlpha;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n')

      const DUST_FRAGMENT_SHADER = [
        'uniform vec3 uColor;',
        'varying float vAlpha;',
        'void main() {',
        '  gl_FragColor = vec4(uColor, vAlpha);',
        '}',
      ].join('\n')

      // Session satellites (P5.1): per-glyph size, alpha and colour, one batch. Static by design —
      // the shader has no time uniform, so reduced motion and the animation switch cannot make a
      // satellite drift or breathe.
      // Session satellites (P5.1) and the grains of a star wake (P5.3) are the same primitive: a
      // point with its own size, alpha and colour. One shader, one batch per layer, no time uniform,
      // so neither can drift or breathe when motion is switched off.
      const GLYPH_VERTEX_SHADER = [
        'attribute float aSize;',
        'attribute float aAlpha;',
        'attribute vec3 aColor;',
        'uniform float uDpr;',
        'varying float vAlpha;',
        'varying vec3 vColor;',
        'void main() {',
        '  vColor = aColor;',
        '  vAlpha = aAlpha;',
        // aSize is a CSS-pixel radius; gl_PointSize is in device pixels.
        '  gl_PointSize = clamp(aSize * 2.0 * uDpr, 1.5, 16.0);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n')

      const GLYPH_FRAGMENT_SHADER = [
        'varying float vAlpha;',
        'varying vec3 vColor;',
        'void main() {',
        '  float reach = length(gl_PointCoord - vec2(0.5));',
        '  if (reach > 0.5) discard;',
        '  float falloff = smoothstep(0.5, 0.24, reach);',
        '  gl_FragColor = vec4(vColor, vAlpha * falloff);',
        '}',
      ].join('\n')

      // Star wakes (P5.3) are streams of grains, so they share the satellite glyph shader: per-point
      // size, alpha and colour, one batch each, no uniform beyond DPR and no clock at all.

      // One ordering table for the layers the galaxy actually draws.
      //
      // P5 keeps every existing number: the stage rings stay at 1, the star fields at 2 / 3 and
      // the workspaces at 9. The new structure layers therefore take the free slots *around*
      // them — halo and dust below the rings (so the frame is never swallowed by the gas) and
      // every one of them below the beads. Behaviour of the ring geometry is untouched.
      const ORDER = {
        haze: 0,
        halo: 0.5,
        dust: 0.6,
        stage: 1,
        starsFar: 2,
        starsNear: 3,
        /** P5.4 orbital tracks: the faintest foreground guide, under everything else. */
        orbit: 8,
        /** P5.3 star wakes: above the whole background, under the satellites and the stars. */
        trail: 8.2,
        /** P5.1 session satellites: under every workspace point, above the whole background. */
        satellites: 8.5,
        bead: 9,
        selectionRing: 10,
        pulse: 11,
      }

      let canvas = null
      let renderer = null
      let threeScene = null
      let camera = null
      let root = null
      let group = null
      let haze = null
      let beadPoints = null
      let satellitePoints = null
      /** Every point batch drawn with the glyph shader (satellites + wake grains). */
      let glyphBatches = []
      let disposables = []
      let scene = null
      let time = 0
      let lastFrameAt = 0
      let animationEnabled = tuning.animationEnabled
      let size = { width: 0, height: 0, dpr: 1 }
      let dirty = true
      let frameId = 0
      let destroyed = false
      const contextLostHandlers = new Set()

      const track = (resource) => {
        disposables.push(resource)
        return resource
      }

      const dropChildren = () => {
        if (group) for (const child of group.children.slice()) group.remove(child)
        for (const resource of disposables) {
          try {
            resource.dispose()
          } catch {
            /* disposal is best-effort */
          }
        }
        disposables = []
        haze = null
        beadPoints = null
        satellitePoints = null
        glyphBatches = []
      }

      const paint = () => {
        if (renderer && threeScene && camera) renderer.render(threeScene, camera)
      }

      const updateBeadUniforms = () => {
        const uniforms = beadPoints && beadPoints.material && beadPoints.material.uniforms
        if (uniforms) {
          if (uniforms.uDpr) uniforms.uDpr.value = size.dpr
          if (uniforms.uTime) uniforms.uTime.value = time
          if (uniforms.uAnimate) uniforms.uAnimate.value = animationEnabled ? 1 : 0
        }
        // P5.1 / P5.3: glyph batches size in device pixels, so a DPR change is a uniform write,
        // never a geometry rebuild.
        for (const batch of glyphBatches) {
          const glyphUniforms = batch && batch.material && batch.material.uniforms
          if (glyphUniforms && glyphUniforms.uDpr) glyphUniforms.uDpr.value = size.dpr
        }
      }

      /**
       * P5: gas band + bulge uniform values, in CSS pixels.
       *
       * The shader works in screen space, so a scene change or a resize only rewrites numbers —
       * the deterministic samples themselves are never regenerated here.
       */
      const structureUniforms = (background) => {
        const sample = new Float32Array(16)
        const alpha = new Float32Array(4)
        const clouds = background && background.gas && Array.isArray(background.gas.clouds)
          ? background.gas.clouds
          : []
        for (let index = 0; index < 4; index += 1) {
          const cloud = clouds[index]
          if (!cloud) continue
          sample[index * 4] = Number(cloud.x) || 0
          sample[index * 4 + 1] = Number(cloud.y) || 0
          sample[index * 4 + 2] = Math.max(1, Number(cloud.rx) || 0)
          sample[index * 4 + 3] = Math.max(1, Number(cloud.ry) || 0)
          alpha[index] = Math.max(0, Math.min(0.3, Number(cloud.alpha) || 0))
        }
        const disc = background && background.disc
        const arms = background && background.arms
        const discValues = new Float32Array([
          disc ? Number(disc.cx) || 0 : 0,
          disc ? Number(disc.cy) || 0 : 0,
          disc ? Math.max(1, Number(disc.halfWidth) || 0) : 1,
          disc ? Math.max(1, Number(disc.halfHeight) || 0) : 1,
        ])
        const armValues = new Float32Array([
          arms ? Number(arms.count) || GALAXY_ARM_STYLE.armCount : GALAXY_ARM_STYLE.armCount,
          arms ? Number(arms.turns) || GALAXY_ARM_STYLE.armTurns : GALAXY_ARM_STYLE.armTurns,
          arms ? Number(arms.width) || GALAXY_ARM_STYLE.armWidth : GALAXY_ARM_STYLE.armWidth,
          arms ? Number(arms.strength) || GALAXY_ARM_STYLE.armStrength : GALAXY_ARM_STYLE.armStrength,
        ])
        const bulge = background && background.bulge
        const shape = new Float32Array([
          bulge ? Number(bulge.cx) || 0 : 0,
          bulge ? Number(bulge.cy) || 0 : 0,
          bulge ? Math.max(1, Number(bulge.radius) || 0) : 1,
          bulge ? Math.max(0, Math.min(0.3, Number(bulge.alpha) || 0)) : 0,
        ])
        return { sample, alpha, shape, disc: discValues, arm: armValues }
      }

      const applyHazeSize = () => {
        if (!haze) return
        haze.position.set(size.width / 2, size.height / 2, 0)
        haze.scale.set(size.width, size.height, 1)
        const uniforms = haze.material && haze.material.uniforms
        if (!uniforms) return
        if (uniforms.uSize) uniforms.uSize.value = { x: size.width, y: size.height }
        // The structure lives in the same quad: keep its anchors in step with the new size.
        const structure = structureUniforms(scene && scene.background)
        if (uniforms.uGasSample) uniforms.uGasSample.value = structure.sample
        if (uniforms.uGasAlpha) uniforms.uGasAlpha.value = structure.alpha
        if (uniforms.uBulgeShape) uniforms.uBulgeShape.value = structure.shape
        if (uniforms.uDisc) uniforms.uDisc.value = Array.from(structure.disc)
        if (uniforms.uArm) uniforms.uArm.value = Array.from(structure.arm)
      }

      // ------------------------------------------------------------------ surface lifecycle
      //
      // One long-lived object: built on the first update, then only uniforms are written. It is
      // deliberately *not* a child of `group` — `build()` clears that group on every scene change
      // (which a camera drag triggers), so keeping the surface out of it is what makes "static
      // mesh, moving camera" true instead of aspirational.

      const buildHaze = () => {
        if (!tuning.hazeEnabled || !scene) return
        const theme = scene.theme || {}
        const structure = structureUniforms(scene.background)
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3),
        )
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2))
        geometry.setIndex([0, 1, 2, 2, 1, 3])
        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: HAZE_VERTEX_SHADER,
            fragmentShader: HAZE_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            // This unit quad is viewed through an orthographic camera whose top/bottom are flipped
            // (top = 0, bottom = height), so its winding faces away from the camera and FrontSide
            // would cull it completely (that is why the old brain haze never drew a pixel).
            side: THREE.DoubleSide,
            uniforms: {
              uSize: { value: { x: size.width, y: size.height } },
              uLeft: { value: new THREE.Color(asThreeColor(theme.meshLeft, '#f0a63c')) },
              uRight: { value: new THREE.Color(asThreeColor(theme.meshRight, '#8b5cf6')) },
              uAlpha: { value: GALAXY_STYLE.hazeAlpha },
              // P5 structure, in the same quad: gas band and bulge, both anchored to the disc
              uGasSample: { value: structure.sample },
              uGasAlpha: { value: structure.alpha },
              uBulgeShape: { value: structure.shape },
              uDisc: { value: Array.from(structure.disc) },
              uArm: { value: Array.from(structure.arm) },
              uArmPhase: { value: GALAXY_ARM_STYLE.armPhase },
              uGasColor: { value: new THREE.Color(asThreeColor(theme.rimColor, '#cdd9ff')) },
              uBulgeColor: {
                value: new THREE.Color(
                  mixHex(asThreeColor(theme.core, '#7aa2ff'), '#ffffff', 0.35),
                ),
              },
            },
          }),
        )
        haze = new THREE.Mesh(geometry, material)
        haze.renderOrder = ORDER.haze
        group.add(haze)
        applyHazeSize()
      }

      /**
       * Halo: sparse faint points outside the disc, one batch. Alpha is baked into the vertex
       * colour exactly like the star field, so the batch needs no shader of its own.
       */
      const buildHalo = () => {
        const halo = scene.background && Array.isArray(scene.background.halo) ? scene.background.halo : null
        if (!halo || halo.length === 0) return
        const positions = []
        const colors = []
        for (const star of halo.slice(0, GALAXY_STRUCTURE_STYLE.haloCount)) {
          if (!star || !Number.isFinite(star.x) || !Number.isFinite(star.y)) continue
          const alpha = Math.max(0, Math.min(0.2, Number(star.alpha) || 0))
          positions.push(star.x, star.y, 0)
          colors.push(0.78 * alpha, 0.84 * alpha, 1 * alpha)
        }
        if (positions.length === 0) return
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        const material = track(
          new THREE.PointsMaterial({
            size: GALAXY_STRUCTURE_STYLE.haloSize[1] * (size.dpr || 1),
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
          }),
        )
        const points = new THREE.Points(geometry, material)
        points.renderOrder = ORDER.halo
        group.add(points)
      }

      /**
       * Dust: one merged LineSegments batch for every streak (never one object per streak). The
       * streaks are darker than the gas they sit on, so alpha is the whole effect — which is why
       * this batch carries a per-vertex alpha attribute instead of a material opacity.
       */
      const buildDust = () => {
        const dust = scene.background && Array.isArray(scene.background.dust) ? scene.background.dust : null
        if (!dust || dust.length === 0) return
        const positions = []
        const alphas = []
        for (const band of dust.slice(0, GALAXY_STRUCTURE_STYLE.dustCount)) {
          if (!band || !Number.isFinite(band.x) || !Number.isFinite(band.y)) continue
          if (!(band.length > 0)) continue
          const alpha = Math.max(0, Math.min(0.2, Number(band.alpha) || 0))
          if (alpha <= 0.005) continue
          const half = band.length / 2
          const dx = Math.cos(band.angle) * half
          const dy = Math.sin(band.angle) * half
          positions.push(band.x - dx, band.y - dy, 0, band.x + dx, band.y + dy, 0)
          alphas.push(alpha, alpha)
        }
        if (positions.length === 0) return
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: DUST_VERTEX_SHADER,
            fragmentShader: DUST_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: {
              uColor: { value: new THREE.Color(asThreeColor(scene.theme && scene.theme.backdropEdge, '#04060c')) },
            },
          }),
        )
        const lines = new THREE.LineSegments(geometry, material)
        lines.renderOrder = ORDER.dust
        group.add(lines)
      }

      const buildStage = () => {
        if (!scene.stage || !Array.isArray(scene.stage.rings)) return
        for (const ring of scene.stage.rings) {
          const points = []
          const segments = 96
          for (let index = 0; index <= segments; index += 1) {
            const angle = (index / segments) * Math.PI * 2
            points.push(new THREE.Vector3(ring.cx + Math.cos(angle) * ring.rx, ring.cy + Math.sin(angle) * ring.ry, 0))
          }
          const geometry = track(new THREE.BufferGeometry().setFromPoints(points))
          const material = track(
            new THREE.LineBasicMaterial({
              color: new THREE.Color(asThreeColor(scene.theme && scene.theme.rimColor, '#cdd9ff')),
              transparent: true,
              opacity: Math.max(0.02, Math.min(1, ring.alpha)),
              depthTest: false,
            }),
          )
          const line = new THREE.Line(geometry, material)
          line.renderOrder = ORDER.stage
          group.add(line)
        }
      }

      /** Workspace light points, far to near, sized by session count and tinted by directory count. */
      const buildBeads = (beads) => {
        const positions = []
        const colors = []
        const sizes = []
        const alphas = []
        const phases = []
        const actives = []

        for (const bead of beads) {
          if (!bead) continue
          const radius = Math.max(2, Number(bead.screenRadius) || Number(bead.radius) || 4)
          const base = new THREE.Color(asThreeColor(bead.color, '#ffffff'))
          const emphasis = bead.selected ? 1 : bead.hovered || bead.focused ? 0.7 : 0
          const depth = Math.min(1, Math.max(0, Number(bead.depth) || 0))
          // deterministic phase from the stable workspace id — never a random source
          // hashId returns a 16-hex-digit string: take the leading 32 bits as the phase seed
          const seed = parseInt(hashId(String(bead.id || (bead.node && bead.node.path) || '')).slice(0, 8), 16) || 0
          const phase = (seed % 628318) / 100000

          positions.push(bead.x, bead.y, 0)
          colors.push(base.r, base.g, base.b)
          // P1: 5 → 3.2 shrinks the halo without touching the size→sessions mapping
          sizes.push(radius * 3.2 * (1 + depth * 0.35) * (bead.selected ? 1.9 : 1 + emphasis * 0.5))
          alphas.push(bead.dimmed ? 0.16 : Math.min(1, (0.82 + emphasis * 0.18) * (0.75 + depth * 0.25)))
          phases.push(phase)
          // real activity only (pulseTargets reads mtime / lastSessionAt); 0 keeps the brain skin
          actives.push(bead.active === true ? 1 : 0)
        }

        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3))
        geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
        geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
        geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1))
        geometry.setAttribute('aActive', new THREE.Float32BufferAttribute(actives, 1))

        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: GLOW_VERTEX_SHADER,
            fragmentShader: GLOW_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: {
              uDpr: { value: size.dpr },
              uTime: { value: time },
              uAnimate: { value: animationEnabled ? 1 : 0 },
            },
          }),
        )

        beadPoints = new THREE.Points(geometry, material)
        beadPoints.renderOrder = ORDER.bead
        group.add(beadPoints)
      }

      const buildSelectionRing = (beads) => {
        for (const bead of beads) {
          if (!bead) continue
          const strong = bead.selected
          const weak = !strong && (bead.hovered || bead.focused)
          if (!strong && !weak) continue
          const radius = Math.max(2, Number(bead.screenRadius) || Number(bead.radius) || 4)
          const ring = radius + (strong ? 6 : 3.5)
          const outline = []
          for (let index = 0; index <= 48; index += 1) {
            const angle = (index / 48) * Math.PI * 2
            outline.push(new THREE.Vector3(bead.x + Math.cos(angle) * ring, bead.y + Math.sin(angle) * ring, 0))
          }
          const geometry = track(new THREE.BufferGeometry().setFromPoints(outline))
          const material = track(
            new THREE.LineBasicMaterial({
              color: new THREE.Color('#ffffff'),
              transparent: true,
              opacity: strong ? 0.9 : 0.45,
              depthTest: false,
            }),
          )
          const line = new THREE.Line(geometry, material)
          line.renderOrder = ORDER.selectionRing
          group.add(line)
        }
      }

      /**
       * Activity pulses: only ever built from `scene.pulses`, which exists only when the scanner
       * found real activity. No activity means no object and no animation.
       */
      const buildStars = () => {
        if (!Array.isArray(scene.stars) || scene.stars.length === 0) return
        for (const layer of ['far', 'near']) {
          const stars = scene.stars.filter((star) => star && star.layer === layer)
          if (stars.length === 0) continue
          const tint = layer === 'near' ? [0.84, 0.9, 1] : [0.66, 0.76, 0.96]
          const positions = []
          const colors = []
          for (const star of stars) {
            // near stars read brighter; alpha is baked into the vertex colour (one batch, no texture)
            const alpha = Math.max(0, Math.min(1, Number(star.alpha) || 0)) * (0.6 + 0.4 * (Number(star.perspective) || 0.45))
            positions.push(star.x, star.y, 0)
            colors.push(tint[0] * alpha, tint[1] * alpha, tint[2] * alpha)
          }
          const geometry = track(new THREE.BufferGeometry())
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
          const material = track(
            new THREE.PointsMaterial({
              // PointsMaterial sizes are device pixels: scale by DPR so the field keeps its
              // apparent CSS size on a HiDPI screen (the bead batch does the same via uDpr).
              size: (layer === 'near' ? GALAXY_STYLE.nearSize[1] : GALAXY_STYLE.farSize[1]) * (size.dpr || 1),
              sizeAttenuation: false,
              vertexColors: true,
              transparent: true,
              opacity: 1,
              depthTest: false,
              depthWrite: false,
            }),
          )
          const points = new THREE.Points(geometry, material)
          points.renderOrder = layer === 'near' ? ORDER.starsNear : ORDER.starsFar
          group.add(points)
        }
      }

      /**
       * P5.4 orbital tracks: one Points batch of dotted arcs, drawn with the same glyph shader as
       * the satellites and the wake grains. Faintest layer of the foreground by render order.
       */
      const buildOrbits = () => {
        const orbits = Array.isArray(scene.orbits) ? scene.orbits : null
        if (!orbits || orbits.length === 0) return
        const positions = []
        const colors = []
        const sizes = []
        const alphas = []
        for (const orbit of orbits) {
          const particles = orbit && orbit.particles
          if (!Array.isArray(particles) || particles.length === 0) continue
          const value = String(orbit.color || '#cfe0ff').replace('#', '')
          const red = parseInt(value.slice(0, 2), 16) / 255
          const green = parseInt(value.slice(2, 4), 16) / 255
          const blue = parseInt(value.slice(4, 6), 16) / 255
          for (const dot of particles) {
            if (!dot || !Number.isFinite(dot.x) || !Number.isFinite(dot.y)) continue
            const alpha = Math.max(0, Math.min(0.5, Number(dot.alpha) || 0))
            if (alpha <= 0.005) continue
            positions.push(dot.x, dot.y, 0)
            colors.push(
              Number.isFinite(red) ? red : 0.81,
              Number.isFinite(green) ? green : 0.88,
              Number.isFinite(blue) ? blue : 1,
            )
            sizes.push(Math.max(0.4, Number(dot.radius) || 0.4))
            alphas.push(alpha)
          }
        }
        if (positions.length === 0) return
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3))
        geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
        geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: GLYPH_VERTEX_SHADER,
            fragmentShader: GLYPH_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: { uDpr: { value: size.dpr || 1 } },
          }),
        )
        const points = new THREE.Points(geometry, material)
        points.renderOrder = ORDER.orbit
        glyphBatches.push(points)
        group.add(points)
      }

      /**
       * P5.3 star wakes: ONE Points batch for every grain of every wake. The wake reads as a stream
       * of particles that shrink and fade as they fall behind, not as a solid ribbon.
       */
      const buildTrails = () => {
        const trails = Array.isArray(scene.trails) ? scene.trails : null
        if (!trails || trails.length === 0) return
        const positions = []
        const colors = []
        const sizes = []
        const alphas = []
        for (const trail of trails) {
          const particles = trail && trail.particles
          if (!Array.isArray(particles) || particles.length === 0) continue
          const value = String(trail.color || '#cfe0ff').replace('#', '')
          const red = parseInt(value.slice(0, 2), 16) / 255
          const green = parseInt(value.slice(2, 4), 16) / 255
          const blue = parseInt(value.slice(4, 6), 16) / 255
          for (const grain of particles) {
            if (!grain || !Number.isFinite(grain.x) || !Number.isFinite(grain.y)) continue
            const alpha = Math.max(0, Math.min(0.8, Number(grain.alpha) || 0))
            if (alpha <= 0.01) continue
            positions.push(grain.x, grain.y, 0)
            colors.push(
              Number.isFinite(red) ? red : 0.81,
              Number.isFinite(green) ? green : 0.88,
              Number.isFinite(blue) ? blue : 1,
            )
            sizes.push(Math.max(0.45, Number(grain.radius) || 0.45))
            alphas.push(alpha)
          }
        }
        if (positions.length === 0) return
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3))
        geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
        geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: GLYPH_VERTEX_SHADER,
            fragmentShader: GLYPH_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: { uDpr: { value: size.dpr || 1 } },
          }),
        )
        const points = new THREE.Points(geometry, material)
        points.renderOrder = ORDER.trail
        glyphBatches.push(points)
        group.add(points)
      }

      /**
       * P5.1 session satellites: ONE Points batch for every glyph (never one object per glyph, and
       * never one object per session). Alpha is baked into the vertex colour, exactly like the star
       * field, so the batch keeps a single draw call and needs no shader of its own.
       */
      const buildSatellites = () => {
        const glyphs = Array.isArray(scene.satellites) ? scene.satellites : null
        if (!glyphs || glyphs.length === 0) return
        const positions = []
        const colors = []
        const sizes = []
        const alphas = []
        for (const glyph of glyphs) {
          if (!glyph || !Number.isFinite(glyph.x) || !Number.isFinite(glyph.y)) continue
          const alpha = Math.max(0, Math.min(0.7, Number(glyph.alpha) || 0))
          if (alpha <= 0.01) continue
          const value = String(glyph.color || '#cfe0ff').replace('#', '')
          const red = parseInt(value.slice(0, 2), 16) / 255
          const green = parseInt(value.slice(2, 4), 16) / 255
          const blue = parseInt(value.slice(4, 6), 16) / 255
          positions.push(glyph.x, glyph.y, 0)
          colors.push(Number.isFinite(red) ? red : 0.81, Number.isFinite(green) ? green : 0.88, Number.isFinite(blue) ? blue : 1)
          sizes.push(Math.max(0.8, Number(glyph.radius) || 0.8))
          alphas.push(alpha)
        }
        if (positions.length === 0) return
        const geometry = track(new THREE.BufferGeometry())
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3))
        geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
        geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
        const material = track(
          new THREE.ShaderMaterial({
            vertexShader: GLYPH_VERTEX_SHADER,
            fragmentShader: GLYPH_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: { uDpr: { value: size.dpr || 1 } },
          }),
        )
        satellitePoints = new THREE.Points(geometry, material)
        satellitePoints.renderOrder = ORDER.satellites
        glyphBatches.push(satellitePoints)
        group.add(satellitePoints)
      }

      const build = () => {
        dropChildren()
        if (!scene || !group) return
        // Sky (which now also carries the gas band and the bulge), then the galaxy structure
        // layers, then the two-ring frame, then the star field, then the workspaces. Every
        // structure object is below the beads by renderOrder, so no ordering depends on this
        // call sequence. The activity halo lives inside the bead shader, so there are no pulse
        // objects.
        buildHaze()
        buildHalo()
        buildDust()
        buildStage()
        buildStars()
        buildOrbits()
        buildTrails()
        buildSatellites()
        if (Array.isArray(scene.beads) && scene.beads.length > 0) {
          const drawn = scene.representatives || scene.beads
          buildBeads(drawn)
          buildSelectionRing(drawn)
        }
      }

      const loop = (now) => {
        if (destroyed || !requestFrame) return
        frameId = requestFrame(loop)
        const stamp = typeof now === 'number' ? now : 0
        const interval = 1000 / Math.max(1, tuning.targetFps)
        if (stamp - lastFrameAt < interval) return
        const delta = lastFrameAt === 0 ? interval : stamp - lastFrameAt
        lastFrameAt = stamp

        if (!animationEnabled) {
          if (!dirty) return
          dirty = false
          paint()
          return
        }

        time += Math.min(0.25, delta / 1000)
        updateBeadUniforms()
        paint()
        dirty = false
      }

      const api = {
        kind: 'three',
        mount(container, props) {
          if (destroyed) return
          canvas = createCanvas()
          const context = createContext(canvas)
          if (!context) throw new Error('webgl2-unavailable')

          size = {
            width: size.width || container.clientWidth || 1,
            height: size.height || container.clientHeight || 1,
            dpr: size.dpr || Math.min(
              tuning.maxDevicePixelRatio,
              (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
            ),
          }

          renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true })
          renderer.setPixelRatio(size.dpr)
          renderer.setSize(size.width, size.height, false)
          renderer.setClearColor(new THREE.Color(asThreeColor(scene && scene.theme && scene.theme.backdropMid, '#080c17')), 1)

          canvas.style.width = '100%'
          canvas.style.height = '100%'
          canvas.style.display = 'block'
          canvas.setAttribute('aria-hidden', 'true')
          canvas.addEventListener(
            'webglcontextlost',
            (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
              for (const handler of contextLostHandlers) {
                try {
                  handler()
                } catch {
                  /* a failing handler must not mask the loss */
                }
              }
            },
            false,
          )
          container.appendChild(canvas)

          threeScene = new THREE.Scene()
          root = new THREE.Group()
          group = new THREE.Group()
          // y-down orthographic camera: the scene is already in CSS pixels, so no flip anywhere.
          root.position.set(size.width / 2, size.height / 2, 0)
          group.position.set(-size.width / 2, -size.height / 2, 0)
          root.add(group)
          threeScene.add(root)

          camera = new THREE.OrthographicCamera(0, size.width, 0, size.height, -1000, 1000)
          camera.position.set(0, 0, 10)

          if (props) api.update(props)
          if (requestFrame) frameId = requestFrame(loop)
        },
        update(props) {
          if (destroyed || !renderer) return
          const next = props || {}
          const nextScene = next.scene !== undefined ? next.scene : scene
          const nextClock = next.clock !== undefined ? next.clock : null
          if (next.animationEnabled !== undefined) animationEnabled = next.animationEnabled === true
          if (typeof nextClock === 'number' && nextClock > time) time = nextClock
          const sceneChanged = nextScene !== scene
          scene = nextScene
          if (sceneChanged) {
            const theme = scene && scene.theme
            renderer.setClearColor(new THREE.Color(asThreeColor(theme && theme.backdropMid, '#080c17')), 1)
            build()
          }
          updateBeadUniforms()
          paint()
          dirty = false
        },
        resize(width, height, dpr) {
          if (destroyed || !renderer) return
          const capped = Math.min(tuning.maxDevicePixelRatio, dpr || size.dpr || 1)
          size = { width: width || 1, height: height || 1, dpr: capped }
          renderer.setPixelRatio(size.dpr)
          renderer.setSize(size.width, size.height, false)
          if (camera) {
            camera.left = 0
            camera.right = size.width
            camera.top = 0
            camera.bottom = size.height
            camera.updateProjectionMatrix()
          }
          if (root) root.position.set(size.width / 2, size.height / 2, 0)
          if (group) group.position.set(-size.width / 2, -size.height / 2, 0)
          // dpr lives in a uniform: a resize never rebuilds the bead geometry
          updateBeadUniforms()
          applyHazeSize()
          dirty = true
          paint()
        },
        hitTest(x, y) {
          return pickBeadAt(scene, x, y)
        },
        onContextLost(handler) {
          contextLostHandlers.add(handler)
          return () => contextLostHandlers.delete(handler)
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          if (frameId && cancelFrame) cancelFrame(frameId)
          frameId = 0
          contextLostHandlers.clear()
          dropChildren()
          try {
            if (renderer) renderer.dispose()
          } catch {
            /* best-effort */
          }
          if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
          renderer = null
          threeScene = null
          camera = null
          root = null
          group = null
          canvas = null
          scene = null
        },
      }
      return api
    }

    /** Human sentence for a renderer fallback reason, in the active dictionary. */
    function rendererNoticeText(dict, reason) {
      const value = String(reason || '')
      const table = dict || {}
      if (value.startsWith('http-')) return ((table.noticeHttp || '') + ' ' + value.slice(5)).trim()
      const keys = {
        'no-webgl2': 'noticeNoWebgl2',
        'boot-missing': 'noticeBootMissing',
        'rev-missing': 'noticeRevMissing',
        'not-javascript': 'noticeNotJavaScript',
        'import-failed': 'noticeImportFailed',
        'not-three': 'noticeNotThree',
        'init-failed': 'noticeInitFailed',
        'context-lost': 'noticeContextLost',
      }
      const key = keys[value]
      return (key && table[key]) || table.noticeUnknown || ''
    }

    function BrainCanvas(props) {
      const {
        shape,
        positions,
        nodeById,
        dict,
        selectedId,
        hoverId,
        query,
        maxCount,
        maxSessions,
        partialIds,
        onSelect,
        onHover,
      } = props

      const mountRef = useRef(null)
      const wrapRef = useRef(null)
      const rendererRef = useRef(null)
      const cameraRef = useRef(null)
      const stopDragRef = useRef(null)
      const focusFrameRef = useRef(null)
      const [size, setSize] = useState({ width: 0, height: 0 })
      const [camera, setCamera] = useState(readCamera)
      const [focusId, setFocusId] = useState(null)
      const [dragging, setDragging] = useState(false)
      // P4 / 4a: roving tabindex. Only consulted above the density threshold.
      const [rovingId, setRovingId] = useState(null)
      // P4 magnifier: ephemeral (never persisted) — a loupe is a transient aid, not a setting
      const [loupeOn, setLoupeOn] = useState(false)
      const [loupeAt, setLoupeAt] = useState(null)
      const loupeCanvasRef = useRef(null)
      const beadRefs = useRef(null)
      if (beadRefs.current === null) beadRefs.current = new Map()
      const initialView = useRef(null)
      if (initialView.current === null) initialView.current = readViewSettings()
      const [themeId, setThemeId] = useState(initialView.current.themeId)
      const [accent, setAccent] = useState(initialView.current.accent)
      const [spinning, setSpinning] = useState(initialView.current.spinning)
      const [pulses, setPulses] = useState(initialView.current.pulses)
      const [rendererId, setRendererId] = useState(initialView.current.renderer)
      const [rendererNotice, setRendererNotice] = useState(null)
      const [liveKind, setLiveKind] = useState('')

      useEffect(() => {
        writeViewSettings({ themeId, accent, spinning, pulses, renderer: rendererId })
      }, [themeId, accent, spinning, pulses, rendererId])

      cameraRef.current = camera

      useEffect(
        () => () => {
          if (stopDragRef.current) stopDragRef.current()
          if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current)
        },
        [],
      )

      const needle = String(query || '').trim().toLowerCase()

      useEffect(() => {
        const element = wrapRef.current
        if (!element) return undefined
        const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
        measure()
        let observer
        try {
          observer = new ResizeObserver(measure)
          observer.observe(element)
        } catch {
          /* ResizeObserver missing: the first measurement still applies */
        }
        return () => {
          if (observer) observer.disconnect()
        }
      }, [])

      // wheel zoom needs a non-passive listener, which React's onWheel cannot guarantee
      useEffect(() => {
        const element = wrapRef.current
        if (!element) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const factor = Math.exp(-event.deltaY * 0.0014)
          setCamera((current) => {
            const zoom = clamp(current.zoom * factor, CAMERA_LIMITS.zoom[0], CAMERA_LIMITS.zoom[1])
            const next = Object.assign({}, current, { zoom })
            writeCamera(next)
            return next
          })
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [])

      // (the idle orbit and the pulse clock share the single animation loop further down)

      const projectEvery = (point) => projectPoint(point, camera, size.width, size.height)

      const scene = useMemo(() => {
        const theme = themeById(themeId)
        const ramp = rampFor(theme, accent)
        if (size.width === 0 || size.height === 0) {
          return {
            hull: [],
            meshPoints: [],
            links: [],
            stars: [],
            beads: [],
            representatives: [],
            clusters: [],
            satellites: [],
            orbits: [],
            camera,
            theme,
            showLabels: false,
            stage: null,
            background: null,
            pulses: [],
            trails: [],
          }
        }

        const stars = createStarField(GALAXY_STYLE.farCount, { layer: 'far' })
          .concat(createStarField(GALAXY_STYLE.nearCount, { layer: 'near' }))
          .map((star) => {
            const projected = projectEvery(star)
            return {
              x: projected.x,
              y: projected.y,
              depth: projected.depth,
              perspective: projected.perspective,
              radius: star.radius,
              alpha: star.alpha,
              layer: star.layer,
            }
          })

        const beads = positions
          .map((position) => {
            const node = nodeById.get(position.id)
            if (!node) return null
            // `position.slot` is the PERSISTED slot index (assignments[id]). The array index must
            // never be used here: `positions` is sorted by slot, so deleting one workspace shifts
            // every later index and would move (or flip) other beads — measured at 3 of 5
            // survivors moving, worst 84 px, before this was fixed.
            const world = galaxyPoint(position.x, position.y, position.slot)
            if (!world) return null
            const projected = projectEvery(world)
            const colors = beadColors(node.directoryCount, maxCount, ramp)
            const unreadable = node.status !== 'ready'
            const partial = Boolean(partialIds && partialIds.has(position.id))
            const bead = {
              id: position.id,
              node,
              world,
              x: projected.x,
              y: projected.y,
              depth: projected.depth,
              perspective: projected.perspective,
              radius: position.radius * beadScale(node.sessionCount, maxSessions),
              color: colors.color,
              unreadable,
              ringDash: unreadable ? [1.5, 2.5] : partial ? [2.5, 2.5] : null,
              dimmed: needle !== '' && !String(node.name).toLowerCase().includes(needle),
              selected: selectedId === position.id,
              hovered: hoverId === position.id,
              focused: focusId === position.id,
              screenRadius: 0,
              labelVisible: false,
            }
            bead.labelVisible = shouldShowLabel(bead, { beadCount: positions.length, zoom: camera.zoom })
            return bead
          })
          .filter(Boolean)

        // which workspaces are "alive" right now: the activity halo reads only this
        const activeIds = new Set(pulseTargets(beads.map((bead) => bead.node), Date.now()).map((t) => t.id))
        for (const bead of beads) bead.active = activeIds.has(bead.id)

        // P4 / 3: what is drawn, hit-tested and turned into buttons. The members keep their own
        // coordinates — only the marker of a dense group moves to the group's centroid.
        const clustered = clusterBeads(beads, {
          gap: CLUSTER_GAP,
          maxLevels: CLUSTER_MAX_LEVELS,
          searchActive: needle !== '',
          selectedId,
          hoverId,
          focusId,
        })

        // One anchor for the disc: the rings and the P5 structure are both derived from it, so a
        // camera move or a resize only changes this projection — never the background samples.
        const extent = galaxyDiscExtent(projectEvery)
        // P5.1: satellites ride on the drawn representatives, so a clustered member (no star of
        // its own) has none until the cluster expands.
        const satellites = buildSessionSatellites(clustered.representatives)
        // P5.3: wakes use the same rule, and the disc centre the rotation is measured from.
        const trails = starTrails(clustered.representatives, { extent })
        // P5.4: each star's own orbital track, concentric with the disc.
        const orbits = starOrbits(clustered.representatives, { extent })

        return {
          hull: [],
          meshPoints: [],
          links: [],
          stars,
          beads,
          representatives: clustered.representatives,
          clusters: clustered.clusters,
          satellites,
          orbits,
          camera,
          theme,
          showLabels: true,
          motion: Boolean(pulses),
          trails,
          stage: galaxyStageFor(size.width, size.height, extent),
          background: extent ? projectGalaxyStructure(createGalaxyStructure(), { extent }) : null,
          pulses: [],
        }
      }, [positions, nodeById, size, camera, maxCount, maxSessions, needle, selectedId, hoverId, focusId, partialIds, themeId, accent, pulses])

      const sceneRef = useRef(null)
      const clockRef = useRef(0)
      sceneRef.current = scene

      // The renderer effect below can resume after an await (the three.js chunk), long after the
      // render whose `size` it closed over. Reading through a ref gives it the measurement of the
      // moment it actually mounts; see `resolveMountSize` for why the closure value is not enough.
      const sizeRef = useRef(size)
      sizeRef.current = size

      // One loop drives the orbit, the breathing cloud, the ripples and the trails. With the
      // motion switch off and no orbit there is no rAF ticking at all.
      const animate = Boolean(spinning || pulses)

      // Breathing and pulses are gated exactly like the visible motion switch.
      const rendererUpdate = () => ({
        scene: sceneRef.current,
        clock: clockRef.current,
        animationEnabled: Boolean(pulses) && !prefersReducedMotion(),
      })

      // Renderer lifecycle: create on mount, recreate when the choice changes, always
      // destroy the previous instance. Any failure installs the canvas renderer and records a
      // reason, so a broken chunk can never leave the panel blank.
      useEffect(() => {
        const container = mountRef.current
        if (!container) return undefined
        let cancelled = false
        let current = null

        const install = (renderer, notice) => {
          if (cancelled) {
            renderer.destroy()
            return
          }
          current = renderer
          rendererRef.current = renderer
          // The DOM is the authority here: a renderer mounted at 0x0 never draws, which is the
          // blank-panel-on-open bug. `sizeRef` is only the fallback for detached hosts.
          const mounted = resolveMountSize(container, sizeRef.current)
          renderer.mount(container, rendererUpdate())
          renderer.resize(mounted.width, mounted.height, Math.min(2, window.devicePixelRatio || 1))
          if (typeof renderer.onContextLost === 'function') {
            renderer.onContextLost(() => {
              if (cancelled) return
              setRendererNotice('context-lost')
              setRendererId('canvas')
            })
          }
          setRendererNotice(notice)
          setLiveKind(renderer.kind)
          renderer.update(rendererUpdate())
        }

        const fallback = (reason) => {
          if (cancelled) return
          install(createCanvasRenderer(), reason)
        }

        const start = async () => {
          if (rendererId === 'canvas') {
            install(createCanvasRenderer(), null)
            return
          }
          if (!detectWebgl2()) {
            fallback('no-webgl2')
            return
          }
          const loaded = await loadThree()
          if (cancelled) return
          if (!loaded.ok) {
            fallback(loaded.reason)
            return
          }
          try {
            install(createThreeRenderer({ THREE: loaded.THREE }), null)
          } catch (error) {
            fallback('init-failed')
          }
        }

        void start()

        return () => {
          cancelled = true
          if (current) current.destroy()
          rendererRef.current = null
        }
      }, [rendererId])

      // Size changes are forwarded, not a reason to rebuild the renderer. `liveKind` is in the
      // dependency list on purpose: installing a renderer flips it, and that is the one signal
      // that a real (non-null) renderer now needs the current size and a first frame.
      useEffect(() => {
        const renderer = rendererRef.current
        if (!renderer || size.width === 0 || size.height === 0) return
        renderer.resize(size.width, size.height, Math.min(2, window.devicePixelRatio || 1))
        renderer.update(rendererUpdate())
      }, [size, liveKind, rendererId])


      useEffect(() => {
        if (animate) return undefined
        const renderer = rendererRef.current
        if (!renderer || size.width === 0 || size.height === 0) return undefined
        const frame = requestAnimationFrame(() =>
          renderer.update(rendererUpdate()),
        )
        return () => cancelAnimationFrame(frame)
      }, [scene, size, liveKind, animate, rendererId])

      useEffect(() => {
        if (!animate) return undefined
        if (!rendererRef.current || size.width === 0 || size.height === 0) return undefined

        let frame
        let previous = 0
        const step = (now) => {
          const delta = previous === 0 ? 16 : Math.min(64, now - previous)
          previous = now
          clockRef.current += delta / 1000
          if (spinning) {
            setCamera((current) => Object.assign({}, current, { yaw: current.yaw + delta * 0.00022 }))
          }
          const active = rendererRef.current
          if (active) active.update({ scene: sceneRef.current, clock: clockRef.current })
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => cancelAnimationFrame(frame)
      }, [animate, spinning, size, liveKind])

      const startDrag = (event) => {
        if (event.button !== 0) return
        // A bead is a real button: pressing it selects a workspace. Capture or drag here
        // would retarget the click to this container and swallow the selection.
        if (!shouldStartDrag(event.target)) return

        const base = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch }
        setDragging(true)
        cancelFocus()
        // Taking the pointer means taking the camera: stop the idle orbit so the two do
        // not fight over yaw.
        setSpinning(false)

        const onMove = (moveEvent) => {
          setCamera((current) =>
            Object.assign({}, current, {
              yaw: base.yaw + (moveEvent.clientX - base.x) * 0.007,
              pitch: clamp(
                base.pitch + (moveEvent.clientY - base.y) * 0.007,
                CAMERA_LIMITS.pitch[0],
                CAMERA_LIMITS.pitch[1],
              ),
            }),
          )
        }

        let travelled = 0
        const onMoveTracked = (moveEvent) => {
          travelled = Math.max(
            travelled,
            Math.hypot(moveEvent.clientX - base.x, moveEvent.clientY - base.y),
          )
          onMove(moveEvent)
        }

        const finish = (finishEvent) => {
          window.removeEventListener('pointermove', onMoveTracked)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          setDragging(false)
          writeCamera(cameraRef.current)
          stopDragRef.current = null

          // P4: a press that did not turn into a drag is a click on the view itself. The DOM
          // buttons handle the ones that are mounted; this covers what virtualization/capping
          // left out (and lets a pointer reach a bead in Canvas mode without any button).
          if (travelled > 3 || !finishEvent || !wrapRef.current) return
          const current = sceneRef.current
          if (!current) return
          const rect = wrapRef.current.getBoundingClientRect()
          const id = pickBeadAt(current, finishEvent.clientX - rect.left, finishEvent.clientY - rect.top)
          if (!id) return
          if (String(id).startsWith('cluster:')) {
            const cluster = (current.clusters || []).find((item) => item.id === id)
            if (cluster) zoomToCluster(cluster)
            return
          }
          onSelect(id)
        }

        stopDragRef.current = finish
        window.addEventListener('pointermove', onMoveTracked)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
      }

      const zoomBy = (factor) => {
        setCamera((current) => {
          const next = Object.assign({}, current, {
            zoom: clamp(current.zoom * factor, CAMERA_LIMITS.zoom[0], CAMERA_LIMITS.zoom[1]),
          })
          writeCamera(next)
          return next
        })
      }

      /** Smoothly push the camera toward one bead and centre it. */
      const focusOn = (bead, wantedZoom) => {
        if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current)
        setSpinning(false)

        const from = Object.assign({}, cameraRef.current)
        const targetZoom = clamp(
          Number.isFinite(wantedZoom) ? wantedZoom : Math.max(from.zoom * 1.7, 1.75),
          CAMERA_LIMITS.zoom[0],
          CAMERA_LIMITS.zoom[1],
        )
        const ratio = targetZoom / from.zoom
        const centerX = size.width / 2
        const centerY = size.height / 2

        const to = {
          yaw: from.yaw,
          pitch: from.pitch,
          zoom: targetZoom,
          panX: from.panX - (bead.x - centerX) * ratio,
          panY: from.panY - (bead.y - centerY) * ratio,
        }

        const startedAt = performance.now()
        const duration = 420
        const step = (now) => {
          const progress = Math.min(1, (now - startedAt) / duration)
          const eased = 1 - Math.pow(1 - progress, 3)
          const next = {
            yaw: from.yaw + (to.yaw - from.yaw) * eased,
            pitch: from.pitch + (to.pitch - from.pitch) * eased,
            zoom: from.zoom + (to.zoom - from.zoom) * eased,
            panX: from.panX + (to.panX - from.panX) * eased,
            panY: from.panY + (to.panY - from.panY) * eased,
          }
          setCamera(next)
          if (progress < 1) {
            focusFrameRef.current = requestAnimationFrame(step)
          } else {
            focusFrameRef.current = null
            writeCamera(next)
          }
        }
        focusFrameRef.current = requestAnimationFrame(step)
      }

      const cancelFocus = () => {
        if (focusFrameRef.current !== null) {
          cancelAnimationFrame(focusFrameRef.current)
          focusFrameRef.current = null
        }
      }

      // P4 magnifier: redraw whenever the pointer moves, the camera changes or the scene changes
      useEffect(() => {
        if (!loupeOn || !loupeAt) return
        const canvas = loupeCanvasRef.current
        if (!canvas) return
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const side = 220
        canvas.width = Math.round(side * dpr)
        canvas.height = Math.round(side * dpr)
        const g = canvas.getContext('2d')
        if (!g) return
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawLoupe(g, sceneRef.current, loupeAt, 2.5, side)
      })

      const resetView = () => {
        cancelFocus()
        const next = Object.assign({}, CAMERA_DEFAULT)
        setCamera(next)
        writeCamera(next)
      }

      // ------------------------------------------------------------------ P4 / 4a wiring
      //
      // Below the threshold every workspace keeps its own button and Tab stop (the pre-P4
      // behaviour). Above it only reachable beads are mounted, and the layer exposes a single
      // tab stop; arrow keys move inside the layer. Members keep their coordinates either way.
      const drawnBeads = scene.representatives || scene.beads
      const virtual = drawnBeads.length > DOM_VIRTUALIZE_FROM
      const mountedBeads = virtual
        ? buttonsToMount(drawnBeads, {
            width: size.width,
            height: size.height,
            selectedId,
            hoverId,
            focusId,
            searchActive: needle !== '',
          })
        : drawnBeads

      // P4 / 3: clicking a cluster marker zooms until its members separate; it never selects a
      // member on the user's behalf.
      const zoomToCluster = (cluster) => {
        if (!cluster || !Array.isArray(cluster.memberIds)) return
        const members = scene.beads.filter((bead) => cluster.memberIds.includes(bead.id))
        if (members.length === 0) return
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const bead of members) {
          if (bead.x < minX) minX = bead.x
          if (bead.x > maxX) maxX = bead.x
          if (bead.y < minY) minY = bead.y
          if (bead.y > maxY) maxY = bead.y
        }
        const span = Math.max(maxX - minX, maxY - minY, 40) * 2.4
        const fit = Math.min(size.width, size.height) / span
        const from = cameraRef.current
        focusOn({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, from.zoom * fit)
      }
      const rovingResolvedId = virtual
        ? mountedBeads.some((bead) => bead.id === rovingId)
          ? rovingId
          : selectedId && mountedBeads.some((bead) => bead.id === selectedId)
            ? selectedId
            : focusId && mountedBeads.some((bead) => bead.id === focusId)
              ? focusId
              : mountedBeads.length > 0
                ? mountedBeads[0].id
                : null
        : null

      const moveRoving = (step) => {
        if (!virtual) return
        const target = rovingNeighbour(mountedBeads, rovingResolvedId, step)
        if (!target) return
        setRovingId(target.id)
        // keyboard users get the loupe too: it follows the focused bead
        if (loupeOn) setLoupeAt({ x: target.x, y: target.y })
        const element = beadRefs.current.get(target.id)
        if (element && typeof element.focus === 'function') element.focus()
      }

      const onBeadKeyDown = (event) => {
        if (!virtual) return
        const key = event.key
        if (key === 'ArrowRight' || key === 'ArrowDown') {
          event.preventDefault()
          moveRoving(1)
        } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
          event.preventDefault()
          moveRoving(-1)
        } else if (key === 'Home') {
          event.preventDefault()
          moveRoving(-mountedBeads.length)
        } else if (key === 'End') {
          event.preventDefault()
          moveRoving(mountedBeads.length)
        }
      }

      const controlStyle = {
        width: 28,
        height: 28,
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.22)',
        background: 'rgba(12,18,34,0.72)',
        color: 'rgba(255,255,255,0.86)',
        fontSize: 14,
        lineHeight: '24px',
        cursor: 'pointer',
        padding: 0,
      }

      // P5.1: directory names. The overlay obeys exactly the same virtualization the buttons do
      // (so a name appears when its point is reachable), plus whatever the user is acting on.
      // It is text only: no tab stop, no aria name, no hit area — the buttons keep those.
      const labels = workspaceLabels(drawnBeads, {
        width: size.width,
        height: size.height,
        selectedId,
        hoverId,
        focusId,
        searchActive: needle !== '',
        mountedIds: mountedBeads,
        formatCluster: (count) => count + ' ' + (dict.clusterGroup || '个工作区'),
      })

      return h(
        'div',
        {
          ref: wrapRef,
          onPointerDown: startDrag,
          onDoubleClick: resetView,
          onPointerMove: (event) => {
            if (!loupeOn) return
            const wrap = wrapRef.current
            if (!wrap) return
            const rect = wrap.getBoundingClientRect()
            setLoupeAt({ x: event.clientX - rect.left, y: event.clientY - rect.top })
          },
          onPointerLeave: () => {
            if (loupeOn) setLoupeAt(null)
          },
          style: {
            position: 'relative',
            flex: 1,
            // The old <canvas> carried an intrinsic 300x150 size; the renderer mount is an
            // absolutely positioned div, so keep an explicit floor against a zero-height parent.
            minHeight: 260,
            width: '100%',
            touchAction: 'none',
            cursor: dragging ? 'grabbing' : 'grab',
          },
        },
        h('div', {
          ref: mountRef,
          role: 'img',
          'aria-label': dict.title,
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
        }),
        h(
          'div',
          {
            style: { position: 'absolute', inset: 0, pointerEvents: 'none' },
            onKeyDown: onBeadKeyDown,
          },
          labels.length > 0
            ? h(
                'div',
                {
                  // Decorative text: the workspace buttons already carry the accessible name, so
                  // this layer is hidden from assistive tech and never takes a pointer or a tab.
                  'aria-hidden': true,
                  style: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' },
                },
                labels.map((label) =>
                  h(
                    'div',
                    {
                      key: label.key,
                      style: labelStyle(label),
                    },
                    label.text,
                  ),
                ),
              )
            : null,
          loupeOn && loupeAt
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: loupeAt.x + 'px',
                    top: loupeAt.y + 'px',
                    width: '220px',
                    height: '220px',
                    transform: 'translate(-50%, -50%)',
                    borderRadius: '50%',
                    overflow: 'hidden',
                    border: '1px solid rgba(190, 210, 255, 0.55)',
                    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.55)',
                    background: 'rgba(4, 7, 13, 0.92)',
                    // never a target: the loupe is an aid, not a control surface
                    pointerEvents: 'none',
                    zIndex: 2,
                  },
                },
                h('canvas', { ref: loupeCanvasRef, width: 220, height: 220, style: { width: '220px', height: '220px' } }),
              )
            : null,
          mountedBeads.map((bead) =>
            h('button', {
              key: bead.id,
              type: 'button',
              'data-brain-bead': 'true',
              // P4 / 4a: one tab stop above the density threshold, every bead below it.
              tabIndex: virtual ? (bead.id === rovingResolvedId ? 0 : -1) : 0,
              ref: (element) => {
                if (element) beadRefs.current.set(bead.id, element)
                else beadRefs.current.delete(bead.id)
              },
              'aria-label': bead.cluster
                ? bead.count + ' ' + (dict.clusterGroup || '个工作区') + ' · ' + (dict.clusterZoom || '放大查看')
                : bead.node.name +
                  ' · ' +
                  dict.dirCount +
                  ' ' +
                  bead.node.directoryCount +
                  ' · ' +
                  dict.sessions +
                  ' ' +
                  (Number(bead.node.sessionCount) || 0),
              'aria-pressed': selectedId === bead.id,
              // Hover hint: the satellites are an aggregate of the session count, never one
              // clickable record (spec §8.5).
              title: bead.cluster
                ? bead.count + ' ' + (dict.clusterGroup || '个工作区')
                : bead.node.name +
                  ' · ' +
                  dict.sessions +
                  ' ' +
                  (Number(bead.node.sessionCount) || 0) +
                  ' · ' +
                  (dict.satelliteHint || ''),
              // P4 / 3: a cluster is a target of its own. Click/Enter zooms instead of picking a
              // member, so the user always sees what they are choosing.
              onClick: () => {
                if (bead.cluster) {
                  zoomToCluster(bead)
                  return
                }
                onSelect(bead.id)
                focusOn(bead)
              },
              onPointerEnter: () =>
                onHover(
                  bead.cluster
                    ? { id: bead.id, name: bead.count + ' ' + (dict.clusterGroup || '个工作区'), x: bead.x, y: bead.y, radius: bead.radius }
                    : { id: bead.id, name: bead.node.name, x: bead.x, y: bead.y, radius: bead.radius },
                ),
              onPointerLeave: () => onHover(null),
              onFocus: () => {
                setFocusId(bead.id)
                setRovingId(bead.id)
                if (loupeOn) setLoupeAt({ x: bead.x, y: bead.y })
                onHover(
                  bead.cluster
                    ? { id: bead.id, name: bead.count + ' ' + (dict.clusterGroup || '个工作区'), x: bead.x, y: bead.y, radius: bead.radius }
                    : { id: bead.id, name: bead.node.name, x: bead.x, y: bead.y, radius: bead.radius },
                )
              },
              onBlur: () => {
                setFocusId(null)
                onHover(null)
              },
              style: {
                position: 'absolute',
                left: bead.x + 'px',
                top: bead.y + 'px',
                width: beadButtonSize(bead.radius) + 'px',
                height: beadButtonSize(bead.radius) + 'px',
                // a cluster marker reads as a group: dashed ring instead of a solid bead look
                outline: bead.cluster ? '1px dashed rgba(190, 210, 255, 0.55)' : 'none',
                outlineOffset: bead.cluster ? '3px' : '0',
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                padding: 0,
                margin: 0,
                pointerEvents: 'auto',
                cursor: 'pointer',
              },
            }),
          ),
        ),
        h(
          'div',
          {
            style: {
              position: 'absolute',
              right: 10,
              bottom: 10,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            },
          },
          h('span', {
            'aria-hidden': true,
            title: dict.renderer,
            style: { fontSize: 11, color: 'rgba(255,255,255,0.45)', marginRight: 4 },
          }, (liveKind ? liveKind + ' · ' : '') + dict.dragHint),
          h('button', { type: 'button', 'aria-label': dict.zoomOut, onClick: () => zoomBy(1 / 1.25), style: controlStyle }, '−'),
          h('button', { type: 'button', 'aria-label': dict.zoomIn, onClick: () => zoomBy(1.25), style: controlStyle }, '+'),
          h('button', { type: 'button', 'aria-label': dict.resetView, onClick: resetView, style: controlStyle }, '⟲'),
          h(
            'button',
            {
              type: 'button',
              'aria-label': dict.magnifier,
              title: dict.magnifier,
              'aria-pressed': loupeOn,
              onClick: () =>
                setLoupeOn((on) => {
                  if (on) setLoupeAt(null)
                  return !on
                }),
              style: Object.assign({}, controlStyle, loupeOn ? { borderColor: 'rgba(125, 211, 252, 0.9)' } : null),
            },
            '🔍',
          ),
        ),
        rendererNotice
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  position: 'absolute',
                  left: 10,
                  bottom: 48,
                  maxWidth: '72%',
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: 'rgba(255,255,255,0.62)',
                  pointerEvents: 'none',
                },
              },
              rendererNoticeText(dict, rendererNotice),
            )
          : null,
        h(
          'div',
          {
            style: {
              position: 'absolute',
              left: 10,
              bottom: 10,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            },
          },
          h(
            'select',
            {
              'aria-label': dict.renderer,
              title: dict.renderer,
              value: rendererId,
              onChange: (event) => setRendererId(event.target.value),
              style: Object.assign({}, controlStyle, { width: 'auto', padding: '0 6px', fontSize: 12 }),
            },
            ['auto', 'canvas', 'three'].map((id) => h('option', { key: id, value: id }, id)),
          ),
          h(
            'select',
            {
              'aria-label': dict.theme,
              value: themeId,
              onChange: (event) => setThemeId(themeById(event.target.value).id),
              style: Object.assign({}, controlStyle, { width: 'auto', padding: '0 6px', fontSize: 12 }),
            },
            THEMES.map((theme) => h('option', { key: theme.id, value: theme.id }, theme.id)),
          ),
          h('input', {
            type: 'color',
            'aria-label': dict.accent,
            title: dict.accent,
            value: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : (themeById(themeId).rampHigh),
            onChange: (event) => setAccent(event.target.value),
            style: {
              width: 30,
              height: 28,
              padding: 2,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'rgba(12,18,34,0.72)',
              cursor: 'pointer',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              'aria-label': pulses ? dict.pulseStop : dict.pulseStart,
              title: pulses ? dict.pulseStop : dict.pulseStart,
              'aria-pressed': pulses,
              onClick: () => setPulses((current) => !current),
              style: Object.assign({}, controlStyle, { width: 30 }),
            },
            '◍',
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': spinning ? dict.spinStop : dict.spinStart,
              title: spinning ? dict.spinStop : dict.spinStart,
              onClick: () => setSpinning((current) => !current),
              style: Object.assign({}, controlStyle, { width: 30 }),
            },
            spinning ? '⏸' : '▶',
          ),
        ),
      )
    }

    /**
     * Last line of defence. A throw inside the page body would otherwise blank the whole slot
     * entry with nothing to read; this renders the message and stack in place instead, so a
     * regression is visible (and reportable) rather than silent.
     */
    class RenderGuard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        const error = this.state.error
        if (!error) return this.props.children
        return h(
          'div',
          {
            role: 'alert',
            style: {
              padding: 16,
              color: '#ffb4b4',
              background: '#1a0b10',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflow: 'auto',
              height: '100%',
            },
          },
          '元婴识海渲染出错：' + String((error && error.message) || error),
          h('pre', { style: { marginTop: 10, margin: 0, opacity: 0.72 } }, String((error && error.stack) || '')),
        )
      }
    }

    const SKILLS_ENDPOINT = '/plugins/dsh-brain-workspaces/api/skills'

    /** 原生 <option> 不吃继承色，必须逐个给背景与文字色，否则暗色主题下是白底白字。 */
    const OPTION_STYLE = { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }

    /**
     * 术法蒸馏浮层：只画 DOM，不碰 canvas / three.js。
     * 数据来自 `/api/skills`（按需查询 + 30 秒缓存），打开时才拉一次。
     */
    function SkillsOverlay(props) {
      const { dict, localeId, report, onClose, onRetry, onAction, busyKey, actionMessage } = props
      const body = report.data && report.data.ok ? report.data : null
      // null = 跟随默认（只展开当前光点 / 复用最多的那个）；true/false = 用户点了全部展开/收起。
      const [expandAll, setExpandAll] = useState(null)
      // 筛选维度：关键词（技能名/工作区名）、来源、工作区、只看未使用。全部在前端算，不额外打接口。
      const [filters, setFilters] = useState({ q: '', scope: 'all', workspace: '', unusedOnly: false })
      const matchesFilters = (skill, workspace) => {
        if (filters.scope !== 'all' && skill.scope !== filters.scope) return false
        if (filters.unusedOnly && skill.loads !== 0) return false
        if (filters.workspace && workspace.path !== filters.workspace) return false
        const q = filters.q.trim().toLowerCase()
        if (!q) return true
        return skill.name.toLowerCase().includes(q) || workspace.name.toLowerCase().includes(q) || (skill.description || '').toLowerCase().includes(q)
      }

      // 删除是两步：先点「删除」进入确认态，再点「确认」才发请求。
      const [confirmKey, setConfirmKey] = useState('')
      // A 区默认只摆 6 个可提升技能，其余折叠。
      const [showAllPromotable, setShowAllPromotable] = useState(false)
      // 「项目专用」的技能加入全局前要再点一次确认：提示不是禁令，但值得再看一眼。
      const [confirmGlobalize, setConfirmGlobalize] = useState('')
      // 已忽略清单默认收起，入口是显式按钮，数量一直可见。
      const [showIgnored, setShowIgnored] = useState(false)
      // 「加入全局」之前先看原文：一次只预览一个，再点一次收起。
      const [preview, setPreview] = useState({ key: '', status: 'idle', text: '', error: '', truncated: false })
      const loadPreview = (key, workspacePath, name) => {
        if (preview.key === key && preview.status !== 'idle') {
          setPreview({ key: '', status: 'idle', text: '', error: '', truncated: false })
          return
        }
        setPreview({ key, status: 'loading', text: '', error: '', truncated: false })
        const query = '?workspace=' + encodeURIComponent(workspacePath) + '&name=' + encodeURIComponent(name)
        fetch(SKILLS_ENDPOINT + '/preview' + query, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.message || payload.error || 'HTTP ' + response.status)
            return payload
          })
          .then((payload) => setPreview({ key, status: 'ready', text: payload.text || '', error: '', truncated: Boolean(payload.truncated) }))
          .catch((error) => setPreview({ key, status: 'error', text: '', error: String((error && error.message) || error), truncated: false }))
      }

      const rowKey = (workspace, skill, kind) => kind + ':' + workspace.path + ':' + skill.name
      const isBusy = (workspace, skill, kind) => busyKey === rowKey(workspace, skill, kind)

      /** 一行技能的操作区：蒸馏 +（低频时）删除两步确认。 */
      const rowActions = (workspace, skill) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              'data-skill-action': 'distill',
              disabled: isBusy(workspace, skill, 'distill'),
              onClick: () => onAction('distill', { workspacePath: workspace.path, name: skill.name, loads: skill.loads }),
              style: Object.assign({}, OVERLAY_BUTTON, { height: 22, fontSize: 11 }),
            },
            isBusy(workspace, skill, 'distill') ? dict.skillsWorking : dict.skillsDistillAction,
          ),
          skill.removable
            ? confirmKey === rowKey(workspace, skill, 'trash')
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-skill-action': 'trash-confirm',
                      disabled: isBusy(workspace, skill, 'trash'),
                      onClick: () => {
                        setConfirmKey('')
                        onAction('trash', { workspacePath: workspace.path, name: skill.name, loads: skill.loads })
                      },
                      style: Object.assign({}, OVERLAY_BUTTON, { height: 22, fontSize: 11, borderColor: PALETTE.warn, color: PALETTE.warn }),
                    },
                    isBusy(workspace, skill, 'trash') ? dict.skillsWorking : dict.skillsTrashConfirm,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setConfirmKey(''),
                      style: Object.assign({}, OVERLAY_BUTTON, { height: 22, fontSize: 11 }),
                    },
                    dict.skillsTrashCancel,
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    'data-skill-action': 'trash',
                    onClick: () => setConfirmKey(rowKey(workspace, skill, 'trash')),
                    style: Object.assign({}, OVERLAY_BUTTON, { height: 22, fontSize: 11 }),
                  },
                  dict.skillsTrash,
                )
            : null,
        )

      const stat = (value, label) =>
        h(
          'div',
          {
            style: {
              flex: '1 1 110px',
              border: '1px solid ' + PALETTE.border,
              borderRadius: 8,
              padding: '8px 10px',
              minWidth: 96,
            },
          },
          h('div', { style: { fontSize: 18, fontWeight: 600, lineHeight: 1.25 } }, String(value)),
          h('div', { style: { fontSize: 11, color: PALETTE.textFaint, marginTop: 2 } }, label),
        )

      const maxLoads = body
        ? Math.max(1, ...body.workspaces.flatMap((workspace) => workspace.skills.map((skill) => skill.loads)))
        : 1

      const bar = (value) =>
        h(
          'div',
          { style: { height: 3, borderRadius: 2, background: 'rgba(128,128,128,.18)', marginTop: 5, overflow: 'hidden' } },
          h('div', {
            style: {
              width: Math.max(2, Math.round((value / maxLoads) * 100)) + '%',
              height: '100%',
              background: PALETTE.brand,
              opacity: 0.7,
              borderRadius: 2,
            },
          }),
        )

      const chip = (text, tone) =>
        h(
          'span',
          {
            style: {
              fontSize: 10.5,
              padding: '0 6px',
              borderRadius: 999,
              border: '1px solid ' + (tone || PALETTE.border),
              color: tone || PALETTE.textSoft,
              whiteSpace: 'nowrap',
            },
          },
          text,
        )

      // 每个工作区一张可折叠卡：默认只展开「当前光点」或复用最多的那一个，
      // 其余收起成一行摘要，免得二十个工作区一次铺满。
      // 0 次加载的项目级技能归到 C3 子块，主列表只留有使用记录的那些，避免同一行出现两次。
      const isUnused = (skill) => skill.loads === 0 && skill.scope === 'project'

      const workspaceCard = (workspace, index) => {
        const visibleSkills = workspace.skills.filter((skill) => matchesFilters(skill, workspace))
        const activeSkills = visibleSkills.filter((skill) => !isUnused(skill))
        const unusedSkills = visibleSkills.filter(isUnused)
        if (!visibleSkills.length && (filters.q || filters.scope !== 'all' || filters.workspace || filters.unusedOnly)) return null
        return h(
          'details',
          {
            key: workspace.path + '|' + (expandAll === null ? 'auto' : String(expandAll)),
            open: expandAll === null ? Boolean(workspace.selected) || index === 0 : expandAll,
            style: {
              border: '1px solid ' + PALETTE.border,
              borderRadius: 9,
              padding: '10px 12px',
              marginBottom: 10,
              background: PALETTE.surface,
            },
          },
          h(
            'summary',
            { style: { cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, workspace.name),
            workspace.selected ? chip(dict.skillsCurrent, PALETTE.brand) : null,
            h(
              'span',
              { style: { fontSize: 11, color: PALETTE.textFaint } },
              workspace.skills.length + ' ' + dict.skillsCount,
            ),
            h(
              'span',
              { style: { marginLeft: 'auto', fontSize: 11.5, color: PALETTE.textSoft, whiteSpace: 'nowrap' } },
              workspace.loads + ' ' + dict.skillsLoadsUnit + ' · ' + workspace.sessions + ' ' + dict.skillsSessionsUnit,
            ),
          ),
          h('div', { style: { fontSize: 10.5, color: PALETTE.textFaint, margin: '4px 0 2px', wordBreak: 'break-all' } }, workspace.path),
          (() => {
            if (!activeSkills.length) {
              return h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint, marginTop: 4 } }, dict.skillsEmpty)
            }
            return activeSkills.map((skill, index) =>
                h(
                  'div',
                  {
                    key: workspace.path + ':' + skill.name,
                    style: {
                      padding: '7px 0 5px',
                      borderTop: index === 0 ? 'none' : '1px dashed ' + PALETTE.border,
                      marginTop: 4,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
                    h(
                      'code',
                      { style: { fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                      skill.name,
                    ),
                    chip(skill.scope === 'project' ? dict.skillsScopeProject : dict.skillsScopeUser),
                    h(
                      'span',
                      {
                        style: {
                          marginLeft: 'auto',
                          fontSize: 11.5,
                          color: skill.loads ? PALETTE.textSoft : PALETTE.textFaint,
                          whiteSpace: 'nowrap',
                        },
                      },
                      skill.loads
                        ? skill.loads + ' ' + dict.skillsLoadsUnit + ' · ' + skill.sessions + ' ' + dict.skillsSessionsUnit
                        : dict.skillsNever,
                    ),
                  ),
                  skill.description
                    ? h(
                        'div',
                        {
                          style: {
                            fontSize: 11.5,
                            lineHeight: 1.5,
                            color: PALETTE.textFaint,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            marginTop: 2,
                          },
                        },
                        skill.description,
                      )
                    : null,
                  bar(skill.loads),
                  skill.lastUsed
                    ? h(
                        'div',
                        { style: { fontSize: 10.5, color: PALETTE.textFaint, marginTop: 3 } },
                        formatTime(skill.lastUsed, localeId),
                      )
                    : null,
                  props.readOnly ? null : rowActions(workspace, skill),
                ),
              )
          })(),
          (() => {
            if (!unusedSkills.length) return null
            return h(
              'details',
              { key: 'unused', style: { marginTop: 6, fontSize: 11.5 } },
              h(
                'summary',
                { style: { cursor: 'pointer', color: PALETTE.textSoft } },
                dict.skillsUnusedTitle + ' (' + unusedSkills.length + ')',
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 } },
                unusedSkills.map((skill) =>
                  h(
                    'div',
                    {
                      key: 'unused:' + skill.name,
                      style: { padding: '4px 0', borderTop: '1px dashed ' + PALETTE.border },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                      h(
                        'code',
                        { style: { fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                        skill.name,
                      ),
                      h('span', { style: { fontSize: 10.5, color: PALETTE.textFaint } }, dict.skillsNever),
                      h('span', { style: { marginLeft: 'auto', color: PALETTE.textFaint, fontSize: 10.5 } }, formatTime(skill.mtime, localeId)),
                    ),
                    props.readOnly ? null : rowActions(workspace, skill),
                  ),
                ),
              ),
            )
          })(),
        )
      }

      const panelChildren = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 } },
          h(
            'div',
            null,
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, dict.skillsDistill),
            h(
              'div',
              { style: { fontSize: 11.5, color: PALETTE.textFaint, marginTop: 2 } },
              body
                ? dict.skillsGenerated +
                  ' ' +
                  formatTime(body.generatedAt, localeId) +
                  ' · ' +
                  dict.skillsSessionsScanned +
                  ' ' +
                  body.source.sessionsScanned
                : dict.skillsSubtitle,
            ),
          ),
          h(
            'button',
            {
              key: 'expand-all',
              type: 'button',
              'data-brain-skills-expand': 'true',
              onClick: () => setExpandAll((current) => current !== true),
              style: Object.assign({}, OVERLAY_BUTTON, { marginLeft: 'auto' }),
            },
            expandAll === true ? dict.skillsCollapseAll : dict.skillsExpandAll,
          ),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              onClick: onClose,
              style: Object.assign({}, OVERLAY_BUTTON, { marginLeft: 8 }),
            },
            dict.skillsClose,
          ),
        ),
      ]

      if (report.status === 'loading') {
        panelChildren.push(h('div', { key: 'loading', style: { fontSize: 12.5, color: PALETTE.textSoft } }, dict.skillsLoading))
      } else if (!body) {
        panelChildren.push(
          h(
            'div',
            { key: 'failed', style: { fontSize: 12.5, color: PALETTE.warn } },
            dict.skillsFailed + (report.error ? '：' + report.error : ''),
          ),
          h(
            'button',
            { key: 'retry', type: 'button', onClick: onRetry, style: Object.assign({}, OVERLAY_BUTTON, { marginTop: 8 }) },
            dict.skillsRetry,
          ),
        )
      } else {
        // A. 可提升为全局的项目技能。列表只摆事实：热度、项目标识、使用记录、内容指纹。
        // 「推荐」这个词从这里彻底消失：够热不再等于推荐全局（2026-11-22 用户确认）。
        const promotable = Array.isArray(body.promotable) ? body.promotable : []
        const promotedRecords = Array.isArray(body.promoted) ? body.promoted : []
        const visible = promotable.slice(0, showAllPromotable ? promotable.length : 6)
        const markerLabel = (kind) =>
          ({
            drive: dict.skillsMarkerDrive,
            workspace: dict.skillsMarkerWorkspace,
            package: dict.skillsMarkerPackage,
            host: dict.skillsMarkerHost,
            port: dict.skillsMarkerPort,
          })[kind] || String(kind)
        const statusText = (status) =>
          ({
            'project-specific': dict.skillsStatusProject,
            portable: dict.skillsStatusPortable,
            'needs-structure': dict.skillsStatusNeedsStructure,
            'pending-verification': dict.skillsStatusPending,
            verified: dict.skillsStatusVerified,
            unknown: dict.skillsStatusUnknown,
          })[status] || dict.skillsStatusUnknown
        // 依据行：热度 → 使用记录 → 项目标识 → 结构。每一项都说清楚它是"记录"还是"事实"。
        const basisLine = (item) => {
          const markers = Array.isArray(item.markers) ? item.markers : []
          const structure = item.structure || {}
          const parts = [
            String(item.loads ?? 0) + ' ' + dict.skillsLoadsUnit + ' · ' + dict.skillsBasisVersionUnknown,
            String(item.recordedWorkspaces ?? 0) + ' ' + dict.skillsBasisWorkspaceRecord,
          ]
          if (item.workspacesUsed > 0) parts.push(item.workspacesUsed + ' ' + dict.skillsBasisSameContent)
          parts.push(
            markers.length
              ? dict.skillsBasisMarkers +
                  '：' +
                  markers.map((marker) => markerLabel(marker.kind) + '「' + marker.snippet + '」').join('、')
              : dict.skillsBasisNoMarkers,
          )
          if (structure.trigger) parts.push(dict.skillsBasisTrigger)
          if (structure.steps) parts.push(dict.skillsBasisSteps)
          return parts.join(' · ')
        }
        panelChildren.push(
          h(
            'div',
            { key: 'recommended', style: { marginBottom: 14 } },
            h(
              'div',
              { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } },
              dict.skillsRecommended + (promotable.length ? ' (' + promotable.length + ')' : ''),
            ),
            h('div', { style: { fontSize: 11, color: PALETTE.textFaint, marginBottom: 6 } }, dict.skillsHintNotVerdict),
            promotable.length
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  visible.map((item) => {
                    const key = 'rec:' + item.workspacePath + ':' + item.name
                    const previewing = preview.key === key
                    return h(
                      'div',
                      {
                        key,
                        style: {
                          border: '1px solid ' + PALETTE.border,
                          borderRadius: 8,
                          padding: '8px 10px',
                          background: PALETTE.surface,
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        h(
                          'code',
                          { style: { fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                          item.name,
                        ),
                        chip(
                          statusText(item.status),
                          item.status === 'project-specific' ? PALETTE.textSoft : PALETTE.brand,
                        ),
                        chip(item.workspace),
                        h(
                          'span',
                          { style: { fontSize: 11, color: PALETTE.textFaint } },
                          item.loads + ' ' + dict.skillsLoadsUnit + ' · ' + item.sessions + ' ' + dict.skillsSessionsUnit,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-skill-action': 'preview',
                            onClick: () => loadPreview(key, item.workspacePath, item.name),
                            style: Object.assign({}, OVERLAY_BUTTON, { marginLeft: 'auto', height: 24, fontSize: 11.5 }),
                          },
                          previewing ? dict.skillsPreviewHide : dict.skillsPreview,
                        ),
                        props.readOnly
                          ? null
                          : h(
                              React.Fragment,
                              null,
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-skill-action':
                                    item.status === 'project-specific' && confirmGlobalize === key
                                      ? 'globalize-confirm'
                                      : 'globalize',
                                  title: item.status === 'project-specific' ? dict.skillsHintNotVerdict : undefined,
                                  onClick: () => {
                                    // 项目专用只是提示，不禁用；但加入全局前值得再看一眼，所以两步。
                                    if (item.status === 'project-specific' && confirmGlobalize !== key) {
                                      setConfirmGlobalize(key)
                                      return
                                    }
                                    setConfirmGlobalize('')
                                    onAction('globalize', { workspacePath: item.workspacePath, name: item.name, loads: item.loads })
                                  },
                                  style: Object.assign({}, OVERLAY_BUTTON, { height: 24, fontSize: 11.5 }),
                                },
                                item.status === 'project-specific' && confirmGlobalize === key
                                  ? dict.skillsGlobalizeConfirm
                                  : dict.skillsGlobalize,
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-skill-action': 'ignore',
                                  title: dict.skillsIgnoreHint,
                                  onClick: () => onAction('ignore', { workspacePath: item.workspacePath, name: item.name }),
                                  style: Object.assign({}, OVERLAY_BUTTON, { height: 24, fontSize: 11.5 }),
                                },
                                dict.skillsIgnore,
                              ),
                            ),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            fontSize: 11,
                            lineHeight: 1.5,
                            color: PALETTE.textSoft,
                            marginTop: 4,
                            wordBreak: 'break-word',
                          },
                        },
                        basisLine(item),
                      ),
                      item.description
                        ? h(
                            'div',
                            {
                              style: {
                                fontSize: 11.5,
                                lineHeight: 1.5,
                                color: PALETTE.textFaint,
                                marginTop: 3,
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              },
                            },
                            item.description,
                          )
                        : null,
                      previewing
                        ? h(
                            'pre',
                            {
                              style: {
                                margin: '6px 0 0',
                                padding: '8px 10px',
                                maxHeight: 220,
                                overflow: 'auto',
                                fontSize: 11,
                                lineHeight: 1.5,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                background: PALETTE.surfaceRaised,
                                border: '1px solid ' + PALETTE.border,
                                borderRadius: 6,
                                color: PALETTE.textSoft,
                              },
                            },
                            preview.status === 'loading'
                              ? dict.skillsPreviewLoading
                              : preview.status === 'error'
                                ? dict.skillsPreviewFailed + '：' + preview.error
                                : preview.text + (preview.truncated ? '\n…（已截断）' : ''),
                          )
                        : null,
                    )
                  }),
                  promotable.length > 6
                    ? h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => setShowAllPromotable((current) => !current),
                          style: Object.assign({}, OVERLAY_BUTTON, { alignSelf: 'flex-start', height: 24, fontSize: 11.5 }),
                        },
                        showAllPromotable ? dict.skillsShowLess : dict.skillsShowAll + ' ' + promotable.length,
                      )
                    : null,
                )
              : h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.skillsRecommendedEmpty),
            // 已加入全局的记录（状态账本）：加入时间 + 加入时指纹 + 是否改动 + 使用记录。
            // 这里不写"已验证通用"：那需要人工验收，本期没有写它的入口。
            promotedRecords.length
              ? h(
                  'div',
                  { key: 'promoted', style: { marginTop: 10, fontSize: 11.5 } },
                  h(
                    'div',
                    { style: { color: PALETTE.textSoft, marginBottom: 4 } },
                    dict.skillsPromotedTitle + ' (' + promotedRecords.length + ')',
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    promotedRecords.map((item) =>
                      h(
                        'div',
                        {
                          key: 'promoted:' + item.name,
                          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                        },
                        h(
                          'code',
                          { style: { fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                          item.name,
                        ),
                        chip(statusText(item.status), item.status === 'verified' ? PALETTE.brand : PALETTE.textSoft),
                        item.fromName ? chip(item.fromName) : null,
                        item.at
                          ? h(
                              'span',
                              { style: { fontSize: 10.5, color: PALETTE.textFaint } },
                              dict.skillsPromotedAt + ' ' + formatTime(Date.parse(item.at) || 0, localeId),
                            )
                          : null,
                        h(
                          'span',
                          { style: { fontSize: 10.5, color: PALETTE.textFaint } },
                          dict.skillsPromotedHash + ' ' + (item.hash || '—'),
                        ),
                        h(
                          'span',
                          { style: { fontSize: 10.5, color: PALETTE.textFaint } },
                          item.loads + ' ' + dict.skillsLoadsUnit + ' · ' + item.workspacesUsed + ' ' + dict.skillsBasisWorkspaceRecord + '（' + dict.skillsPromotedUsage + '）',
                        ),
                        item.hashChanged
                          ? h('span', { style: { fontSize: 10.5, color: PALETTE.textSoft } }, dict.skillsPromotedChanged)
                          : null,
                        item.existsGlobal
                          ? null
                          : h('span', { style: { fontSize: 10.5, color: PALETTE.textSoft } }, dict.skillsPromotedMissing),
                      ),
                    ),
                  ),
                )
              : null,
            // 账本坏了要说话：否则「已加入全局」整块静默消失，看着像从来没加入过。
            body.scopeLedger && body.scopeLedger.reason === 'broken'
              ? h(
                  'div',
                  { key: 'ledger-broken', style: { marginTop: 8, fontSize: 11, color: PALETTE.textSoft } },
                  dict.skillsScopeLedgerBroken,
                )
              : null,
            // 已忽略：清单是权威（DSH_HOME 落盘，跨会话生效），入口是显式按钮、数量常驻可见。
            body.ignoredPromotions && body.ignoredPromotions.length
              ? h(
                  'div',
                  { key: 'ignored', style: { marginTop: 8, fontSize: 11.5 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-skill-action': 'show-ignored',
                      onClick: () => setShowIgnored((current) => !current),
                      style: Object.assign({}, OVERLAY_BUTTON, { height: 24, fontSize: 11.5 }),
                    },
                    (showIgnored ? dict.skillsIgnoredHide : dict.skillsIgnoredShow) + ' (' + body.ignoredPromotions.length + ')',
                  ),
                  showIgnored
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
                        body.ignoredPromotions.map((item) =>
                          h(
                            'div',
                            {
                              key: 'ignored:' + item.workspacePath + ':' + item.name,
                              style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                            },
                            h(
                              'code',
                              { style: { fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                              item.name,
                            ),
                            item.workspace ? chip(item.workspace) : null,
                            item.unmatched
                              ? h('span', { style: { fontSize: 10.5, color: PALETTE.textFaint } }, dict.skillsIgnoredUnmatched)
                              : null,
                            item.ignoredAt
                              ? h('span', { style: { fontSize: 10.5, color: PALETTE.textFaint } }, formatTime(Date.parse(item.ignoredAt) || 0, localeId))
                              : null,
                            props.readOnly
                              ? null
                              : h(
                                  'button',
                                  {
                                    type: 'button',
                                    'data-skill-action': 'unignore',
                                    onClick: () => onAction('unignore', { workspacePath: item.workspacePath, name: item.name }),
                                    style: Object.assign({}, OVERLAY_BUTTON, { marginLeft: 'auto', height: 22, fontSize: 11 }),
                                  },
                                  dict.skillsRestore,
                                ),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
          ),
        )

        // B. 原有指标条（五个原值，口径不变）
        panelChildren.push(
          h(
            'div',
            { key: 'stats', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
            stat(body.totals.loads, dict.skillsLoadsTotal),
            stat(body.totals.usedSkills ?? body.totals.skills, dict.skillsUsed),
            stat(body.totals.workspacesWithSkills, dict.skillsWorkspaces),
            stat(body.totals.sessionsWithSkill ?? 0, dict.skillsSessionsUsed),
            stat(
              body.evolution && body.evolution.available
                ? body.evolution.suggestions + '（' + dict.skillsPending + ' ' + (body.evolution.suggestionStatus.pending || 0) + ' / ' + dict.skillsAdopted + ' ' + (body.evolution.suggestionStatus.adopted || 0) + '）'
                : '—',
              dict.skillsSuggestions,
            ),
          ),
        )

        if (actionMessage && actionMessage.text) {
          panelChildren.push(
            h(
              'div',
              {
                key: 'action-message',
                style: {
                  fontSize: 11.5,
                  marginBottom: 8,
                  color: actionMessage.tone === 'error' ? PALETTE.warn : PALETTE.textSoft,
                },
              },
              actionMessage.text,
            ),
          )
        }

        // 筛选条：关键词 / 来源 / 工作区 / 只看未使用
        panelChildren.push(
          h(
            'div',
            { key: 'filters', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 } },
            h('input', {
              type: 'search',
              'data-skill-filter': 'q',
              value: filters.q,
              placeholder: dict.skillsFilterSearch,
              onChange: (event) => {
                const value = event.target.value
                setFilters((current) => ({ ...current, q: value }))
              },
              style: {
                flex: '1 1 180px',
                minWidth: 140,
                height: 26,
                padding: '0 8px',
                fontSize: 12,
                borderRadius: 6,
                border: '1px solid ' + PALETTE.border,
                background: PALETTE.surfaceRaised,
                color: PALETTE.text,
                font: 'inherit',
              },
            }),
            h(
              'select',
              {
                'data-skill-filter': 'scope',
                value: filters.scope,
                onChange: (event) => {
                  const value = event.target.value
                  setFilters((current) => ({ ...current, scope: value }))
                },
                style: Object.assign({}, OVERLAY_BUTTON, {
                  height: 26,
                  fontSize: 11.5,
                  padding: '0 6px',
                  // 原生下拉的弹层用的是它自己的底色：不显式给背景，暗色主题下就是白底白字。
                  background: PALETTE.surfaceRaised,
                  color: PALETTE.text,
                }),
              },
              h('option', { value: 'all', style: OPTION_STYLE }, dict.skillsFilterAllScopes),
              h('option', { value: 'project', style: OPTION_STYLE }, dict.skillsScopeProject),
              h('option', { value: 'user', style: OPTION_STYLE }, dict.skillsScopeUser),
            ),
            h(
              'select',
              {
                'data-skill-filter': 'workspace',
                value: filters.workspace,
                onChange: (event) => {
                  const value = event.target.value
                  setFilters((current) => ({ ...current, workspace: value }))
                },
                style: Object.assign({}, OVERLAY_BUTTON, {
                  height: 26,
                  fontSize: 11.5,
                  padding: '0 6px',
                  maxWidth: 200,
                  background: PALETTE.surfaceRaised,
                  color: PALETTE.text,
                }),
              },
              h('option', { value: '', style: OPTION_STYLE }, dict.skillsFilterAllWorkspaces),
              body.workspaces
                .filter((workspace) => workspace.skills.length > 0)
                .map((workspace) =>
                  h('option', { key: workspace.path, value: workspace.path, style: OPTION_STYLE }, workspace.name),
                ),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: PALETTE.textSoft } },
              h('input', {
                type: 'checkbox',
                'data-skill-filter': 'unused',
                checked: filters.unusedOnly,
                onChange: (event) => {
                  const checked = event.target.checked
                  setFilters((current) => ({ ...current, unusedOnly: checked }))
                },
              }),
              dict.skillsFilterUnusedOnly,
            ),
          ),
        )

        // C. 按工作区分区
        panelChildren.push(
          h(
            'div',
            { key: 'list', style: { display: 'flex', flexDirection: 'column' } },
            (() => {
              const cards = body.workspaces.filter((workspace) => workspace.skills.length > 0).map(workspaceCard).filter(Boolean)
              return cards.length ? cards : h('div', { style: { fontSize: 12, color: PALETTE.textFaint } }, dict.skillsFilterEmpty)
            })(),
          ),
        )
        // 全局级里也从没被用过的技能（工作区级的那部分已各自归位到 C3 子块，避免重复）
        const globalUnused = body.unused.filter((item) => !item.workspace)
        if (globalUnused.length) {
          panelChildren.push(
            h(
              'details',
              { key: 'unused', style: { marginTop: 6, fontSize: 12 } },
              h('summary', { style: { cursor: 'pointer', color: PALETTE.textSoft } }, dict.skillsUnusedTitle + ' (' + globalUnused.length + ')'),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 } },
                globalUnused.slice(0, 30).map((item, index) =>
                  h(
                    'div',
                    { key: item.name + ':' + index, style: { fontSize: 11.5, color: PALETTE.textFaint } },
                    h(
                      'code',
                      { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: PALETTE.textSoft } },
                      item.name,
                    ),
                    item.workspace ? ' · ' + item.workspace : '',
                  ),
                ),
              ),
            ),
          )
        }
        if (body.evolution && body.evolution.available) {
          panelChildren.push(
            h(
              'div',
              { key: 'evo', style: { marginTop: 10, fontSize: 11.5, color: PALETTE.textFaint, lineHeight: 1.6 } },
              dict.skillsEvolution +
                '：' +
                body.evolution.reviews +
                ' · ' +
                dict.skillsPending +
                ' ' +
                (body.evolution.suggestionStatus.pending || 0) +
                ' · ' +
                body.evolution.drafts +
                ' drafts',
            ),
          )
        }
      }

      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': dict.skillsDistill,
          'data-brain-skills-overlay': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
          style: {
            position: 'absolute',
            inset: 0,
            zIndex: 40,
            background: 'rgba(0,0,0,.38)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          },
        },
        h(
          'div',
          {
            style: {
              width: 'min(780px, 100%)',
              maxHeight: '100%',
              overflowY: 'auto',
              background: PALETTE.surfaceRaised,
              color: PALETTE.text,
              border: '1px solid ' + PALETTE.border,
              borderRadius: 12,
              padding: '14px 16px',
              boxShadow: '0 18px 48px rgba(0,0,0,.32)',
              boxSizing: 'border-box',
            },
          },
          panelChildren,
        ),
      )
    }

    const OVERLAY_BUTTON = {
      height: 26,
      padding: '0 10px',
      fontSize: 12,
      borderRadius: 6,
      border: '1px solid ' + PALETTE.border,
      background: 'transparent',
      color: PALETTE.text,
      cursor: 'pointer',
      font: 'inherit',
    }

    function createPage(ctx) {
      return function BrainWorkspacesPage() {
        const dict = useDict(ctx)
        const localeId = readLocaleId(ctx)
        const storeRef = useRef(null)
        if (storeRef.current === null) storeRef.current = createStore(safeStorage())

        const [state, setState] = useState({ rootPath: null, snapshot: null, assignments: {} })
        const [busy, setBusy] = useState(null)
        const [progress, setProgress] = useState(null)
        const [tick, setTick] = useState(0)
        const [notice, setNotice] = useState(null)
        const [selectedId, setSelectedId] = useState(null)
        const [hover, setHover] = useState(null)
        const [query, setQuery] = useState('')
        const abortRef = useRef(null)

        // 术法蒸馏：点详情卡按钮才拉一次数据，不参与星云扫描，也不进任何 renderer。
        const [skillsReport, setSkillsReport] = useState({ open: false, status: 'idle', data: null, error: '', workspace: null })
        const openSkills = useCallback((workspacePath, refresh) => {
          const params = []
          if (workspacePath) params.push('workspace=' + encodeURIComponent(workspacePath))
          if (refresh) params.push('refresh=1')
          const query = params.length ? '?' + params.join('&') : ''
          setSkillsReport((previous) => ({
            ...previous,
            open: true,
            // 刷新时保留旧数据，界面不闪白。
            status: previous.data ? 'ready' : 'loading',
            error: '',
            workspace: workspacePath || null,
          }))
          fetch(SKILLS_ENDPOINT + query, { credentials: 'same-origin', cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then((data) => setSkillsReport({ open: true, status: 'ready', data, error: '', workspace: workspacePath || null }))
            .catch((error) =>
              setSkillsReport((previous) => ({
                ...previous,
                open: true,
                status: previous.data ? 'ready' : 'failed',
                error: String((error && error.message) || error),
              })),
            )
        }, [])
        const closeSkills = useCallback(() => setSkillsReport((previous) => ({ ...previous, open: false })), [])

        // 写动作：蒸馏 / 删除 / 加入全局。成功后清缓存重拉，行数据由服务端决定。
        const [skillsAction, setSkillsAction] = useState({ busyKey: '', message: null })
        const runSkillsAction = useCallback((kind, target) => {
          const busyKey = kind + ':' + target.workspacePath + ':' + target.name
          setSkillsAction({ busyKey, message: null })
          fetch(SKILLS_ENDPOINT + '/' + kind, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: target.workspacePath, name: target.name, loads: target.loads }),
          })
            .then(async (response) => {
              const payload = await response.json().catch(() => ({}))
              if (!response.ok) throw new Error(payload.message || payload.error || 'HTTP ' + response.status)
              return payload
            })
            .then((payload) => {
              const changed = Array.isArray(payload.changed) ? payload.changed : []
              let text
              if (kind === 'distill') text = changed.length ? dict.skillsDistilledOk + '：' + changed.join('、') : dict.skillsNoop
              else if (kind === 'trash') {
                text = dict.skillsTrashedOk
                const removed = payload.ledger && payload.ledger.removed
                if (removed && removed.suggestions + removed.drafts + removed.versions > 0) {
                  text += ' · ' + dict.skillsLedgerCleaned + ' ' + [removed.suggestions, removed.drafts, removed.versions].join('/')
                }
              } else if (kind === 'ignore') text = dict.skillsIgnoredOk
              else if (kind === 'unignore') text = dict.skillsRestoredOk
              else text = dict.skillsGlobalizedOk
              setSkillsAction({ busyKey: '', message: { tone: 'ok', text: target.name + ' · ' + text } })
              openSkills(target.workspacePath, true)
            })
            .catch((error) => {
              setSkillsAction({
                busyKey: '',
                message: { tone: 'error', text: target.name + ' · ' + dict.skillsActionFailed + '：' + String((error && error.message) || error) },
              })
            })
        }, [dict, openSkills])

        // While a sweep runs, the elapsed reading ticks on its own: a single huge workspace
        // can take seconds without any event, and a frozen clock reads as a hung panel.
        useEffect(() => {
          if (!busy) return undefined
          const timer = setInterval(() => setTick(Date.now()), 500)
          return () => clearInterval(timer)
        }, [busy])

        const nodes = state.snapshot && Array.isArray(state.snapshot.workspaces) ? state.snapshot.workspaces : []
        const warnings = state.snapshot && Array.isArray(state.snapshot.warnings) ? state.snapshot.warnings : []
        const { positions } = useMemo(
          () => layout(nodes, BRAIN_SHAPE, { assignments: state.assignments }),
          [nodes, state.assignments],
        )

        const nodeById = useMemo(() => {
          const map = new Map()
          for (const node of nodes) map.set(node.id, node)
          return map
        }, [nodes])

        const partialIds = useMemo(() => {
          const ids = new Set()
          for (const warning of warnings) {
            if (!warning || !warning.workspaceId) continue
            if (
              warning.code === 'truncated-count' ||
              warning.code === 'truncated-depth' ||
              warning.code === 'timed-out'
            ) {
              ids.add(warning.workspaceId)
            }
          }
          return ids
        }, [warnings])

        // A scan that never reached the directory at all must not read as "this folder has
        // no subfolders": that would show an empty brain for a permissions or path problem.
        const blockingWarning = warnings.find(
          (warning) => warning && (warning.code === 'root-unavailable' || warning.code === 'too-broad-root'),
        )

        // Ramp anchor for the bead colors: the busiest workspace sets the gold end.
        const maxCount = useMemo(
          () => nodes.reduce((top, node) => Math.max(top, Number(node.directoryCount) || 0), 0),
          [nodes],
        )

        // Size anchor for the beads: the most-used workspace sets the largest radius.
        const maxSessions = useMemo(
          () => nodes.reduce((top, node) => Math.max(top, Number(node.sessionCount) || 0), 0),
          [nodes],
        )

        // Restore the last root and its cached snapshot on first paint.
        useEffect(() => {
          const store = storeRef.current
          if (!store) return
          const lastRoot = store.loadLastRoot()
          if (!lastRoot) return
          const saved = store.load(lastRoot)
          setState({
            rootPath: normalizePath(lastRoot),
            snapshot: (saved && saved.snapshot) || null,
            assignments: (saved && saved.assignments) || {},
          })
        }, [])

        const runScan = useCallback(
          async (rootPath) => {
            const normalizedRoot = normalizePath(rootPath)
            const store = storeRef.current
            const saved = store ? store.load(normalizedRoot) : null
            const previousAssignments = (saved && saved.assignments) || {}

            const controller = new AbortController()
            abortRef.current = controller
            setNotice(null)
            setBusy({ startedAt: Date.now() })
            setProgress(null)
            setQuery('')

            let model = emptyScanModel(normalizedRoot)
            model.assignments = previousAssignments
            let timer = null

            // Partial results become drawable state as they arrive. Slot assignments are
            // carried forward between updates, so a bead never moves once it appears.
            const publish = () => {
              timer = null
              const placed = layout(model.nodes, BRAIN_SHAPE, { assignments: model.assignments })
              model.assignments = placed.assignments
              setState({
                rootPath: normalizedRoot,
                snapshot: scanSnapshotFromModel(model),
                assignments: placed.assignments,
              })
              setProgress(
                Object.assign({}, scanSummaryFromModel(model), {
                  started: model.started,
                  complete: model.complete,
                  limitNotes: model.limitNotes,
                }),
              )
            }

            const schedule = () => {
              if (timer !== null) return
              timer = setTimeout(publish, PROGRESS_FLUSH_MS)
            }

            try {
              const scanner = createHttpScanner({})
              const snapshot = await scanner.scan({
                rootPath: normalizedRoot,
                signal: controller.signal,
                onEvent: (event) => {
                  model = reduceScanEvent(model, event)
                  if (event.type === 'start') {
                    // A fresh sweep starts from an empty brain: keeping the previous beads
                    // next to new numbers would read as if they were already counted.
                    model.nodes = []
                    publish()
                    return
                  }
                  if (event.type === 'done') {
                    publish()
                    return
                  }
                  schedule()
                },
              })

              // The `done` event already replaced the nodes with the final set; place them
              // with the assignments built up during the sweep, so nothing jumps at the end.
              const placed = layout(snapshot.workspaces, BRAIN_SHAPE, { assignments: model.assignments })
              model = Object.assign({}, model, {
                snapshot,
                complete: true,
                nodes: snapshot.workspaces,
                warnings: snapshot.warnings,
                assignments: placed.assignments,
              })
              setState({ rootPath: normalizedRoot, snapshot, assignments: placed.assignments })
              setProgress(
                Object.assign({}, scanSummaryFromModel(model), {
                  started: true,
                  complete: true,
                  limitNotes: model.limitNotes,
                }),
              )
              if (store) {
                // Only a complete sweep is cached; a half sweep must not pose as one later.
                store.saveLastRoot(normalizedRoot)
                store.save(normalizedRoot, { assignments: placed.assignments, snapshot })
              }
              // An incomplete sweep speaks through the persistent partial strip and the
              // header badge, so no one-shot notice repeats the same sentence here.
            } catch (error) {
              if (isAbortError(error)) {
                // Keep what arrived: a cancelled sweep is a partial result, not nothing.
                publish()
                setNotice({
                  kind: 'info',
                  text:
                    model.nodes.length > 0
                      ? dict.cancelledPartial(
                          formatCount(model.nodes.length),
                          formatCount(model.declared || model.nodes.length),
                        )
                      : dict.cancelled,
                })
              } else if (model.nodes.length > 0) {
                publish()
                setNotice({ kind: 'error', text: dict.scanFailed + '：' + describeError(error) })
              } else {
                setNotice({ kind: 'error', text: dict.scanFailed + '：' + describeError(error) })
              }
            } finally {
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
              setBusy(null)
              abortRef.current = null
            }
          },
          [ctx, dict],
        )

        const pickRoot = useCallback(async () => {
          const api = resolveUiWorkspace(ctx)
          if (!api || typeof api.pickDirectory !== 'function') {
            setNotice({ kind: 'error', text: dict.missingApi })
            return
          }
          let picked
          try {
            picked = await api.pickDirectory()
          } catch (error) {
            setNotice({ kind: 'error', text: dict.scanFailed + '：' + describeError(error) })
            return
          }
          if (!picked) return
          const root = normalizePath(picked)
          const broad = tooBroadReason(root)
          if (broad) {
            setNotice({ kind: 'error', text: broad })
            return
          }
          const store = storeRef.current
          const saved = store ? store.load(root) : null
          setSelectedId(null)
          setState({
            rootPath: root,
            snapshot: (saved && saved.snapshot) || null,
            assignments: (saved && saved.assignments) || {},
          })
          await runScan(root)
        }, [ctx, dict, runScan])

        const cancelScan = useCallback(() => {
          if (abortRef.current) abortRef.current.abort()
        }, [])

        const selected = selectedId ? nodeById.get(selectedId) : null
        const selectedPosition = selectedId ? positions.find((position) => position.id === selectedId) : null
        const selectedWarnings = selectedId
          ? warnings.filter((warning) => warning && warning.workspaceId === selectedId)
          : []
        // One row per kind: a scan can emit thousands of per-directory depth warnings.
        const selectedWarningGroups = groupWarnings(selectedWarnings, 4)
        const allWarningGroups = groupWarnings(warnings, 6)

        const needle = query.trim().toLowerCase()
        const matches = useCallback(
          (name) => needle === '' || String(name).toLowerCase().includes(needle),
          [needle],
        )

        const copyPath = useCallback(async (text) => {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(text)
            } else {
              const area = document.createElement('textarea')
              area.value = text
              area.setAttribute('readonly', '')
              area.style.position = 'fixed'
              area.style.opacity = '0'
              document.body.appendChild(area)
              area.select()
              document.execCommand('copy')
              document.body.removeChild(area)
            }
            setNotice({ kind: 'info', text: dict.copied })
          } catch {
            setNotice({ kind: 'error', text: dict.copyFailed })
          }
        }, [dict])

        const onPageKeyDown = useCallback((event) => {
          if (event.key === 'Escape') {
            setSelectedId(null)
            setHover(null)
          }
        }, [])

        const buttonStyle = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          padding: '0 12px',
          borderRadius: 8,
          border: '1px solid ' + PALETTE.border,
          background: PALETTE.surfaceRaised,
          color: PALETTE.text,
          fontSize: 13,
          cursor: 'pointer',
        }

        const hasRoot = Boolean(state.rootPath)

        // The server's elapsed reading between events is stale by design; the local clock
        // fills the gap so the number never freezes while one huge workspace is read.
        const shownProgress =
          busy && progress
            ? Object.assign({}, progress, {
                elapsedMs: Math.max(
                  Number(progress.elapsedMs) || 0,
                  busy.startedAt ? Math.max(0, tick - busy.startedAt) : 0,
                ),
              })
            : progress

        return h(
          'div',
          {
            onKeyDown: onPageKeyDown,
            style: {
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
              // 术法蒸馏浮层用 absolute 定位挂在这一层里，只盖住面板，不盖侧栏。
              position: 'relative',
              background: PALETTE.surface,
              color: PALETTE.text,
              fontSize: 13,
            },
          },

          // header
          h(
            'header',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 18px 10px',
                borderBottom: '1px solid ' + PALETTE.border,
                flexWrap: 'wrap',
              },
            },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 } },
                dict.title,
                state.snapshot && state.snapshot.scan && state.snapshot.scan.partial
                  ? h(
                      'span',
                      {
                        title: partialNoticeText(dict, state.snapshot),
                        style: {
                          fontSize: 10.5,
                          fontWeight: 600,
                          padding: '1px 7px',
                          borderRadius: 999,
                          border: '1px solid ' + PALETTE.warn,
                          color: PALETTE.warn,
                        },
                      },
                      dict.partialResult,
                    )
                  : null,
              ),
              h('div', { style: { fontSize: 12, color: PALETTE.textFaint } },
                state.snapshot ? dict.countNodes(nodes.length) + ' · ' + dict.subtitle : dict.subtitle),
            ),
            h('div', { style: { flex: 1 } }),
            // 术法蒸馏的常驻入口：没选光点时也能打开（详情卡里那颗按钮仍保留）。
            h(
              'button',
              {
                type: 'button',
                'data-brain-skills-header': 'true',
                title: dict.skillsDistillHint,
                onClick: () => openSkills(selected ? selected.path : ''),
                style: buttonStyle,
              },
              dict.skillsDistill,
            ),
            h('button', { type: 'button', onClick: pickRoot, style: buttonStyle }, dict.pickRoot),
            h(
              'button',
              {
                type: 'button',
                onClick: () => (state.rootPath ? runScan(state.rootPath) : pickRoot()),
                disabled: Boolean(busy),
                style: Object.assign({}, buttonStyle, busy ? { opacity: 0.55, cursor: 'default' } : null),
              },
              state.snapshot ? dict.refresh : dict.rescan,
            ),
            busy
              ? h('button', { type: 'button', onClick: cancelScan, style: buttonStyle }, dict.cancel)
              : null,
          ),

          // root + search row
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 18px',
                borderBottom: '1px solid ' + PALETTE.border,
                flexWrap: 'wrap',
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                  flex: '0 1 420px',
                  color: PALETTE.textSoft,
                },
              },
              h('span', { style: { color: PALETTE.textFaint, flex: 'none' } }, dict.root + '：'),
              h(
                'code',
                {
                  title: state.rootPath || '',
                  style: {
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 12,
                  },
                },
                state.rootPath || dict.noRoot,
              ),
            ),
            h('div', { style: { flex: 1 } }),
            h('input', {
              type: 'search',
              value: query,
              placeholder: dict.searchPlaceholder,
              'aria-label': dict.searchPlaceholder,
              onChange: (event) => setQuery(event.target.value),
              style: {
                width: 220,
                height: 28,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid ' + PALETTE.border,
                background: PALETTE.surfaceRaised,
                color: PALETTE.text,
                fontSize: 13,
                outline: 'none',
              },
            }),
            h(
              'span',
              {
                'aria-live': 'polite',
                title: hover ? hover.name : '',
                style: {
                  fontSize: 12,
                  color: PALETTE.textSoft,
                  maxWidth: 220,
                  minHeight: 16,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              hover ? hover.name : '',
            ),
          ),

          notice
            ? h(
                'div',
                {
                  role: 'status',
                  style: {
                    padding: '7px 18px',
                    fontSize: 12,
                    borderBottom: '1px solid ' + PALETTE.border,
                    color: notice.kind === 'error' ? PALETTE.error : PALETTE.textSoft,
                    background: notice.kind === 'error' ? 'transparent' : PALETTE.surfaceRaised,
                  },
                },
                notice.text,
              )
            : null,

          busy
            ? renderScanProgress(dict, shownProgress)
            : renderPartialStrip(dict, state.snapshot),

          // body
          h(
            'div',
            { style: { flex: 1, display: 'flex', minHeight: 0 } },

            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 12 } },
              nodes.length === 0
                ? renderEmptyState(dict, {
                    hasRoot,
                    failure: blockingWarning ? blockingWarning.message : '',
                    scanning: Boolean(busy),
                    progress: shownProgress,
                  })
                : h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        width: '100%',
                        height: '100%',
                        minHeight: 0,
                        gap: 8,
                      },
                    },
                    h(BrainCanvas, {
                      shape: BRAIN_SHAPE,
                      positions,
                      nodeById,
                      dict,
                      selectedId,
                      hoverId: hover ? hover.id : null,
                      query,
                      maxCount,
                      maxSessions,
                      partialIds,
                      onSelect: setSelectedId,
                      onHover: setHover,
                    }),
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexWrap: 'wrap',
                          gap: 8,
                          fontSize: 11.5,
                          color: PALETTE.textFaint,
                          flex: 'none',
                        },
                      },
                      h('span', null, dict.countLow),
                      h(
                        'div',
                        { style: { display: 'flex', borderRadius: 3, overflow: 'hidden' } },
                        BEAD_RAMP.map((rampColor) =>
                          h('span', {
                            key: rampColor,
                            style: { display: 'block', width: 14, height: 10, background: rampColor },
                          }),
                        ),
                      ),
                      h('span', null, dict.countHigh + ' · ' + dict.sizeHint),
                      h('span', null, '≤ ' + maxCount),
                    ),
                  ),
            ),

            // details
            h(
              'aside',
              {
                style: {
                  width: 300,
                  flex: 'none',
                  borderLeft: '1px solid ' + PALETTE.border,
                  padding: '14px 16px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                },
              },
              h('div', { style: { fontSize: 12, color: PALETTE.textFaint, letterSpacing: 0.4 } }, dict.details.toUpperCase()),

              selected
                ? h(
                    React.Fragment,
                    null,
                    h('div', { style: { fontSize: 15, fontWeight: 600, wordBreak: 'break-all' } }, selected.name),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h(
                        'span',
                        {
                          style: {
                            fontSize: 11,
                            padding: '1px 7px',
                            borderRadius: 999,
                            border: '1px solid ' + PALETTE.border,
                            color: selected.status === 'ready' ? PALETTE.textSoft : PALETTE.warn,
                          },
                        },
                        selected.status === 'ready'
                          ? dict.statusReady
                          : selected.status === 'unavailable'
                            ? dict.statusUnavailable
                            : dict.statusError,
                      ),
                      partialIds.has(selected.id)
                        ? h(
                            'span',
                            {
                              style: {
                                fontSize: 11,
                                padding: '1px 7px',
                                borderRadius: 999,
                                border: '1px solid ' + PALETTE.warn,
                                color: PALETTE.warn,
                              },
                            },
                            dict.partial,
                          )
                        : null,
                    ),

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.path),
                      h(
                        'code',
                        {
                          style: {
                            fontSize: 11.5,
                            lineHeight: 1.5,
                            wordBreak: 'break-all',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                            color: PALETTE.textSoft,
                          },
                        },
                        selected.path,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => copyPath(selected.path),
                          style: Object.assign({}, buttonStyle, { height: 26, padding: '0 10px', alignSelf: 'flex-start' }),
                        },
                        dict.copyPath,
                      ),
                    ),

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.dirCount),
                      h(
                        'div',
                        null,
                        partialIds.has(selected.id)
                          ? '≥ ' + selected.directoryCount + '（' + dict.partial + '）'
                          : String(selected.directoryCount),
                      ),
                    ),

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.sessions),
                      h('div', { title: dict.satelliteHint || '' }, sessionCountText(selected, dict)),
                    ),

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.lastSession),
                      h('div', null, selected.lastSessionAt ? formatTime(selected.lastSessionAt, localeId) : '—'),
                    ),

                    // 术法蒸馏入口：只读汇总，点开才查，不动任何渲染通道。
                    h(
                      'button',
                      {
                        type: 'button',
                        'data-brain-skills': 'true',
                        title: dict.skillsDistillHint,
                        onClick: () => openSkills(selected.path),
                        style: Object.assign({}, buttonStyle, {
                          height: 30,
                          width: '100%',
                          justifyContent: 'center',
                          gap: 6,
                        }),
                      },
                      dict.skillsDistill,
                      skillsReport.data && skillsReport.data.totals
                        ? h(
                            'span',
                            { style: { fontSize: 10.5, color: PALETTE.textFaint } },
                            skillsReport.data.totals.skills + ' · ' + skillsReport.data.totals.loads + dict.skillsLoadsUnit,
                          )
                        : null,
                    ),

                    selectedPosition
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                          h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.region),
                          h(
                            'div',
                            null,
                            dict[REGION_LABEL_KEYS[selectedPosition.region]] || selectedPosition.region,
                          ),
                        )
                      : null,

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 11.5, color: PALETTE.textFaint } }, dict.scannedAt),
                      h('div', null, busy ? dict.scanning : formatTime(state.snapshot && state.snapshot.scannedAt, localeId)),
                    ),

                    selectedWarningGroups.kinds > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                          h(
                            'div',
                            { style: { fontSize: 11.5, color: PALETTE.textFaint } },
                            selectedWarningGroups.kinds > 1
                              ? dict.warnings + ' · ' + dict.warningKinds(selectedWarningGroups.kinds)
                              : dict.warnings,
                          ),
                          selectedWarningGroups.groups.map((group) =>
                            h(
                              'div',
                              {
                                key: group.key,
                                title: group.paths.join('\n'),
                                style: { fontSize: 11.5, color: PALETTE.warn, lineHeight: 1.5 },
                              },
                              ((dict.warningCodes && dict.warningCodes[group.code]) || group.code) +
                                '：' +
                                group.message +
                                (group.count > 1 ? ' · ' + dict.warningAffected(group.count) : ''),
                            ),
                          ),
                          selectedWarningGroups.hidden > 0
                            ? h(
                                'div',
                                { style: { fontSize: 11.5, color: PALETTE.textFaint } },
                                dict.warningMore(selectedWarningGroups.hidden),
                              )
                            : null,
                        )
                      : null,
                  )
                : h(
                    'div',
                    { style: { color: PALETTE.textFaint, lineHeight: 1.7, fontSize: 12.5 } },
                    h('div', { style: { marginBottom: 6 } }, dict.noSelection),
                    h('div', null, dict.selectHint),
                    needle
                      ? h('div', { style: { marginTop: 8 } }, dict.dimmed)
                      : null,
                  ),

              // warnings summary
              allWarningGroups.kinds > 0
                ? h(
                    'details',
                    { style: { marginTop: 'auto', fontSize: 12 } },
                    h('summary', { style: { cursor: 'pointer', color: PALETTE.textSoft } },
                      dict.warnings + ' (' + allWarningGroups.kinds + ')'),
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
                      allWarningGroups.groups.map((group) =>
                        h(
                          'div',
                          {
                            key: group.key,
                            title: group.paths.join('\n'),
                            style: { fontSize: 11.5, color: PALETTE.textSoft, lineHeight: 1.5 },
                          },
                          ((dict.warningCodes && dict.warningCodes[group.code]) || group.code) +
                            ' · ' + group.message +
                            (group.count > 1 ? ' · ' + dict.warningAffected(group.count) : ''),
                        ),
                      ),
                      allWarningGroups.hidden > 0
                        ? h(
                            'div',
                            { style: { fontSize: 11.5, color: PALETTE.textFaint } },
                            dict.warningMore(allWarningGroups.hidden),
                          )
                        : null,
                    ),
                  )
                : h('div', { style: { marginTop: 'auto', fontSize: 11.5, color: PALETTE.textFaint } }, dict.noWarnings),
            ),
          ),

          // 术法蒸馏：DOM 浮层，和 canvas / three.js 没有任何关系。
          skillsReport.open
            ? h(SkillsOverlay, {
                dict,
                localeId,
                report: skillsReport,
                onClose: closeSkills,
                onRetry: () => openSkills(skillsReport.workspace, true),
                onAction: runSkillsAction,
                busyKey: skillsAction.busyKey,
                actionMessage: skillsAction.message,
              })
            : null,
        )
      }
    }

    // ----------------------------------------------------------------------- wiring

    function apply(ctx) {
      const registerSidebar = () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PARTICIPANT_ID,
            order: SIDEBAR_ORDER,
            label: () => dictFor(readLocaleId(ctx)).title,
          },
          createPanelIcon(ctx),
        )

      const registerMain = () => {
        const Page = createPage(ctx)
        ctx.slots.register({ name: 'main', key: PARTICIPANT_ID }, function GuardedPage(props) {
          return h(RenderGuard, null, h(Page, props))
        })
      }

      ctx.slots.inject('sidebar.panellist', registerSidebar)
      ctx.slots.inject('main', registerMain)
    }

    return {
      // `uiWorkspace` is the documented hard dependency for directory access; `slots` is
      // how the panel reaches the sidebar entry and the main panel body.
      inject: ['slots', 'uiWorkspace'],
      apply,
      __testables: {
        drawLoupe,
        beadButtonSize,
        beadHitRadius,
        BEAD_BUTTON_MIN,
        // 术法蒸馏：浮层组件与文案表暴露给测试，保证断言跑的是真正装载的那份代码。
        SkillsOverlay,
        SKILLS_ENDPOINT,
        dictFor,
        clusterBeads,
        CLUSTER_GAP,
        CLUSTER_MAX_LEVELS,
        buttonsToMount,
        rovingNeighbour,
        DOM_VIRTUALIZE_FROM,
        DOM_BUTTON_LIMIT,
        readViewSettings,
        writeViewSettings,
        prefersReducedMotion,
        SCHEMA_VERSION,
        DEFAULT_IGNORE_NAMES,
        BRAIN_SHAPE,
        REGION_ORDER,
        normalizePath,
        hashId,
        tooBroadReason,
        isIgnoredName,
        inScope,
        basename,
        isAbortError,
        resolveUiWorkspace,
        pointInPolygon,
        insideWithMargin,
        outlinePath,
        centroidOf,
        regionOf,
        buildSlots,
        layout,
        compareNodes,
        mulberry32,
        BEAD_RAMP,
        beadStep,
        beadColors,
        beadScale,
        mixHex,
        THEMES,
        themeById,
        rampFor,
        shouldShowLabel,
        TRAIL_STYLE,
        trailLength,
        trailParticleCount,
        starTrails,
        ORBIT_STYLE,
        starOrbits,
        SATELLITE_STYLE,
        satelliteCount,
        satelliteOrbit,
        workspaceSatellites,
        buildSessionSatellites,
        LABEL_ALL_FROM,
        LABEL_MAX_CHARS,
        labelWidth,
        labelText,
        labelStyle,
        workspaceLabels,
        activityFor,
        normalizeActivity,
        pulseTargets,
        groupWarnings,
        drawScene,
        GALAXY,
        GALAXY_STYLE,
        GALAXY_CANVAS_STYLE,
        galaxyPoint,
        createStarField,
        galaxyStageFor,
        galaxyDiscExtent,
        GALAXY_STRUCTURE_STYLE,
        GAS_CHAIN,
        GALAXY_ARM_STYLE,
        armThetaAt,
        armDensityAt,
        armWidthAt,
        createGalaxyStructure,
        projectGalaxyStructure,
        OWN_PACKAGE_ID,
        THREE_CHUNK_FILE,
        THREE_TUNING,
        pickBeadAt,
        readOwnRowRev,
        threeChunkUrl,
        loadThree,
        fetchLiveRev,
        detectWebgl2,
        createCanvasRenderer,
        resolveMountSize,
        createThreeRenderer,
        rendererNoticeText,
        PULSE_TOP_FRACTION,
        PULSE_WINDOW_MS,
        CAMERA: CAMERA_DEFAULT,
        CAMERA_LIMITS,
        projectPoint,
        shouldStartDrag,
        withAlpha,
        ART,
        createHttpScanner,
        SCAN_ENDPOINT,
        STREAM_ACCEPT,
        createNdjsonReader,
        emptyScanModel,
        reduceScanEvent,
        scanSummaryFromModel,
        scanSnapshotFromModel,
        PROGRESS_FLUSH_MS,
        progressRatios,
        budgetTone,
        progressLine,
        limitNoteText,
        partialNoticeText,
        formatCount,
        formatSeconds,
        sessionCountText,
        renderScanProgress,
        renderPartialStrip,
        renderEmptyState,
        createStore,
        trimSnapshot,
        dictFor,
        DICTS,
      },
    }
  },
})
