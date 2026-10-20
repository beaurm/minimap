import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MapActivity, ProjectMap } from '../types'
import { actionOf, fileArg, locate } from './activity'
import type { TrackedTool } from './activity'
import {
  LEGACY_MAP_PATHS, MAP_PATH, isMapFile, isTracked, parseMap, relativeTo, sectionDirs, sectionOf, unmappedTopDirs,
} from './graph'
import { layoutMap } from './layout'
import { initPrompt, updatePrompt } from './prompts'
import { brokenPane, emptyPane, invalidPane, legend, mapStatus, paneHeader, terminalMap } from './terminal'
import type { PaneView } from './terminal'
import {
  EMPTY_TRACKING, MAIN, endCall, endTurn, highlightOf, sanitize, startCall, startTurn,
} from './tracking'

const PANE = 'minimap'
const TITLE = 'Minimap'

const graph = atom({ plugin: 'minimap', key: 'graph' } as const, null)
const loadError = atom({ plugin: 'minimap', key: 'error' } as const, null)
const unmappedDirs = atom({ plugin: 'minimap', key: 'unmappedDirs' } as const, [])
const unmappedFiles = atom({ plugin: 'minimap', key: 'unmappedFiles' } as const, [])
const missing = atom({ plugin: 'minimap', key: 'missing' } as const, [])
const tracking = atom({ plugin: 'minimap', key: 'tracking' } as const, EMPTY_TRACKING)
const isPaneOpen = atom({ plugin: 'minimap', key: 'isPaneOpen' } as const, false)
const paneWait = atom({ plugin: 'minimap', key: 'paneWait' } as const, null)
const followed = atom({ plugin: 'minimap', key: 'followed' } as const, null)
const mapStamp = atom({ plugin: 'minimap', key: 'mapStamp' } as const, null)
const mapFile = atom({ plugin: 'minimap', key: 'mapFile' } as const, MAP_PATH)

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
  let stamp: number | null = null
  const file = await findMapFile($)
  try {
    stamp = await stampOf($, file)
    if (stamp !== null) {
      const parsed = parseMap(await $.fs.read(file))
      if ('map' in parsed) map = parsed.map
      else error = parsed.error
    }
  } catch (err) {
    error = `could not read it (${err instanceof Error ? err.message : String(err)})`
  }
  await update($, graph, () => map)
  await update($, loadError, () => error)
  await update($, mapStamp, () => stamp)
  await update($, mapFile, () => file)
  await scanDrift($, map)
}

/** The map file to read: minimap.json, else an earlier name the repo still has, else minimap.json. */
async function findMapFile($: EngineInterface): Promise<string> {
  for (const file of [MAP_PATH, ...LEGACY_MAP_PATHS]) if (await $.fs.exists(file)) return file
  return MAP_PATH
}

/**
 * The map file's modification time, or null when there is none. NaN when the
 * time can't be read: NaN equals nothing, so the map then reloads every turn.
 */
async function stampOf($: EngineInterface, file: string): Promise<number | null> {
  if (!(await $.fs.exists(file))) return null
  return $.fs.stat(file).then(
    stat => stat.mtimeMs,
    () => NaN,
  )
}

/**
 * Reloads the map when its file changed since it was loaded, however it
 * changed: Claude's Edit or Write (caught at once), a script it ran, the
 * person's editor, a git pull.
 */
async function reloadIfChanged($: EngineInterface) {
  const file = await findMapFile($)
  if (file !== (await read($, mapFile)) || (await stampOf($, file)) !== (await read($, mapStamp))) await loadMap($)
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
  if (isMapFile(rel)) return loadMap($)
  await noteUnmapped($, rel)
}

