/** One part of the project, owning the files its path patterns match. */
export type MapSection = {
  id: string
  label: string
  description?: string
  /** Glob patterns relative to the repo root: `*` within a folder, `**` any depth. */
  paths: string[]
}

/** The contents of `.claude/project-map.json`. Edges read "from depends on to". */
export type ProjectMap = {
  version: 1
  sections: MapSection[]
  edges: [string, string][]
}

declare module 'claude-code' {
  interface PluginState {
    'project-map': {
      /** The loaded map; null when the repo has none (or it failed to load). */
      graph: ProjectMap | null
      /** Why the map file could not be loaded; null when it loaded or is absent. */
      error: string | null
      /** Paths no section covers: top-level folders (`dir/`) and files Claude wrote. */
      unmapped: string[]
      /** Ids of sections whose folders no longer exist. */
      missing: string[]
    }
  }
}
