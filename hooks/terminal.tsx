/**
 * What the pane draws: its messages, the header and footer every surface
 * shares, and the terminal's map of boxes and lines.
 */
import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { MapActivity, MapTracking, ProjectMap } from '../types'
import { baseName } from './activity'
import { pathHint } from './boxes'
import type { Highlight } from './boxes'
import { connectorRows, isHotEdge } from './connectors'
import { MAP_PATH } from './graph'
import type { Layout } from './layout'
import { MAIN } from './tracking'

/** The two elements every surface draws with. */
export type Els = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps> }

/** Everything a drawing of the map reads. */
export type PaneView = {
  map: ProjectMap
  layout: Layout
  lit: Highlight
  tracking: MapTracking
  drift: { unmapped: string[]; missing: string[] }
}

const BOX_ROWS = 4

export function invalidPane({ Box, Text }: Els, error: string): RenderElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="error">{MAP_PATH} is invalid</Text>
      <Text dimColor>{error}</Text>
      <Text dimColor>Fix it, then run /project-map reload.</Text>
    </Box>
  )
}

export function emptyPane({ Box, Text }: Els): RenderElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>No project map yet.</Text>
      <Text dimColor>Run /project-map init to have Claude map this repo (uses tokens).</Text>
      <Text dimColor>Or write {MAP_PATH} by hand, then /project-map reload.</Text>
    </Box>
  )
}

export function brokenPane({ Box, Text }: Els, err: unknown): RenderElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="error">The project map hit an error while drawing.</Text>
      <Text dimColor>{err instanceof Error ? err.message : String(err)}</Text>
      <Text dimColor>Run /project-map reload; if it persists, please report it.</Text>
    </Box>
  )
}

/** One status line per loop at work, the focused section's links, and the session's counts. */
export function paneHeader({ Box, Text }: Els, { map, lit, tracking }: PaneView): RenderElement {
  const labelOf = (id: string) => map.sections.find(s => s.id === id)?.label ?? id
  // "graph.ts +3 more · Graph, Activity, Boxes" for a call that touches several sections.
  const whereOf = (act: MapActivity) => {
    const more = Object.keys(act.files).length - 1
    const where = act.sections.length ? act.sections.map(labelOf).join(', ') : 'unmapped'
    return `${act.file}${more > 0 ? ` +${more} more` : ''} · ${where}`
  }

  // The main conversation first, then subagents.
  const statusLines = Object.entries(tracking.live)
    .sort(([a], [b]) => (a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b)))
    .map(([loop, act]) => {
      const isIdle = loop === MAIN && !tracking.busy
      return (
        <Text wrap="truncate-end">
          {isIdle ? <Text dimColor>○ Idle · last </Text> : <Text color="claude">● </Text>}
          {loop !== MAIN && <Text dimColor>subagent </Text>}
          <Text bold={!isIdle} dimColor={isIdle}>
            {isIdle ? act.action.toLowerCase() : act.action}
          </Text>
          <Text dimColor>
            {' '}
            {whereOf(act)}
          </Text>
        </Text>
      )
    })

  const busiest = Object.entries(tracking.touches)
    .map(([id, n]) => ({ id, n: n.reads + n.edits + n.runs }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)

  // The drawing leaves out edges a longer path implies, so spell out the focus's own links.
  const focus = tracking.live[MAIN]?.sections[0] ?? [...lit.active][0]
  const uses = focus ? map.edges.filter(([a]) => a === focus).map(([, b]) => labelOf(b)) : []
  const usedBy = focus ? map.edges.filter(([, b]) => b === focus).map(([a]) => labelOf(a)) : []

  return (
    <Box flexDirection="column">
      {statusLines.length ? statusLines : <Text dimColor>○ Waiting for Claude to touch a file</Text>}
      {focus && (uses.length > 0 || usedBy.length > 0) && (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {labelOf(focus)} uses {uses.join(', ') || 'nothing'} · used by {usedBy.join(', ') || 'nothing'}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {map.sections.length} sections · {map.edges.length} links
        {busiest.length ? ` · most touched: ${busiest.map(b => `${labelOf(b.id)} ${b.n}`).join(', ')}` : ''}
      </Text>
    </Box>
  )
}

/** Whether the map is up to date, or what drifted and how to fix it: drawn centered under the map. */
export function mapStatus({ Box, Text }: Els, { drift }: PaneView): RenderElement {
  const { unmapped, missing } = drift
  if (!unmapped.length && !missing.length) return <Text dimColor>Map up to date</Text>
  const counts = [
    unmapped.length ? `${unmapped.length} unmapped` : '',
    missing.length ? `${missing.length} missing section${missing.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean)
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="warning">Map out of date: {counts.join(', ')}</Text>
      <Text dimColor wrap="truncate-end">
        {[...unmapped, ...missing.map(id => `${id} (gone)`)].slice(0, 4).join(', ')}
        {unmapped.length + missing.length > 4 ? ', …' : ''}
      </Text>
      <Text dimColor>Run /project-map update to fix it (uses tokens).</Text>
    </Box>
  )
}

/** What the marks mean, one per line. */
export function legend({ Box, Text }: Els): RenderElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>▼ depends on</Text>
      <Text>
        <Text color="claude">═</Text>
        <Text dimColor> Claude is working here</Text>
      </Text>
      <Text>
        <Text color="claude">orange</Text>
        <Text dimColor> touched this turn</Text>
      </Text>
    </Box>
  )
}

/** The terminal's map: rows of boxes, joined by box-drawing lines; the active ones doubled. */
export function terminalMap({ Box, Text }: Els, { map, layout, lit }: PaneView): RenderElement {
  const byId = new Map(map.sections.map(s => [s.id, s]))
  return (
    <Box flexDirection="column" width={layout.width}>
      {layout.layers.map((row, i) => (
        <Box flexDirection="column">
          {i > 0 &&
            connectorRows(layout, i - 1, lit.active).map(runs => (
              <Text wrap="truncate-end">
                {runs.map(run => (run.isHot ? <Text color="claude">{run.text}</Text> : <Text dimColor>{run.text}</Text>))}
              </Text>
            ))}
          <Box flexDirection="row">
            {row.map((slot, k) => {
              const margin = k === 0 ? slot.left : layout.gap
              if (slot.kind === 'lane') {
                const segment = layout.segments.find(s => s.to === slot.id)
                const hot = segment ? isHotEdge(segment.edge, lit.active) : false
                return (
                  <Box flexDirection="column" width={1} marginLeft={margin}>
                    {Array.from({ length: BOX_ROWS }, () => (hot ? <Text color="claude">│</Text> : <Text dimColor>│</Text>))}
                  </Box>
                )
              }
              const section = byId.get(slot.id)!
              const isHere = lit.active.has(section.id)
              const wasHere = lit.trail.has(section.id)
              return (
                <Box
                  key={`box-${section.id}`}
                  flexDirection="column"
                  alignItems="center"
                  borderStyle={isHere ? 'double' : 'round'}
                  borderColor={isHere || wasHere ? 'claude' : 'subtle'}
                  borderDimColor={wasHere}
                  paddingX={1}
                  width={slot.width}
                  marginLeft={margin}
                >
                  <Text color={isHere ? 'claude' : 'text'} bold={isHere} wrap="truncate-end">
                    {section.label}
                  </Text>
                  {isHere ? (
                    <Text color="claude" wrap="truncate-middle">
                      {baseName(lit.files.get(section.id) ?? '')}
                    </Text>
                  ) : (
                    <Text dimColor wrap="truncate-middle">
                      {pathHint(section.paths)}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
