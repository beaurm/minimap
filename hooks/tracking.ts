/**
 * Live tracking as pure steps over one MapTracking value: each event computes
 * the next value, and the hooks write it once.
 */
import type { MapActivity, MapCall, MapTouches, MapTracking } from '../types'
import { isActivity } from './activity'
import type { Highlight } from './boxes'

/** The main conversation's loop; a subagent's loop is its agent id. */
export const MAIN = 'main'
const TRAIL_LENGTH = 6

export const EMPTY_TRACKING: MapTracking = { busy: false, live: {}, running: {}, trail: [], touches: {} }

/** A call starts: it runs, it is its loop's latest, and its sections join the trail and the counts. */
export function startCall(t: MapTracking, loop: string, activity: MapActivity): MapTracking {
  const { sections } = activity
  const field: keyof MapTouches = activity.action === 'Editing' ? 'edits' : activity.action === 'Running' ? 'runs' : 'reads'
  const touches = { ...t.touches }
  for (const id of sections) {
    const seen = touches[id] ?? { reads: 0, edits: 0, runs: 0 }
    touches[id] = { ...seen, [field]: seen[field] + 1 }
  }
  return {
    ...t,
    running: { ...t.running, [activity.callId]: { ...activity, loop } },
    live: { ...t.live, [loop]: activity },
    trail: [...sections, ...t.trail.filter(id => !sections.includes(id))].slice(0, TRAIL_LENGTH),
    touches,
  }
}

/** A call ends: off the running list. It stays its loop's latest until another call starts. */
export function endCall(t: MapTracking, callId: string): MapTracking {
  const { [callId]: _, ...running } = t.running
  return { ...t, running }
}

/** A main turn starts: busy, with a fresh trail. */
export function startTurn(t: MapTracking): MapTracking {
  return { ...t, busy: true, trail: [] }
}

/**
 * A loop's turn ends. Calls an interrupted turn left running never report
 * their end, so they go; a subagent leaves the picture, the main loop idles.
 */
export function endTurn(t: MapTracking, loop: string): MapTracking {
  const running = Object.fromEntries(Object.entries(t.running).filter(([, call]) => call.loop !== loop))
  if (loop === MAIN) return { ...t, running, busy: false }
  const { [loop]: _, ...live } = t.live
  return { ...t, running, live }
}

/**
 * The stored value made safe to read: state outlives a reload of the module,
 * so it may hold what an older version wrote (other fields, or none).
 */
export function sanitize(value: unknown): MapTracking {
  const t = (value ?? {}) as Partial<MapTracking>
  const keep = <T>(all: unknown) =>
    Object.fromEntries(Object.entries((all ?? {}) as Record<string, T>).filter(([, a]) => isActivity(a))) as Record<string, T>
  return {
    busy: t.busy === true,
    live: keep<MapActivity>(t.live),
    running: keep<MapCall>(t.running),
    trail: Array.isArray(t.trail) ? t.trail.filter(id => typeof id === 'string') : [],
    touches: t.touches && typeof t.touches === 'object' ? t.touches : {},
  }
}

/**
 * What to light up: every section a running call touches (parallel calls
 * included), plus each busy loop's latest call; the rest of the turn's trail
 * stays outlined.
 */
export function highlightOf(t: MapTracking): Highlight {
  const active = new Set<string>()
  const files = new Map<string, string>()
  const light = (activity: MapActivity) => {
    for (const id of activity.sections) {
      active.add(id)
      if (!files.has(id)) files.set(id, activity.files[id] ?? activity.file)
    }
  }
  for (const call of Object.values(t.running)) light(call)
  for (const [loop, activity] of Object.entries(t.live)) if (loop !== MAIN || t.busy) light(activity)
  return { active, trail: new Set(t.trail.filter(id => !active.has(id))), files }
}
