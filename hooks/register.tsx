import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MapActivity, ProjectMap } from '../types'
import { actionOf, fileArg, locate } from './activity'
import type { TrackedTool } from './activity'
import {
  MAP_PATH, isTracked, parseMap, relativeTo, sectionDirs, sectionOf, unmappedTopDirs,
} from './graph'
import { layoutMap } from './layout'
import { initPrompt, updatePrompt } from './prompts'
import { svgMap } from './svg'
import { brokenPane, emptyPane, invalidPane, legend, mapStatus, paneHeader, terminalMap } from './terminal'
import type { PaneView } from './terminal'
import {
  EMPTY_TRACKING, MAIN, endCall, endTurn, highlightOf, sanitize, startCall, startTurn,
} from './tracking'

const PANE = 'claude-nodes'
const TITLE = 'Claude Nodes'

const graph = atom({ plugin: 'claude-nodes', key: 'graph' } as const, null)
const loadError = atom({ plugin: 'claude-nodes', key: 'error' } as const, null)
const unmappedDirs = atom({ plugin: 'claude-nodes', key: 'unmappedDirs' } as const, [])
const unmappedFiles = atom({ plugin: 'claude-nodes', key: 'unmappedFiles' } as const, [])
const missing = atom({ plugin: 'claude-nodes', key: 'missing' } as const, [])
const tracking = atom({ plugin: 'claude-nodes', key: 'tracking' } as const, EMPTY_TRACKING)
const isPaneOpen = atom({ plugin: 'claude-nodes', key: 'isPaneOpen' } as const, false)
const followed = atom({ plugin: 'claude-nodes', key: 'followed' } as const, null)

/** The store key remembering, across sessions, that the person closed the pane. */
const CLOSED_KEY = 'paneClosed'
const MAX_UNMAPPED = 50

/** The tracking value, safe to read whatever an older version of the module stored. */
const readTracking = async ($: EngineInterface) => sanitize(await read($, tracking))

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
 * Cheap checks against a freshly loaded map, no model calls: top-level folders
 * no section reaches, and sections whose folders are gone. Files Claude
 * touched stay listed only while the new map still leaves them out.
 */
async function scanDrift($: EngineInterface, map: ProjectMap | null) {
  if (!map) {
    await update($, unmappedDirs, () => [])
    await update($, unmappedFiles, () => [])
    await update($, missing, () => [])
    return
  }
  const dirs = (await $.fs.list('.')).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  const gone: string[] = []
  for (const section of map.sections) {
    const roots = sectionDirs(section)
    const exists = await Promise.all(roots.map(dir => (dir === '' ? true : $.fs.exists(dir))))
    if (!exists.some(Boolean)) gone.push(section.id)
  }

  await update($, unmappedDirs, () => unmappedTopDirs(map, dirs).slice(0, MAX_UNMAPPED))
  await update($, unmappedFiles, files => files.filter(p => !sectionOf(map, p)))
  await update($, missing, () => gone)
}

/** What drifted, as the pane and the update prompt show it: everything uncovered, then what is gone. */
async function readDrift($: EngineInterface) {
  return {
    unmapped: [...(await read($, unmappedDirs)), ...(await read($, unmappedFiles))],
    missing: await read($, missing),
  }
}

/** After Claude writes a file: reload when it is the map, else note it if no section owns it. */
async function trackWrite($: EngineInterface, path: string) {
  const rel = relativeTo(await $.session.cwd(), path)
  if (rel === undefined) return
  if (rel === MAP_PATH) return loadMap($)
  await noteUnmapped($, rel)
}

/** Notes a repo file (read or written) that no section owns: the map is missing it. */
async function noteUnmapped($: EngineInterface, rel: string) {
  const map = await read($, graph)
  if (!map || rel === MAP_PATH || !isTracked(rel) || sectionOf(map, rel)) return
  await update($, unmappedFiles, list => (list.includes(rel) ? list : [...list, rel].slice(-MAX_UNMAPPED)))
}

