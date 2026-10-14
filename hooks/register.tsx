import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProjectMap } from '../types'
import {
  MAP_PATH, isTracked, parseMap, relativeTo, sectionDirs, sectionOf, unmappedTopDirs,
} from './graph'
import { layoutMap } from './layout'
import type { Layout, Segment, Slot } from './layout'

const PANE = 'project-map'
const TITLE = 'Project map'

const graph = atom({ plugin: 'project-map', key: 'graph' } as const, null)
const loadError = atom({ plugin: 'project-map', key: 'error' } as const, null)
const unmapped = atom({ plugin: 'project-map', key: 'unmapped' } as const, [])
const missing = atom({ plugin: 'project-map', key: 'missing' } as const, [])

const MAX_UNMAPPED = 50

// ── Loading the map and finding drift ─────────────────────────────────────────

/** Reads the map file into state, then checks it against the repo. */
async function loadMap($: EngineInterface) {
  let map: ProjectMap | null = null
  let error: string | null = null
  try {
    if (await $.fs.exists(MAP_PATH)) {
      const parsed = parseMap(await $.fs.read(MAP_PATH))
      if ('map' in parsed) map = parsed.map
      else error = parsed.error
    }
  } catch (err) {
    error = `could not read it (${err instanceof Error ? err.message : String(err)})`
  }
  await update($, graph, () => map)
  await update($, loadError, () => error)
  await scanDrift($, map)
}

/**
 * Cheap checks, no model calls: top-level folders no section reaches, files
 * Claude wrote that no section owns, and sections whose folders are gone.
 */
async function scanDrift($: EngineInterface, map: ProjectMap | null) {
  if (!map) {
    await update($, unmapped, () => [])
    await update($, missing, () => [])
    return
  }
  const dirs = (await $.fs.list('.')).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  const written = (await read($, unmapped)).filter(p => !p.endsWith('/') && !sectionOf(map, p))
  const found = [...new Set([...unmappedTopDirs(map, dirs), ...written])].slice(0, MAX_UNMAPPED)

  const gone: string[] = []
  for (const section of map.sections) {
    const roots = sectionDirs(section)
    const exists = await Promise.all(roots.map(dir => (dir === '' ? true : $.fs.exists(dir))))
    if (!exists.some(Boolean)) gone.push(section.id)
  }

  await update($, unmapped, () => found)
  await update($, missing, () => gone)
}

/** After Claude writes a file: reload when it is the map, else note it if no section owns it. */
async function trackWrite($: EngineInterface, path: string) {
  const rel = relativeTo(await $.session.cwd(), path)
  if (rel === undefined) return
  if (rel === MAP_PATH) return loadMap($)
  const map = await read($, graph)
  if (!map || !isTracked(rel) || sectionOf(map, rel)) return
  await update($, unmapped, list => (list.includes(rel) ? list : [...list, rel].slice(-MAX_UNMAPPED)))
}

// ── Prompts for the commands that ask Claude (the only token spend) ──────────

const SCHEMA = `{
  "version": 1,
  "sections": [
    { "id": "api", "label": "API", "description": "HTTP routes and handlers", "paths": ["src/api/**"] }
  ],
  "edges": [["api", "auth"]]
}`

const RULES = `Rules for the file:
- Sections are the main parts of the codebase a newcomer would want on a diagram: usually 4 to 12.
- "paths" are glob patterns relative to the repo root ("*" within a folder, "**" any depth; a plain folder means everything in it). Together they should cover every source folder; skip build output, dependencies and hidden folders.
- "id" is short kebab-case; "label" is 1-2 words (it is drawn in a small box); "description" is one short line.
- "edges" are [from, to] pairs meaning "from depends on / uses to". Keep only the main dependencies.
- No positions or layout: the plugin computes those.`

function initPrompt(): string {
  return `Create the project map for the project-map plugin.

Explore this repository's structure (folders, entry points, and imports where needed to tell what depends on what; don't read every file), then write \`${MAP_PATH}\` in exactly this JSON shape:

\`\`\`json
${SCHEMA}
\`\`\`

${RULES}

Write only that file, then reply with a one-line summary of the sections.`
}

