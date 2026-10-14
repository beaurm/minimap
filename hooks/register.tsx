import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'project-map'
const TITLE = 'Project map'

// Demo data: a hardcoded project graph. Later this comes from scanning the repo.
type Section = { id: string; label: string; path: string; layer: number; x: number }

const SECTIONS: Section[] = [
  { id: 'ui', label: 'Web UI', path: 'src/ui', layer: 0, x: 0 },
  { id: 'cli', label: 'CLI', path: 'src/cli', layer: 0, x: 1 },
  { id: 'api', label: 'API', path: 'src/api', layer: 1, x: 0.5 },
  { id: 'auth', label: 'Auth', path: 'src/auth', layer: 2, x: 0 },
  { id: 'services', label: 'Services', path: 'src/services', layer: 2, x: 1 },
  { id: 'db', label: 'Database', path: 'src/db', layer: 3, x: 0 },
  { id: 'utils', label: 'Utils', path: 'src/utils', layer: 3, x: 1 },
]

const EDGES: [string, string][] = [
  ['ui', 'api'],
  ['cli', 'api'],
  ['api', 'auth'],
  ['api', 'services'],
  ['auth', 'db'],
  ['services', 'db'],
  ['services', 'utils'],
]

// Demo data: a fake activity script the pane cycles through to look "live".
type Step = { section: string; action: 'Reading' | 'Editing' | 'Running'; file: string }

const SCRIPT: Step[] = [
  { section: 'api', action: 'Reading', file: 'src/api/routes.ts' },
  { section: 'services', action: 'Reading', file: 'src/services/orders.ts' },
  { section: 'db', action: 'Reading', file: 'src/db/schema.sql' },
  { section: 'services', action: 'Editing', file: 'src/services/orders.ts' },
  { section: 'api', action: 'Editing', file: 'src/api/routes.ts' },
  { section: 'auth', action: 'Reading', file: 'src/auth/session.ts' },
  { section: 'ui', action: 'Editing', file: 'src/ui/OrderList.tsx' },
  { section: 'utils', action: 'Running', file: 'npm test' },
]

const active = atom({ plugin: 'project-map', key: 'active' } as const, 0)

const byId = (id: string) => SECTIONS.find(s => s.id === id)!

