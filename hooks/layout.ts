import type { ProjectMap } from '../types'

/** A box (a section) or a lane (one cell wide) carrying a long edge through a layer. */
export type Slot = {
  id: string
  kind: 'box' | 'lane'
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
  layers: Slot[][]
  slots: Map<string, Slot>
  segments: Segment[]
}

const MAX_BOX_W = 18
const MIN_BOX_W = 10
const GAP = 2

/**
 * Longest-path layers: a section sits one layer below everything it is used by.
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
  return layer
}

/** Lays the map out in rows that fit `columns` where they can (boxes shrink to MIN_BOX_W). */
export function layoutMap(map: ProjectMap, columns: number): Layout {
  const layerOf = assignLayers(map)
  const depth = Math.max(0, ...layerOf.values()) + 1

  // Rows of ids, with a lane id for each layer a long edge passes through.
  const rows: { id: string; kind: Slot['kind'] }[][] = Array.from({ length: depth }, () => [])
  for (const s of map.sections) rows[layerOf.get(s.id)!]!.push({ id: s.id, kind: 'box' })
  const segments: Segment[] = []
  for (const edge of map.edges) {
    const [from, to] = edge
    const a = layerOf.get(from)!
    const b = layerOf.get(to)!
    if (b <= a) continue // an upward edge (a cycle): not drawn
    let prev = from
    for (let l = a + 1; l < b; l++) {
      const lane = `${from}>${to}@${l}`
      rows[l]!.push({ id: lane, kind: 'lane' })
      segments.push({ from: prev, to: lane, edge })
      prev = lane
    }
    segments.push({ from: prev, to, edge })
  }

  // Order each row by the mean position of what feeds it, to limit crossings.
  const order = new Map<string, number>()
  rows[0]!.forEach((item, i) => order.set(item.id, i))
  for (let l = 1; l < depth; l++) {
    const row = rows[l]!
    const weight = (id: string) => {
      const parents = segments.filter(s => s.to === id).map(s => order.get(s.from) ?? 0)
      return parents.length ? parents.reduce((x, y) => x + y, 0) / parents.length : Infinity
    }
    const keyed = row.map((item, i) => ({ item, w: weight(item.id), i }))
    keyed.sort((x, y) => x.w - y.w || x.i - y.i)
    rows[l] = keyed.map(k => k.item)
    rows[l]!.forEach((item, i) => order.set(item.id, i))
  }

  const rowWidth = (row: { kind: Slot['kind'] }[], boxW: number) =>
    row.reduce((sum, item) => sum + (item.kind === 'box' ? boxW : 1), 0) + GAP * Math.max(0, row.length - 1)
  const fitW = (row: { kind: Slot['kind'] }[]) => {
    const boxes = row.filter(i => i.kind === 'box').length
    if (boxes === 0) return MAX_BOX_W
    const fixed = row.length - boxes + GAP * Math.max(0, row.length - 1)
    return Math.floor((columns - fixed) / boxes)
  }
  const boxW = Math.max(MIN_BOX_W, Math.min(MAX_BOX_W, ...rows.map(fitW)))
  const width = Math.max(...rows.map(r => rowWidth(r, boxW)))

  const slots = new Map<string, Slot>()
  const layers = rows.map((row, l) => {
    let left = Math.floor((width - rowWidth(row, boxW)) / 2)
    return row.map(item => {
      const w = item.kind === 'box' ? boxW : 1
      const slot: Slot = { id: item.id, kind: item.kind, layer: l, left, width: w, center: left + Math.floor(w / 2) }
      slots.set(item.id, slot)
      left += w + GAP
      return slot
    })
  })

  return { boxW, gap: GAP, width, layers, slots, segments }
}
