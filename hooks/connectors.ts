/** The lines between layers, drawn with box-drawing characters for a monospace grid. */
import type { Layout, Segment, Slot } from './layout'

const U = 1
const D = 2
const L = 4
const R = 8
const GLYPH: Record<number, string> = {
  [U | D]: '│', [L | R]: '─', [U | R]: '└', [U | L]: '┘', [D | R]: '┌', [D | L]: '┐',
  [U | D | R]: '├', [U | D | L]: '┤', [U | L | R]: '┴', [D | L | R]: '┬', [U | D | L | R]: '┼',
}

export type Run = { text: string; isHot: boolean }

export const isHotEdge = ([a, b]: [string, string], active: ReadonlySet<string>) => active.has(a) || active.has(b)

/** The columns a line may leave or enter a slot through: inside a box's border, a lane's one cell. */
const inner = (slot: Slot) => (slot.kind === 'box' ? [slot.left + 1, slot.left + slot.width - 2] : [slot.left, slot.left])

// Gives each segment leaving (or entering) a slot its own column: one line
// uses the slot's center; several spread evenly around it, two apart while
// they fit inside the border (else one apart), ordered by where each line's
// other end sits so they don't cross. A lane has one column.
function ports(layout: Layout, segs: Segment[], own: (s: Segment) => string, other: (s: Segment) => string) {
  const col = new Map<Segment, number>()
  for (const id of new Set(segs.map(own))) {
    const slot = layout.slots.get(id)!
    const mine = segs.filter(s => own(s) === id)
    if (slot.kind === 'lane') {
      for (const s of mine) col.set(s, slot.center)
      continue
    }
    const centerOf = (s: Segment) => layout.slots.get(other(s))!.center
    mine.sort((x, y) => centerOf(x) - centerOf(y))
    const [lo, hi] = inner(slot)
    const room = hi! - lo!
    const step = (mine.length - 1) * 2 <= room ? 2 : 1
    mine.forEach((s, k) => {
      const at = slot.center + Math.round((k - (mine.length - 1) / 2) * step)
      col.set(s, Math.min(hi!, Math.max(lo!, at)))
    })
  }
  return col
}

/** How one segment runs through its band: down at `fa`, across on elbow row `elbow`, down at `tb`. */
export type Route = { fa: number; tb: number; elbow: number }

/**
 * Routes every segment between layer `layer` and layer `layer + 1`. Each line
 * keeps its own columns, and bends whose stretches would overlap get their
 * own elbow rows, so two lines meet only where one really crosses the other.
 * `height` counts the band's rows: a drop row, the elbow rows, an arrow row.
 */
export function routeBand(layout: Layout, layer: number): Band {
  // Layouts are cached and never change, so each band is routed once per layout.
  let bands = routed.get(layout)
  if (!bands) routed.set(layout, (bands = new Map()))
  let band = bands.get(layer)
  if (!band) bands.set(layer, (band = computeBand(layout, layer)))
  return band
}

/** A band's routes and its height in rows: a drop row, the elbow rows, an arrow row. */
export type Band = { routes: Map<Segment, Route>; height: number }

const routed = new WeakMap<Layout, Map<number, Band>>()