/** Notes a repo file (read or written) that no section owns: the map is missing it. */
async function noteUnmapped($: EngineInterface, rel: string) {
  const map = await read($, graph)
  if (!map || isMapFile(rel) || !isTracked(rel) || sectionOf(map, rel)) return
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

/**
 * Whether the session runs in a terminal, the one surface minimap supports.
 * The VS Code panel draws the pane broken and brings it back each session,
 * so there (and in a -p run, with no surface) the pane is never opened.
 */
async function hasTerminal($: EngineInterface) {
  return (await $.session.surfaces()).includes('terminal')
}

/** Opens the pane; `asked` when the person asked for it, which also undoes a remembered close. */
async function openPane($: EngineInterface, asked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  // Undrawn, Claude Code says why: under the width floor ("144 columns ...", a
  // terminal to widen), or a surface that places no panes, where /minimap can't help.
  const wait = opened.isPlaced ? null : /column/i.test(opened.reason) ? 'width' : 'surface'
  await update($, paneWait, () => wait)
  if (asked) await $.store.set(CLOSED_KEY, false)
  await syncPane($)
  return opened
}

/**
 * Asks Claude Code where the pane really stands, and says so under the prompt
 * while it isn't showing. Opened unasked, a pane waits undrawn until the
 * terminal is wide enough (144 columns, 110 once opened by hand), so "not
 * showing" is either the person's close or that wait, and the two read
 * differently. Run again at each turn, it catches a pane placed meanwhile.
 */
async function syncPane($: EngineInterface) {
  const isPlaced = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  await update($, isPaneOpen, () => isPlaced)
  if (isPlaced) return $.ui.status(undefined)
  // Where nothing draws panes, any hint would point at a command that can't help.
  if ((await read($, paneWait)) === 'surface') return $.ui.status(undefined)
  const isClosed = (await $.store.get(CLOSED_KEY)) === true
  $.ui.status(isClosed ? 'pane closed · /minimap to reopen' : '/minimap to open the map')
}

/** After a /clear: the map, and whether the pane is still up, into the new session's state. */
async function restoreAfterClear($: EngineInterface) {
  await loadMap($)
  await syncPane($)
}

/**
 * Queues a prompt for Claude once the command has finished: submitting from
 * inside the command.run hook would wait on the very turn the hook holds.
 */
function queuePrompt($: EngineInterface, text: string) {
  $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => {}))
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const HELP = `/minimap            open the pane
/minimap init       ask Claude to map this repo (uses tokens)
/minimap update     ask Claude to bring the map up to date (uses tokens)
/minimap reload     re-read ${MAP_PATH} after editing it by hand`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'minimap',
      description: 'Minimap: open, or init | update | reload',
    })
    await loadMap($)
    // Drop what an older version of the module may have left in the session's state.
    await update($, tracking, t => sanitize(t))
    await update($, followed, () => null)
    // The pane opens with each session, unless the person closed it last time.
    // Opening resolves at once, placed or waiting for a wider terminal, so the session waits for it.
    if (!(await hasTerminal($))) await update($, paneWait, () => 'surface')
    else if ((await $.store.get(CLOSED_KEY)) === true) await syncPane($).catch(() => {})
    else await openPane($, false).catch(() => {})

    return next(e)
  })

  // A /clear starts a fresh session (and fresh state) with no session.start:
  // once it is through, load the map again and pick up the pane as it stands.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') $.clock.after(0, () => void restoreAfterClear($).catch(() => {}))
    return ended
  })

  on('command.run', { command: 'minimap' }, async ($, e) => {
    const sub = e.args.trim()
    const map = await read($, graph)

    if (sub === '') {
      const unsupported = 'This Claude Code surface can\'t show plugin panes. minimap needs Claude Code in a terminal (`claude`).'
      if (!(await hasTerminal($))) return { text: unsupported }
      const opened = await openPane($, true)
      return { text: opened.isPlaced ? 'Minimap opened.' : unsupported }
    }
    if (sub === 'reload') {
      await loadMap($)
      const error = await read($, loadError)
      if (error) return { text: `${await read($, mapFile)} is invalid: ${error}` }
      return { text: (await read($, graph)) ? 'Minimap reloaded.' : `No ${MAP_PATH} found.` }
    }
    if (sub === 'init') {
      if (map) return { text: `This repo already has ${await read($, mapFile)}. Use /minimap update, or delete the file to start over.` }
      queuePrompt($, initPrompt())
      return { text: 'Asked Claude to map this repo.' }
    }
    if (sub === 'update') {
      if (!map) return { text: `No map yet: run /minimap init first.` }
      const file = await read($, mapFile)
      const text = await $.fs.read(file).catch(() => undefined)
      if (text === undefined) return { text: `Could not read ${file}: run /minimap reload, then try again.` }
      queuePrompt($, updatePrompt(text, await readDrift($), file))
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
      // The map file changed since it was loaded, or never loaded into this session (a /clear).
      await reloadIfChanged($).catch(() => {})
      // A pane that waited for a wider terminal may be showing by now: follow it from here on.
      await syncPane($).catch(() => {})
      await update($, tracking, t => startTurn(sanitize(t)))
      await update($, followed, () => null)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, tracking, t => endTurn(sanitize(t), e.agentId ?? MAIN))
    // A turn may have changed the map file without Claude's file tools (a script, a command).
    if (!e.agentId) await reloadIfChanged($).catch(() => {})
    return next(e)
  })

  // The x closes the pane for good: later sessions keep it closed until /minimap.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await $.store.set(CLOSED_KEY, true)
    await syncPane($)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    // A drawing that throws makes the engine drop the pane: show what went wrong instead.
    try {
      const map = await read($, graph)
      const error = await read($, loadError)
      if (error) return invalidPane(els, error, await read($, mapFile))
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