function updatePrompt(map: ProjectMap, drift: { unmapped: string[]; missing: string[] }): string {
  const lines = [
    drift.unmapped.length ? `- Not covered by any section: ${drift.unmapped.join(', ')}` : '',
    drift.missing.length ? `- Sections whose folders no longer exist: ${drift.missing.join(', ')}` : '',
  ].filter(Boolean)
  return `Update the project map at \`${MAP_PATH}\`; the project has changed since it was written.

Current file:

\`\`\`json
${JSON.stringify(map, null, 2)}
\`\`\`

What the plugin detected:
${lines.length ? lines.join('\n') : '- Nothing specific; check whether the sections and edges still match the code.'}

Make the smallest change that brings it up to date: keep existing ids and labels, cover new folders by extending a section's paths or adding a section, remove or repoint sections that are gone, and adjust edges only where the change requires it.

${RULES}

Write only that file, then reply with a one-line summary of what changed.`
}

/**
 * Queues a prompt for Claude once the command has finished: submitting from
 * inside the command.run hook would wait on the very turn the hook holds.
 */
function queuePrompt($: EngineInterface, text: string) {
  $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => {}))
}

// ── Terminal drawing ─────────────────────────────────────────────────────────

const U = 1
const D = 2
const L = 4
const R = 8
const GLYPH: Record<number, string> = {
  [U | D]: '│', [L | R]: '─', [U | R]: '└', [U | L]: '┘', [D | R]: '┌', [D | L]: '┐',
  [U | D | R]: '├', [U | D | L]: '┤', [U | L | R]: '┴', [D | L | R]: '┬', [U | D | L | R]: '┼',
}

type Run = { text: string; isHot: boolean }

const isHotEdge = ([a, b]: [string, string], activeId?: string) => a === activeId || b === activeId

/** The columns a line may leave or enter a slot through: inside a box's border, a lane's one cell. */
const inner = (slot: Slot) => (slot.kind === 'box' ? [slot.left + 1, slot.left + slot.width - 2] : [slot.left, slot.left])

// Gives each segment leaving (or entering) a box its own column: one to a
// slot straight above or below keeps the center, the others sit two apart on
// the side their other end is on, inside the border. A lane has one column.
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
    const side = (dir: number) =>
      mine.filter(s => Math.sign(centerOf(s) - slot.center) === dir).sort((x, y) => dir * (centerOf(x) - centerOf(y)))
    side(0).forEach(s => col.set(s, slot.center))
    // The nearest other end gets the port next to the center.
    const [lo, hi] = inner(slot)
    for (const dir of [-1, 1]) {
      side(dir).forEach((s, k) => col.set(s, Math.min(hi!, Math.max(lo!, slot.center + dir * 2 * (k + 1)))))
    }
  }
  return col
}