function computeBand(layout: Layout, layer: number): Band {
  const segs = layout.segments.filter(s => layout.slots.get(s.from)!.layer === layer)
  const outPort = ports(layout, segs, s => s.from, s => s.to)
  const inPort = ports(layout, segs, s => s.to, s => s.from)
  const within = (col: number, slot: Slot) => {
    const [lo, hi] = inner(slot)
    return col >= lo! && col <= hi!
  }
  // Go straight down when one end's port also lies over the other end, and no other line
  // at either end is in that column or the next: a drop must not touch another line.
  const cols = new Map<Segment, [number, number]>()
  const endAt = (s: Segment, end: 'from' | 'to') => {
    const decided = cols.get(s)
    if (decided) return end === 'from' ? decided[0] : decided[1]
    return end === 'from' ? outPort.get(s)! : inPort.get(s)!
  }
  const isClear = (self: Segment, col: number) =>
    segs.every(
      s =>
        s === self ||
        ((s.from !== self.from || Math.abs(endAt(s, 'from') - col) > 1) &&
          (s.to !== self.to || Math.abs(endAt(s, 'to') - col) > 1)),
    )
  for (const seg of segs) {
    const o = outPort.get(seg)!
    const i = inPort.get(seg)!
    const from = layout.slots.get(seg.from)!
    const to = layout.slots.get(seg.to)!
    if (o === i) cols.set(seg, [o, o])
    else if (within(o, to) && isClear(seg, o)) cols.set(seg, [o, o])
    else if (within(i, from) && isClear(seg, i)) cols.set(seg, [i, i])
    else cols.set(seg, [o, i])
  }

  // Bends share an elbow row only when their stretches don't overlap; lines going the same
  // way also keep a cell between them, so they never read as one. Lines going opposite ways
  // can't merge, so a fan out of one box turns both its sides on the same row.
  // A fan of lines going right turns its rightmost line highest, each next one lower, so
  // no line's turn crosses another's drop; lines going left mirror it.
  type Stretch = { lo: number; hi: number; right: boolean }
  const tracks: Stretch[][] = []
  const trackOf = new Map<Segment, number>()
  const bends = segs.filter(s => cols.get(s)![0] !== cols.get(s)![1])
  const goesRight = (s: Segment) => cols.get(s)![1] > cols.get(s)![0]
  bends.sort((x, y) => {
    if (goesRight(x) !== goesRight(y)) return goesRight(x) ? -1 : 1
    const fx = cols.get(x)![0]
    const fy = cols.get(y)![0]
    return goesRight(x) ? fy - fx : fx - fy
  })
  const clash = (a: Stretch, b: Stretch) => {
    const gap = a.right === b.right ? 1 : 0
    return a.lo - gap <= b.hi && b.lo - gap <= a.hi
  }
  for (const seg of bends) {
    const [fa, tb] = cols.get(seg)!
    const stretch: Stretch = { lo: Math.min(fa, tb), hi: Math.max(fa, tb), right: tb > fa }
    let t = tracks.findIndex(track => track.every(other => !clash(stretch, other)))
    if (t === -1) t = tracks.push([]) - 1
    tracks[t]!.push(stretch)
    trackOf.set(seg, t)
  }

  const routes = new Map<Segment, Route>()
  for (const seg of segs) {
    const [fa, tb] = cols.get(seg)!
    routes.set(seg, { fa, tb, elbow: 1 + (trackOf.get(seg) ?? 0) })
  }
  return { routes, height: 2 + Math.max(1, tracks.length) }
}

/** The rows of text wiring layer `layer` to layer `layer + 1`, as routed by routeBand. */
export function connectorRows(layout: Layout, layer: number, active: ReadonlySet<string>): Run[][] {
  const { routes, height } = routeBand(layout, layer)
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: layout.width }, () => ({ dirs: 0, isHot: false, arrow: false })),
  )
  for (const [seg, { fa, tb, elbow }] of routes) {
    const isHot = isHotEdge(seg.edge, active)
    const mark = (row: number, col: number, dirs: number) => {
      const cell = grid[row]?.[col]
      if (!cell) return
      cell.dirs |= dirs
      cell.isHot ||= isHot
    }
    for (let row = 0; row < height; row++) {
      if (fa === tb) mark(row, fa, U | D)
      else if (row < elbow) mark(row, fa, U | D)
      else if (row > elbow) mark(row, tb, U | D)
    }
    if (fa !== tb) {
      const toward = tb > fa ? R : L
      const back = tb > fa ? L : R
      mark(elbow, fa, U | toward)
      mark(elbow, tb, D | back)
      for (let c = Math.min(fa, tb) + 1; c < Math.max(fa, tb); c++) mark(elbow, c, L | R)
    }
    const cell = grid[height - 1]?.[tb]
    if (cell && layout.slots.get(seg.to)!.kind === 'box') cell.arrow = true
  }

  return grid.map(row => {
    const runs: Run[] = []
    for (const cell of row) {
      const ch = cell.arrow ? '▼' : (GLYPH[cell.dirs] ?? ' ')
      const isHot = cell.dirs !== 0 && cell.isHot
      const last = runs[runs.length - 1]
      if (last && last.isHot === isHot) last.text += ch
      else runs.push({ text: ch, isHot })
    }
    return runs
  })
}