function svgMap(step: Step): string {
  const W = 520
  const H = 380
  const BW = 150
  const BH = 54
  const pos = (s: Section) => ({ x: 60 + s.x * (W - 120 - BW) + 0, y: 20 + s.layer * 90 })
  const center = (s: Section) => {
    const p = pos(s)
    return { x: p.x + BW / 2, y: p.y + BH / 2 }
  }

  const edges = EDGES.map(([a, b]) => {
    const from = byId(a)
    const to = byId(b)
    const f = center(from)
    const t = center(to)
    const hot = a === step.section || b === step.section
    return `<line x1="${f.x}" y1="${f.y + BH / 2}" x2="${t.x}" y2="${t.y - BH / 2 - 4}" stroke="${hot ? '#d97757' : '#8a8a8a'}" stroke-width="${hot ? 2.5 : 1.5}" stroke-opacity="${hot ? 1 : 0.5}" marker-end="url(#${hot ? 'ah' : 'a'})"/>`
  }).join('')

  const nodes = SECTIONS.map(s => {
    const p = pos(s)
    const isHere = s.id === step.section
    const pulse = isHere
      ? `<rect x="${p.x - 4}" y="${p.y - 4}" width="${BW + 8}" height="${BH + 8}" rx="12" fill="none" stroke="#d97757" stroke-width="2"><animate attributeName="stroke-opacity" values="1;0.15;1" dur="1.2s" repeatCount="indefinite"/></rect>`
      : ''
    return `${pulse}<rect x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="9" fill="${isHere ? '#d97757' : '#2a2a2a'}" fill-opacity="${isHere ? 0.18 : 0.08}" stroke="${isHere ? '#d97757' : '#8a8a8a'}" stroke-width="${isHere ? 2 : 1}"/>
<text x="${p.x + BW / 2}" y="${p.y + 23}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="${isHere ? '#d97757' : 'currentColor'}">${s.label}</text>
<text x="${p.x + BW / 2}" y="${p.y + 41}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#8a8a8a">${s.path}</text>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color:#e8e8e8">
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8a8a8a" fill-opacity="0.6"/></marker>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#d97757"/></marker>
</defs>${edges}${nodes}</svg>`
}

// Terminal layout: boxes are BOX_W wide with BOX_GAP between two of them, so a
// section's center column follows from its x (0 = left, 0.5 = middle, 1 = right).
const BOX_W = 18
const BOX_GAP = 2
const MAP_W = BOX_W * 2 + BOX_GAP
const colOf = (s: Section) => Math.floor(BOX_W / 2) + Math.round(s.x * (BOX_W + BOX_GAP))

const U = 1
const D = 2
const L = 4
const R = 8
const GLYPH: Record<number, string> = {
  [U | D]: '│', [L | R]: '─', [U | R]: '└', [U | L]: '┘', [D | R]: '┌', [D | L]: '┐',
  [U | D | R]: '├', [U | D | L]: '┤', [U | L | R]: '┴', [D | L | R]: '┬', [U | D | L | R]: '┼',
}

type Run = { text: string; isHot: boolean }

// Gives each edge leaving (or entering) a box its own column, so no two
// lines share a segment: an edge to a box straight above or below keeps the
// center, the others sit two apart on the side their other end is on.
function ports(edges: [string, string][], own: (e: [string, string]) => string, other: (e: [string, string]) => string) {
  const col = new Map<[string, string], number>()
  for (const id of new Set(edges.map(own))) {
    const center = colOf(byId(id))
    const mine = edges.filter(e => own(e) === id)
    const side = (dir: number) =>
      mine
        .filter(e => Math.sign(colOf(byId(other(e))) - center) === dir)
        .sort((x, y) => dir * (colOf(byId(other(x))) - colOf(byId(other(y)))))
    side(0).forEach(e => col.set(e, center))
    // The nearest other end gets the port next to the center.
    for (const dir of [-1, 1]) side(dir).forEach((e, k) => col.set(e, center + dir * 2 * (k + 1)))
  }
  return col
}

// Three text rows wiring the boxes of `layer` to the boxes of `layer + 1`:
// a drop from each parent, an elbow across, an arrow into each child.
function connectorRows(layer: number, activeId: string): Run[][] {
  const grid = [0, 1, 2].map(() =>
    Array.from({ length: MAP_W }, () => ({ dirs: 0, isHot: false, arrow: false })),
  )
  const edges = EDGES.filter(([a, b]) => byId(a).layer === layer && byId(b).layer === layer + 1)
  // Boxes that overlap side by side are joined by a straight drop through the
  // middle of the overlap; only the rest bend, each from its own port.
  const straight = new Map<[string, string], number>()
  for (const edge of edges) {
    const [from, to] = edge.map(id => colOf(byId(id)) - Math.floor(BOX_W / 2))
    const lo = Math.max(from!, to!) + 1
    const hi = Math.min(from!, to!) + BOX_W - 2
    if (lo <= hi) straight.set(edge, Math.round((lo + hi) / 2))
  }
  const bent = edges.filter(edge => !straight.has(edge))
  const outPort = ports(bent, ([a]) => a, ([, b]) => b)
  const inPort = ports(bent, ([, b]) => b, ([a]) => a)
  for (const edge of edges) {
    const [a, b] = edge
    const isHot = a === activeId || b === activeId
    const fa = straight.get(edge) ?? outPort.get(edge)!
    const tb = straight.get(edge) ?? inPort.get(edge)!
    const mark = (row: number, col: number, dirs: number) => {
      const cell = grid[row]![col]!
      cell.dirs |= dirs
      cell.isHot ||= isHot
    }
    mark(0, fa, U | D)
    if (fa === tb) {
      mark(1, fa, U | D)
    } else {
      const toward = tb > fa ? R : L
      const back = tb > fa ? L : R
      mark(1, fa, U | toward)
      mark(1, tb, D | back)
      for (let c = Math.min(fa, tb) + 1; c < Math.max(fa, tb); c++) mark(1, c, L | R)
    }
    mark(2, tb, U | D)
    grid[2]![tb]!.arrow = true
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'project-map',
      description: 'Open the project map pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    // Demo: advance the fake activity so the highlight moves.
    $.clock.every(1800, () => {
      void update($, active, i => (i + 1) % SCRIPT.length)
    })

    return next(e)
  })

  on('command.run', { command: 'project-map' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Project map opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const step = SCRIPT[(await read($, active)) % SCRIPT.length]!
    const here = byId(step.section)
    const { Text } = $.ui.resolve(e)
    const status = (
      <Text>
        <Text color="claude">● </Text>
        <Text bold>{step.action}</Text>
        <Text dimColor> {step.file}</Text>
      </Text>
    )

    if (e.surface !== 'terminal' && e.surface !== 'vscode') {
      const { Box, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {status}
          <Svg
            source={svgMap(step)}
            alt={`Project map: Claude is ${step.action.toLowerCase()} in ${here.label}`}
            isInteractive
          />
        </Box>
      )
    }

    // Terminal: layered boxes, the active section highlighted.
    const { Box } = $.ui.resolve(e)
    const T = Text
    const layers = [0, 1, 2, 3].map(l => SECTIONS.filter(s => s.layer === l))
    const deps = EDGES.filter(([a]) => a === here.id).map(([, b]) => byId(b).label)
    const users = EDGES.filter(([, b]) => b === here.id).map(([a]) => byId(a).label)

    return (
      <Box flexDirection="column" paddingX={1}>
        {status}
        <Box flexDirection="column" width={MAP_W} marginTop={1}>
          {layers.map((row, i) => (
            <Box flexDirection="column">
              {i > 0 &&
                connectorRows(i - 1, here.id).map(runs => (
                  <T>
                    {runs.map(run =>
                      run.isHot ? <T color="claude">{run.text}</T> : <T dimColor>{run.text}</T>,
                    )}
                  </T>
                ))}
              <Box flexDirection="row" justifyContent="center" gap={BOX_GAP}>
                {row.map(s => {
                  const isHere = s.id === here.id
                  return (
                    <Box
                      flexDirection="column"
                      alignItems="center"
                      borderStyle={isHere ? 'double' : 'round'}
                      borderColor={isHere ? 'claude' : 'subtle'}
                      paddingX={1}
                      width={BOX_W}
                    >
                      <T color={isHere ? 'claude' : 'text'} bold={isHere}>
                        {isHere ? '● ' : ''}
                        {s.label}
                      </T>
                      <T dimColor>{s.path}</T>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <T dimColor>
            {here.label} uses: {deps.length ? deps.join(', ') : '-'}
          </T>
          <T dimColor>
            used by: {users.length ? users.join(', ') : '-'}
          </T>
          <T>
            <T dimColor>▼ depends on · </T>
            <T color="claude">orange</T>
            <T dimColor> = connected to {here.label}</T>
          </T>
        </Box>
      </Box>
    )
  })
}
