/** The map as an SVG node graph, for surfaces that draw pictures (Desktop, mobile). */
import type { MapTouches, ProjectMap } from '../types'
import { baseName } from './activity'
import { isHotEdge, routeBand } from './connectors'
import type { Layout } from './layout'
import { pathHint } from './boxes'
import type { Highlight } from './boxes'

// Self-contained colors, readable on a light or a dark page alike: boxes are
// dark cards with light text, the box Claude works in is solid orange.
const ORANGE = '#d97757'
const CARD = '#2a2a2a'
const CARD_TEXT = '#ececec'
const MUTED = '#9a9a9a'
const LINE = '#8a8a8a'

const CX = 8 // pixels per terminal column: the SVG reuses the terminal layout's columns
const BH = 54 // box height
const PAD = 14
const ROW_PX = 13 // pixels per row of a band between layers

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function svgMap(map: ProjectMap, layout: Layout, lit: Highlight, counts: Record<string, MapTouches>): string {
  const x = (col: number) => PAD + col * CX + CX / 2

  // Each band between layers is as tall as its routing needs.
  const bands = layout.layers.slice(1).map((_, l) => routeBand(layout, l))
  const top: number[] = [PAD]
  bands.forEach((band, l) => top.push(top[l]! + BH + Math.max(3, band.height + 1) * ROW_PX))
  const W = layout.width * CX + PAD * 2
  const H = top[top.length - 1]! + BH + PAD
  const bandTop = (l: number) => top[l]! + BH
  const bandPx = (l: number) => top[l + 1]! - bandTop(l)

  // One path per drawn edge, through every band and lane it crosses, with rounded corners.
  const edges = layout.edges.map(edge => {
    const segs = layout.segments.filter(s => s.edge === edge)
    if (segs.length === 0) return ''
    const hot = isHotEdge(edge, lit.active)
    const pts: [number, number][] = []
    for (const seg of segs) {
      const l = layout.slots.get(seg.from)!.layer
      const band = bands[l]!
      const { fa, tb, elbow } = band.routes.get(seg)!
      const y0 = bandTop(l)
      const y1 = y0 + bandPx(l)
      const ye = y0 + (bandPx(l) * elbow) / (band.height - 1)
      pts.push([x(fa), y0])
      if (fa !== tb) pts.push([x(fa), ye], [x(tb), ye])
      pts.push([x(tb), layout.slots.get(seg.to)!.kind === 'lane' ? y1 + BH : y1 - 7])
    }
    const color = hot ? ORANGE : LINE
    const [ax, ay] = pts[pts.length - 1]!
    const arrow = `<path d="M${ax - 4.5},${ay} L${ax + 4.5},${ay} L${ax},${ay + 7} Z" fill="${color}"/>`
    return `<path d="${roundedPath(pts, 5)}" fill="none" stroke="${color}" stroke-width="${hot ? 2.5 : 1.5}" stroke-linejoin="round" ${hot ? '' : 'stroke-opacity="0.8"'}/>${arrow}`
  }).join('')

  const nodes = map.sections.map(s => {
    const slot = layout.slots.get(s.id)!
    const bx = PAD + slot.left * CX
    const by = top[slot.layer]!
    const bw = slot.width * CX
    const isHere = lit.active.has(s.id)
    const wasHere = lit.trail.has(s.id)
    const n = counts[s.id]
    const tip = [s.description, n ? `${n.reads} reads · ${n.edits} edits · ${n.runs} commands this session` : '']
      .filter(Boolean)
      .join('\n')
    const title = tip ? `<title>${esc(tip)}</title>` : ''
    const sub = isHere ? baseName(lit.files.get(s.id) ?? '') : pathHint(s.paths)
    const pulse = isHere
      ? `<rect x="${bx - 4}" y="${by - 4}" width="${bw + 8}" height="${BH + 8}" rx="12" fill="none" stroke="${ORANGE}" stroke-width="2"><animate attributeName="stroke-opacity" values="1;0.15;1" dur="1.2s" repeatCount="indefinite"/></rect>`
      : ''
    const stroke = isHere || wasHere ? ORANGE : '#4a4a4a'
    return `<g>${title}${pulse}<rect x="${bx}" y="${by}" width="${bw}" height="${BH}" rx="9" fill="${isHere ? ORANGE : CARD}" stroke="${stroke}" stroke-width="${isHere || wasHere ? 2 : 1}"/>
<text x="${bx + bw / 2}" y="${by + 23}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="600" fill="${isHere ? '#ffffff' : CARD_TEXT}">${esc(s.label)}</text>
<text x="${bx + bw / 2}" y="${by + 41}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="${isHere ? '#fff4ef' : MUTED}">${esc(sub)}</text></g>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${edges}${nodes}</svg>`
}

/** An SVG path through right-angled points, each corner rounded by up to `r` pixels. */
function roundedPath(pts: [number, number][], r: number): string {
  const [first, ...rest] = pts
  if (!first) return ''
  let d = `M${first[0]},${first[1]}`
  for (let i = 0; i < rest.length; i++) {
    const [px, py] = i === 0 ? first : rest[i - 1]!
    const [cx, cy] = rest[i]!
    const next = rest[i + 1]
    if (!next) {
      d += ` L${cx},${cy}`
      break
    }
    // Stop short of the corner, then curve onto the next leg.
    const inLen = Math.hypot(cx - px, cy - py)
    const outLen = Math.hypot(next[0] - cx, next[1] - cy)
    const k = Math.min(r, inLen / 2, outLen / 2)
    const sx = cx - (Math.sign(cx - px) * k)
    const sy = cy - (Math.sign(cy - py) * k)
    const ex = cx + (Math.sign(next[0] - cx) * k)
    const ey = cy + (Math.sign(next[1] - cy) * k)
    d += ` L${sx},${sy} Q${cx},${cy} ${ex},${ey}`
  }
  return d
}