// ── Live tracking: where Claude is working ──────────────────────────────────

/** Records a tool call (one state write); resolves what was recorded, if the call is in the repo. */
async function trackStart($: EngineInterface, loop: string, callId: string, tool: TrackedTool, args: Record<string, unknown>) {
  const map = await read($, graph)
  if (!map) return undefined
  const where = locate(map, await $.session.cwd(), tool, args)
  if (!where) return undefined
  const activity: MapActivity = { ...where, action: actionOf(tool), callId }
  await update($, tracking, t => startCall(sanitize(t), loop, activity))
  if (loop === MAIN && where.sections[0]) await follow($, where.sections[0])
  return activity
}

/**
 * Scrolls the pane to the section Claude moved to. `nearest`: the pane moves
 * only when that section is off screen, so it doesn't fight the person scrolling.
 */
async function follow($: EngineInterface, section: string) {
  if ((await read($, followed)) === section || !(await read($, isPaneOpen))) return
  await update($, followed, () => section)
  await $.ui.scroll({ in: PANE, to: { key: `box-${section}` }, block: 'nearest' }).catch(() => {})
}

// ── The pane ─────────────────────────────────────────────────────────────────

/** Opens the pane; `asked` when the person asked for it, which also undoes a remembered close. */
async function openPane($: EngineInterface, asked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isPaneOpen, () => opened.isPlaced)
  if (asked) await $.store.set(CLOSED_KEY, false)
  showClosedHint($, !opened.isPlaced)
}

/** While the pane is closed, a line under the prompt says how to bring it back. */
function showClosedHint($: EngineInterface, isClosed: boolean) {
  $.ui.status(isClosed ? 'pane closed · /claude-nodes to reopen' : undefined)
}

/** After a /clear: the map, and whether the pane is still up, into the new session's state. */
async function restoreAfterClear($: EngineInterface) {
  await loadMap($)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  await update($, isPaneOpen, () => !!pane?.isPlaced)
  showClosedHint($, !pane?.isPlaced)
}

/**
 * Queues a prompt for Claude once the command has finished: submitting from
 * inside the command.run hook would wait on the very turn the hook holds.
 */