// The rows wiring layer `layer` to layer `layer + 1`: a drop from each
// parent, one elbow row per set of bends whose stretches don't overlap, and
// an arrow into each child box. Every line keeps its own cells, so two lines
// meet only where one really crosses the other (┼).
function connectorRows(layout: Layout, layer: number, activeId?: string): Run[][] {
  const segs = layout.segments.filter(s => layout.slots.get(s.from)!.layer === layer)
  const outPort = ports(layout, segs, s => s.from, s => s.to)
  const inPort = ports(layout, segs, s => s.to, s => s.from)
  const within = (col: number, slot: Slot) => {
    const [lo, hi] = inner(slot)
    return col >= lo! && col <= hi!
  }
  const takenIn = (to: string, col: number, self: Segment) =>
    segs.some(s => s !== self && s.to === to && inPort.get(s) === col)
  const takenOut = (from: string, col: number, self: Segment) =>
    segs.some(s => s !== self && s.from === from && outPort.get(s) === col)

  // Go straight down when one end's port also lies over the other end.
  const cols = new Map<Segment, [number, number]>()
  for (const seg of segs) {
    const o = outPort.get(seg)!
    const i = inPort.get(seg)!
    const from = layout.slots.get(seg.from)!
    const to = layout.slots.get(seg.to)!
    if (within(o, to) && !takenIn(seg.to, o, seg)) cols.set(seg, [o, o])
    else if (within(i, from) && !takenOut(seg.from, i, seg)) cols.set(seg, [i, i])
    else cols.set(seg, [o, i])
  }

  // Bends share an elbow row only when their stretches (and a cell around them) don't overlap.
  const tracks: [number, number][][] = []
  const trackOf = new Map<Segment, number>()
  const bends = segs.filter(s => cols.get(s)![0] !== cols.get(s)![1])
  bends.sort((x, y) => Math.min(...cols.get(x)!) - Math.min(...cols.get(y)!))
  for (const seg of bends) {
    const [fa, tb] = cols.get(seg)!
    const span: [number, number] = [Math.min(fa, tb) - 1, Math.max(fa, tb) + 1]
    let t = tracks.findIndex(track => track.every(([lo, hi]) => span[1] < lo || span[0] > hi))
    if (t === -1) t = tracks.push([]) - 1
    tracks[t]!.push(span)
    trackOf.set(seg, t)
  }

  const height = 2 + Math.max(1, tracks.length)
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: layout.width }, () => ({ dirs: 0, isHot: false, arrow: false })),
  )
  for (const seg of segs) {
    const isHot = isHotEdge(seg.edge, activeId)
    const [fa, tb] = cols.get(seg)!
    const mark = (row: number, col: number, dirs: number) => {
      const cell = grid[row]?.[col]
      if (!cell) return
      cell.dirs |= dirs
      cell.isHot ||= isHot
    }
    const elbow = 1 + (trackOf.get(seg) ?? 0)
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

/** What a box shows under its label: its first pattern's folder, or the pattern. */
const pathHint = (paths: string[]) => (paths[0] ?? '').replace(/\/\*\*$/, '') || '.'

// ── Desktop / mobile drawing ─────────────────────────────────────────────────

function svgMap(map: ProjectMap, layout: Layout, activeId?: string): string {
  const CX = 8
  const ROW = 100
  const BH = 54
  const PAD = 12
  const W = layout.width * CX + PAD * 2
  const H = layout.layers.length * ROW - (ROW - BH) + PAD * 2
  const x = (col: number) => PAD + col * CX
  const top = (layer: number) => PAD + layer * ROW
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const edges = map.edges.map(edge => {
    const segs = layout.segments.filter(s => s.edge === edge)
    if (segs.length === 0) return ''
    const hot = isHotEdge(edge, activeId)
    const from = layout.slots.get(edge[0])!
    const pts = [`${x(from.center + 0.5)},${top(from.layer) + BH}`]
    for (const seg of segs) {
      const slot = layout.slots.get(seg.to)!
      pts.push(
        slot.kind === 'lane'
          ? `${x(slot.center + 0.5)},${top(slot.layer) + BH / 2}`
          : `${x(slot.center + 0.5)},${top(slot.layer) - 4}`,
      )
    }
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${hot ? '#d97757' : '#8a8a8a'}" stroke-width="${hot ? 2.5 : 1.5}" stroke-opacity="${hot ? 1 : 0.6}" marker-end="url(#${hot ? 'ah' : 'a'})"/>`
  }).join('')

  const nodes = map.sections.map(s => {
    const slot = layout.slots.get(s.id)!
    const bx = x(slot.left)
    const by = top(slot.layer)
    const bw = slot.width * CX
    const isHere = s.id === activeId
    const title = s.description ? `<title>${esc(s.description)}</title>` : ''
    return `<g>${title}<rect x="${bx}" y="${by}" width="${bw}" height="${BH}" rx="9" fill="${isHere ? '#d97757' : '#8a8a8a'}" fill-opacity="${isHere ? 0.18 : 0.08}" stroke="${isHere ? '#d97757' : '#8a8a8a'}" stroke-width="${isHere ? 2 : 1}"/>
<text x="${bx + bw / 2}" y="${by + 23}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${isHere ? '#d97757' : 'currentColor'}">${esc(s.label)}</text>
<text x="${bx + bw / 2}" y="${by + 41}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#8a8a8a">${esc(pathHint(s.paths))}</text></g>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color:#e8e8e8">
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8a8a8a" fill-opacity="0.6"/></marker>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#d97757"/></marker>
</defs>${edges}${nodes}</svg>`
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const HELP = `/project-map            open the pane
/project-map init       ask Claude to map this repo (uses tokens)
/project-map update     ask Claude to bring the map up to date (uses tokens)
/project-map reload     re-read ${MAP_PATH} after editing it by hand`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'project-map',
      description: 'Project map: open, or init | update | reload',
    })
    await loadMap($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'project-map' }, async ($, e) => {
    const sub = e.args.trim()
    const map = await read($, graph)

    if (sub === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Project map opened.' }
    }
    if (sub === 'reload') {
      await loadMap($)
      const error = await read($, loadError)
      if (error) return { text: `${MAP_PATH} is invalid: ${error}` }
      return { text: (await read($, graph)) ? 'Project map reloaded.' : `No ${MAP_PATH} found.` }
    }
    if (sub === 'init') {
      if (map) return { text: `This repo already has ${MAP_PATH}. Use /project-map update, or delete the file to start over.` }
      queuePrompt($, initPrompt())
      return { text: 'Asked Claude to map this repo.' }
    }
    if (sub === 'update') {
      if (!map) return { text: `No map yet: run /project-map init first.` }
      queuePrompt($, updatePrompt(map, { unmapped: await read($, unmapped), missing: await read($, missing) }))
      return { text: 'Asked Claude to update the project map.' }
    }

    return { text: `Unknown option "${sub}".\n${HELP}` }
  })

  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const args = e as unknown as { file_path?: string; notebook_path?: string }
    const path = args.file_path ?? args.notebook_path
    // Tracking is best effort: it must never get in the way of the edit itself.
    try {
      if (path) await trackWrite($, path)
    } catch {}

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const map = await read($, graph)
    const error = await read($, loadError)

    if (error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="error">{MAP_PATH} is invalid</Text>
          <Text dimColor>{error}</Text>
          <Text dimColor>Fix it, then run /project-map reload.</Text>
        </Box>
      )
    }
    if (!map) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>No project map yet.</Text>
          <Text dimColor>Run /project-map init to have Claude map this repo (uses tokens).</Text>
          <Text dimColor>Or write {MAP_PATH} by hand, then /project-map reload.</Text>
        </Box>
      )
    }

    const drift = { unmapped: await read($, unmapped), missing: await read($, missing) }
    const columns = Math.max(20, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2)
    const layout = layoutMap(map, columns)
    const activeId: string | undefined = undefined // set by live tracking (next phase)

    const header = (
      <Text dimColor>
        {map.sections.length} sections · {map.edges.length} links
      </Text>
    )
    const footer =
      drift.unmapped.length || drift.missing.length ? (
        <Box flexDirection="column">
          <Text color="warning">
            Map out of date:{' '}
            {[
              drift.unmapped.length ? `${drift.unmapped.length} unmapped` : '',
              drift.missing.length ? `${drift.missing.length} missing section${drift.missing.length > 1 ? 's' : ''}` : '',
            ].filter(Boolean).join(', ')}
          </Text>
          <Text dimColor wrap="truncate-end">
            {[...drift.unmapped, ...drift.missing.map(id => `${id} (gone)`)].slice(0, 4).join(', ')}
            {drift.unmapped.length + drift.missing.length > 4 ? ', …' : ''}
          </Text>
          <Text dimColor>Run /project-map update to fix it (uses tokens).</Text>
        </Box>
      ) : (
        <Text dimColor>▼ depends on · map up to date</Text>
      )

    if (e.surface !== 'terminal' && e.surface !== 'vscode') {
      const { Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {header}
          <Svg source={svgMap(map, layout, activeId)} alt={`Project map: ${map.sections.map(s => s.label).join(', ')}`} isInteractive />
          {footer}
        </Box>
      )
    }

    const byId = new Map(map.sections.map(s => [s.id, s]))
    const BOX_ROWS = 4

    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box flexDirection="column" width={layout.width} marginTop={1}>
          {layout.layers.map((row, i) => (
            <Box flexDirection="column">
              {i > 0 &&
                connectorRows(layout, i - 1, activeId).map(runs => (
                  <Text wrap="truncate-end">
                    {runs.map(run => (run.isHot ? <Text color="claude">{run.text}</Text> : <Text dimColor>{run.text}</Text>))}
                  </Text>
                ))}
              <Box flexDirection="row">
                {row.map((slot, k) => {
                  const margin = k === 0 ? slot.left : layout.gap
                  if (slot.kind === 'lane') {
                    const segment = layout.segments.find(s => s.to === slot.id)
                    const hot = segment ? isHotEdge(segment.edge, activeId) : false
                    return (
                      <Box flexDirection="column" width={1} marginLeft={margin}>
                        {Array.from({ length: BOX_ROWS }, () => (hot ? <Text color="claude">│</Text> : <Text dimColor>│</Text>))}
                      </Box>
                    )
                  }
                  const section = byId.get(slot.id)!
                  const isHere = section.id === activeId
                  return (
                    <Box
                      flexDirection="column"
                      alignItems="center"
                      borderStyle={isHere ? 'double' : 'round'}
                      borderColor={isHere ? 'claude' : 'subtle'}
                      paddingX={1}
                      width={slot.width}
                      marginLeft={margin}
                    >
                      <Text color={isHere ? 'claude' : 'text'} bold={isHere} wrap="truncate-end">
                        {section.label}
                      </Text>
                      <Text dimColor wrap="truncate-middle">
                        {pathHint(section.paths)}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {footer}
        </Box>
      </Box>
    )
  })
}
