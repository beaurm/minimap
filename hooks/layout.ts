import type { ProjectMap } from '../types'

/** A box (a section) or a lane (one cell wide) carrying a long edge through a layer. */
export type Slot = {
  id: string
  kind: 'box' | 'lane'
  /** The row it sits on: a layer too wide for the pane takes several rows. */
  layer: number
  /** First column, and width in columns. */
  left: number
  width: number
  center: number
}

/** One drawn segment between adjacent layers, and the map edge it belongs to. */
export type Segment = { from: string; to: string; edge: [string, string] }

export type Layout = {
  boxW: number
  gap: number
  width: number
  /** The rows, top to bottom: each layer of the graph, wrapped where it is too wide. */
  layers: Slot[][]
  slots: Map<string, Slot>
  segments: Segment[]
  /** The edges drawn: the map's, less those a longer path already implies. */
  edges: [string, string][]
}

const MAX_BOX_W = 18
const MIN_BOX_W = 10
/** A box's border and padding: a label needs this many columns more than its own length. */
const BOX_CHROME = 4
const GAP = 2

/**
 * Longest-path layers: a section sits one layer below everything it is used by,
 * and no higher than it has to above what it uses.
 * Edges that would close a cycle are ignored for layering (they still draw if
 * they point downward).
 */
function assignLayers(map: ProjectMap): Map<string, number> {
  const layer = new Map(map.sections.map(s => [s.id, 0]))
  const limit = map.sections.length
  for (let pass = 0; pass < limit; pass++) {
    let changed = false
    for (const [from, to] of map.edges) {
      const next = layer.get(from)! + 1
      if (next > layer.get(to)! && next < limit) {
        layer.set(to, next)
        changed = true
      }
    }
    if (!changed) break
  }

  // Then pull each section down to just above the highest section it uses: one
  // that nothing uses (a tool that only reads the logs) sits beside its target
  // instead of on the top row. Lowest first, so a section sees its targets settled.
  const downward = map.edges.filter(([from, to]) => layer.get(to)! > layer.get(from)!)
  const order = [...map.sections].sort((a, b) => layer.get(b.id)! - layer.get(a.id)!)
  for (const { id } of order) {
    const targets = downward.filter(([from]) => from === id).map(([, to]) => layer.get(to)!)
    if (targets.length) layer.set(id, Math.min(...targets) - 1)
  }
  return layer
}

/**
 * The map's edges less the ones a longer path already says: with a → b → c,
 * a → c adds nothing to the picture and only crosses other lines. The pane
 * draws these; the map file keeps every edge.
 */