function queuePrompt($: EngineInterface, text: string) {
  $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => {}))
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const HELP = `/claude-nodes            open the pane
/claude-nodes init       ask Claude to map this repo (uses tokens)
/claude-nodes update     ask Claude to bring the map up to date (uses tokens)
/claude-nodes reload     re-read ${MAP_PATH} after editing it by hand`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'claude-nodes',
      description: 'Claude Nodes: open, or init | update | reload',
    })
    await loadMap($)
    // Drop what an older version of the module may have left in the session's state.
    await update($, tracking, t => sanitize(t))
    await update($, followed, () => null)
    // The pane opens with each session, unless the person closed it last time.
    if ((await $.store.get(CLOSED_KEY)) === true) {
      await update($, isPaneOpen, () => false)
      showClosedHint($, true)
    } else void openPane($, false)

    return next(e)
  })

  // A /clear starts a fresh session (and fresh state) with no session.start:
  // once it is through, load the map again and pick up the pane as it stands.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') $.clock.after(0, () => void restoreAfterClear($).catch(() => {}))
    return ended
  })

  on('command.run', { command: 'claude-nodes' }, async ($, e) => {
    const sub = e.args.trim()
    const map = await read($, graph)

    if (sub === '') {
      await openPane($, true)
      return { text: 'Claude Nodes opened.' }
    }
    if (sub === 'reload') {
      await loadMap($)
      const error = await read($, loadError)
      if (error) return { text: `${MAP_PATH} is invalid: ${error}` }
      return { text: (await read($, graph)) ? 'Claude Nodes reloaded.' : `No ${MAP_PATH} found.` }
    }
    if (sub === 'init') {
      if (map) return { text: `This repo already has ${MAP_PATH}. Use /claude-nodes update, or delete the file to start over.` }
      queuePrompt($, initPrompt())
      return { text: 'Asked Claude to map this repo.' }
    }
    if (sub === 'update') {
      if (!map) return { text: `No map yet: run /claude-nodes init first.` }
      queuePrompt($, updatePrompt(map, await readDrift($)))
      return { text: 'Asked Claude to update the project map.' }
    }

    return { text: `Unknown option "${sub}".\n${HELP}` }
  })

  // The validator reads the matcher's list literally, so it is written out here; it is
  // TRACKED_TOOLS from activity.ts, and passing e.tool on as a TrackedTool keeps the two in step.
  on('tool.call', { tool: ['Read', 'Edit', 'Write', 'NotebookEdit', 'LSP', 'Bash'] }, async ($, e, next) => {
    const tool: TrackedTool = e.tool
    const args = e as unknown as Record<string, unknown>
    const loop = e.agentId ?? MAIN
    // Tracking is best effort: it must never get in the way of the call itself.
    let started: MapActivity | undefined
    try {
      started = await trackStart($, loop, e.tool_use_id, tool, args)
      // A file Claude opens that no section owns is drift too (a command's words are too loose to count).
      if (started && started.sections.length === 0 && tool !== 'Bash') await noteUnmapped($, started.file)
    } catch {}

    const ran = await next(e)

    try {
      if (started) await update($, tracking, t => endCall(sanitize(t), e.tool_use_id))
      const path = fileArg(args)
      if (actionOf(tool) === 'Editing' && path && ran.deny === undefined && !ran.isError) await trackWrite($, path)
    } catch {}

    return ran
  }).catch(($, e, next) => next(e)) // never in the way: the call goes through (or replays) untouched

  // A main turn opens the trail afresh; a subagent's activity ends with its own turn.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      // A map never loaded into this session (a /clear, a file made meanwhile): load it now.
      if (!(await read($, graph)) && !(await read($, loadError))) await loadMap($).catch(() => {})
      await update($, tracking, t => startTurn(sanitize(t)))
      await update($, followed, () => null)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, tracking, t => endTurn(sanitize(t), e.agentId ?? MAIN))
    return next(e)
  })

  // The x closes the pane for good: later sessions keep it closed until /claude-nodes.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    if (e.origin.kind === 'person') await $.store.set(CLOSED_KEY, true)
    showClosedHint($, true)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    // A drawing that throws makes the engine drop the pane: show what went wrong instead.
    try {
      const map = await read($, graph)
      const error = await read($, loadError)
      if (error) return invalidPane(els, error)
      if (!map) return emptyPane(els)

      const t = await readTracking($)
      const columns = Math.max(20, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2)
      const view: PaneView = {
        map,
        layout: layoutMap(map, columns),
        lit: highlightOf(t),
        tracking: t,
        drift: await readDrift($),
      }
      const { Box } = els

      if (e.surface !== 'terminal' && e.surface !== 'vscode') {
        const { Svg } = $.ui.resolve(e)
        return (
          <Box flexDirection="column" gap={1} padding={1}>
            {paneHeader(els, view)}
            <Box flexDirection="column" alignItems="center" gap={1}>
              <Svg
                source={svgMap(map, view.layout, view.lit, t.touches)}
                alt={`Claude Nodes: ${map.sections.map(s => s.label).join(', ')}`}
                isInteractive
              />
              {mapStatus(els, view)}
            </Box>
            {legend(els)}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" paddingX={1}>
          {paneHeader(els, view)}
          {/* The map centered in the pane, its status under it; redrawn at each new width. */}
          <Box flexDirection="column" alignItems="center" marginTop={1}>
            {terminalMap(els, view)}
            <Box marginTop={1}>{mapStatus(els, view)}</Box>
          </Box>
          <Box marginTop={1}>{legend(els)}</Box>
        </Box>
      )
    } catch (err) {
      return brokenPane(els, err)
    }
  })
}
