/** One part of the project, owning the files its path patterns match. */
export type MapSection = {
  id: string
  label: string
  description?: string
  /** Glob patterns relative to the repo root: `*` within a folder, `**` any depth. */
  paths: string[]
}

/** The contents of `project-map.json`. Edges read "from depends on to". */
export type ProjectMap = {
  version: 1
  sections: MapSection[]
  edges: [string, string][]
}

/** What one model loop (the main conversation, or a subagent) is doing now. */
export type MapActivity = {
  /** Every section the call touches, most touched first; empty when no section owns its files. */
  sections: string[]
  /** The first file the call touches in each of its sections, by section id. */
  files: Record<string, string>
  action: 'Reading' | 'Editing' | 'Running'
  /** The call's main file (repo-relative), or the start of a command that names no file. */
  file: string
  /** The tool call (its tool_use_id) this activity records. */
  callId: string
}

/** How often a section was touched this session. */
export type MapTouches = { reads: number; edits: number; runs: number }

/** A tool call still running, and the loop (`main`, or a subagent's id) it runs in. */
export type MapCall = MapActivity & { loop: string }

/** Everything live tracking keeps, as one value: a tool call writes it once. */
export type MapTracking = {
  /** True while a turn of the main conversation runs. */
  busy: boolean
  /** The latest call of each loop, by loop: `main`, or a subagent's id. */
  live: Record<string, MapActivity>
  /** The calls running now, by tool_use_id: parallel calls are all here at once. */
  running: Record<string, MapCall>
  /** Sections touched during the current (or last) turn, most recent first. */
  trail: string[]
  /** Touch counts by section id, for the whole session. */
  touches: Record<string, MapTouches>
}

declare module 'claude-code' {
  interface PluginState {
    'project-map': {
      /** The loaded map; null when the repo has none (or it failed to load). */
      graph: ProjectMap | null
      /** Why the map file could not be loaded; null when it loaded or is absent. */
      error: string | null
      /** Top-level folders no section covers (as `dir/`), found when the map loads. */
      unmappedDirs: string[]
      /** Files Claude read or wrote that no section owns, collected as it works. */
      unmappedFiles: string[]
      /** Ids of sections whose folders no longer exist. */
      missing: string[]
      /** Where Claude is working: see MapTracking. */
      tracking: MapTracking
      /** Whether the map pane is open. */
      isPaneOpen: boolean
      /** The section the pane last scrolled to, so it only follows Claude when the section changes. */
      followed: string | null
    }
  }
}