export function displayEdges(edges: [string, string][]): [string, string][] {
  const out = new Map<string, string[]>()
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b])
  const reachesWithout = (from: string, to: string, skip: [string, string]) => {
    const seen = new Set<string>([from])
    const queue = [from]
    while (queue.length) {
      const node = queue.shift()!
      for (const next of out.get(node) ?? []) {
        if (node === skip[0] && next === skip[1]) continue
        if (next === to) return true
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return false
  }
  return edges.filter(edge => !reachesWithout(edge[0], edge[1], edge))
}

// The last few layouts, by map and width: a pane redraws on every tool call, the map rarely changes.
const layouts = new Map<string, Layout>()
const KEPT_LAYOUTS = 4

/** Lays the map out in rows that fit `columns` where they can, its labels whole where they can. */
export function layoutMap(map: ProjectMap, columns: number): Layout {
  const key = `${columns} ${JSON.stringify(map)}`
  const kept = layouts.get(key)
  if (kept) return kept
  const layout = computeLayout(map, columns)
  layouts.set(key, layout)
  if (layouts.size > KEPT_LAYOUTS) layouts.delete(layouts.keys().next().value!)
  return layout
}

function computeLayout(map: ProjectMap, columns: number): Layout {
  const edges = displayEdges(map.edges)
  const layerOf = assignLayers({ ...map, edges })
  // Boxes never get narrower than the longest label needs: a wrapped row reads
  // better than a cut-off name. Only a pane too narrow for even one such box
  // shrinks the boxes (and cuts the labels).
  const longest = Math.max(0, ...map.sections.map(s => s.label.length))
  const readable = Math.max(MIN_BOX_W, longest + BOX_CHROME)

  // Each layer on one row first; while that is wider than the pane, wrap the
  // layers into rows of fewer boxes, in the order the one-row layout settled on.
  const first = place(map, edges, layerOf, columns, Infinity, readable)
  if (first.width <= columns) return first
  const rank = new Map<string, number>()
  for (const row of first.layers) row.forEach((slot, i) => rank.set(slot.id, i))
  for (let perRow = Math.max(...first.layers.map(row => row.length)) - 1; perRow >= 1; perRow--) {
    const layout = place(map, edges, layerOf, columns, perRow, readable, rank)
    if (layout.width <= columns) return layout
  }
  // One box per row still doesn't fit: let the boxes shrink after all.
  return place(map, edges, layerOf, columns, 1, MIN_BOX_W, rank)
}

type Item = { id: string; kind: Slot['kind'] }

/**
 * Lays the map out with at most `perRow` boxes on a row: a layer with more
 * takes several rows, and an edge into a later row passes the rows between
 * through lanes, as an edge skipping layers does. Boxes are at least `minW`
 * wide, and at most MAX_BOX_W unless a label needs more.
 */
function place(
  map: ProjectMap,
  edges: [string, string][],
  layerOf: Map<string, number>,
  columns: number,
  perRow: number,
  minW: number,
  rank?: Map<string, number>,
): Layout {
  const depth = Math.max(0, ...layerOf.values()) + 1

  // Which row each box lands on: its layer's rows follow the rows of the layers above.
  const rowOf = new Map<string, number>()
  let next = 0
  for (let l = 0; l < depth; l++) {
    const boxes = map.sections.filter(s => layerOf.get(s.id) === l).map(s => s.id)
    if (rank) boxes.sort((x, y) => (rank.get(x) ?? 0) - (rank.get(y) ?? 0))
    // As many rows as the layer needs, its boxes spread evenly over them (6 in rows of 5: 3 + 3).
    const count = Math.max(1, Math.ceil(boxes.length / perRow))
    const each = Math.ceil(boxes.length / count)
    boxes.forEach((id, i) => rowOf.set(id, next + Math.floor(i / each)))
    next += count
  }

  // Rows of ids, with a lane id for each row an edge passes through.
  const rows: Item[][] = Array.from({ length: next }, () => [])
  for (const s of map.sections) rows[rowOf.get(s.id)!]!.push({ id: s.id, kind: 'box' })
  const segments: Segment[] = []
  for (const edge of edges) {
    const [from, to] = edge
    const a = rowOf.get(from)!
    const b = rowOf.get(to)!
    if (b <= a) continue // an upward edge (a cycle): not drawn
    let prev = from
    for (let r = a + 1; r < b; r++) {
      const lane = `${from}>${to}@${r}`
      rows[r]!.push({ id: lane, kind: 'lane' })
      segments.push({ from: prev, to: lane, edge })
      prev = lane
    }
    segments.push({ from: prev, to, edge })
  }

  // Order each row by the mean position of what feeds it, to limit crossings.
  const order = new Map<string, number>()
  rows[0]!.forEach((item, i) => order.set(item.id, i))
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!
    const weight = (id: string) => {
      const parents = segments.filter(s => s.to === id).map(s => order.get(s.from) ?? 0)
      return parents.length ? parents.reduce((x, y) => x + y, 0) / parents.length : Infinity
    }
    const keyed = row.map((item, i) => ({ item, w: weight(item.id), i }))
    keyed.sort((x, y) => x.w - y.w || x.i - y.i)
    rows[r] = keyed.map(k => k.item)
    rows[r]!.forEach((item, i) => order.set(item.id, i))
  }

  const rowWidth = (row: Item[], boxW: number) =>
    row.reduce((sum, item) => sum + (item.kind === 'box' ? boxW : 1), 0) + GAP * Math.max(0, row.length - 1)
  const fitW = (row: Item[]) => {
    const boxes = row.filter(i => i.kind === 'box').length
    if (boxes === 0) return Infinity
    const fixed = row.length - boxes + GAP * Math.max(0, row.length - 1)
    return Math.floor((columns - fixed) / boxes)
  }
  const boxW = Math.max(minW, Math.min(Math.max(MAX_BOX_W, minW), ...rows.map(fitW)))
  const width = Math.max(...rows.map(r => rowWidth(r, boxW)))

  const slots = new Map<string, Slot>()
  const layers = rows.map((row, r) => {
    let left = Math.floor((width - rowWidth(row, boxW)) / 2)
    return row.map(item => {
      const w = item.kind === 'box' ? boxW : 1
      const slot: Slot = { id: item.id, kind: item.kind, layer: r, left, width: w, center: left + Math.floor(w / 2) }
      slots.set(item.id, slot)
      left += w + GAP
      return slot
    })
  })

  return { boxW, gap: GAP, width, layers, slots, segments, edges }
}
