import type { MapSection, ProjectMap } from '../types'

export const MAP_PATH = 'project-map.json'

// Top-level folders that are never project sections, so never drift.
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', '__pycache__', 'venv',
])

/** Parses and checks the map file's text; the error names the first problem found. */
export function parseMap(text: string): { map: ProjectMap } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` }
  }
  if (typeof raw !== 'object' || raw === null) return { error: 'expected an object' }
  const { sections, edges = [] } = raw as { sections?: unknown; edges?: unknown }
  if (!Array.isArray(sections) || sections.length === 0) {
    return { error: '"sections" must be a non-empty array' }
  }

  const ids = new Set<string>()
  const parsed: MapSection[] = []
  for (const [i, s] of sections.entries()) {
    const at = `sections[${i}]`
    if (typeof s !== 'object' || s === null) return { error: `${at} must be an object` }
    const { id, label, description, paths } = s as Record<string, unknown>
    if (typeof id !== 'string' || id === '') return { error: `${at}.id must be a string` }
    if (ids.has(id)) return { error: `${at}.id "${id}" is used twice` }
    if (typeof label !== 'string') return { error: `${at}.label must be a string` }
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === 'string')) {
      return { error: `${at}.paths must be a non-empty array of strings` }
    }
    ids.add(id)
    parsed.push({
      id,
      label,
      ...(typeof description === 'string' ? { description } : {}),
      paths: paths as string[],
    })
  }

  if (!Array.isArray(edges)) return { error: '"edges" must be an array' }
  const parsedEdges: [string, string][] = []
  for (const [i, edge] of edges.entries()) {
    if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(id => typeof id === 'string')) {
      return { error: `edges[${i}] must be a pair of section ids` }
    }
    const [from, to] = edge as [string, string]
    for (const id of [from, to]) if (!ids.has(id)) return { error: `edges[${i}] names unknown section "${id}"` }
    if (from !== to) parsedEdges.push([from, to])
  }

  return { map: { version: 1, sections: parsed, edges: parsedEdges } }
}

const hasGlob = (segment: string) => /[*?]/.test(segment)

// Compiled patterns, by pattern: sectionOf runs per tool call and per path in a command.
const compiled = new Map<string, RegExp>()

/** A pattern as a RegExp over repo-relative paths; a plain folder also matches what's inside. */
export function globToRegExp(pattern: string): RegExp {
  let re = compiled.get(pattern)
  if (!re) compiled.set(pattern, (re = compileGlob(pattern)))
  return re
}

function compileGlob(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
  const full = hasGlob(clean) ? clean : `${clean}/**`
  let source = ''
  for (let i = 0; i < full.length; i++) {
    const ch = full[i]!
    if (ch === '*' && full[i + 1] === '*') {
      const slash = full[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // `src/api/**` also owns the folder `src/api` itself.
  if (source.endsWith('/.*')) source = `${source.slice(0, -3)}(?:/.*)?`
  return new RegExp(`^${source}$`)
}

/** The leading folders of a pattern before any glob: `src/api/**` → `src/api`. */
export function baseDir(pattern: string): string {
  const parts = pattern.replace(/^\.\//, '').split('/')
  const plain: string[] = []
  for (const part of parts) {
    if (hasGlob(part)) break
    plain.push(part)
  }
  // A pattern without globs names a folder; one with a file glob stops before it.
  return plain.filter(Boolean).join('/')
}

/** The section owning a repo-relative path: the one whose matching pattern is most specific. */
export function sectionOf(map: ProjectMap, path: string): MapSection | undefined {
  let best: MapSection | undefined
  let bestDepth = -1
  for (const section of map.sections) {
    for (const pattern of section.paths) {
      if (!globToRegExp(pattern).test(path)) continue
      const depth = baseDir(pattern).length
      if (depth > bestDepth) {
        best = section
        bestDepth = depth
      }
    }
  }
  return best
}

/** `path` relative to `root`, or undefined when it lies outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

/** Whether drift tracking cares about a path: hidden and build folders don't count. */
export function isTracked(path: string): boolean {
  const first = path.split('/')[0] ?? ''
  return first !== '' && !first.startsWith('.') && !IGNORED_DIRS.has(first)
}

/** Top-level folders no section's patterns reach into, as `dir/`. */
export function unmappedTopDirs(map: ProjectMap, dirs: string[]): string[] {
  const reaches = (pattern: string, dir: string) => {
    const segments = pattern.replace(/^\.\//, '').split('/')
    const first = segments[0] ?? ''
    if (first === '**') return true
    // A lone glob like `*.md` matches files at the root, not folders.
    if (segments.length === 1 && hasGlob(first)) return false
    return globToRegExp(first).test(dir) || first === dir
  }
  const reached = (dir: string) => map.sections.some(s => s.paths.some(p => reaches(p, dir)))
  return dirs.filter(d => isTracked(d) && !reached(d)).map(d => `${d}/`)
}

/** Every folder a section's patterns start from (empty string: the repo root). */
export function sectionDirs(section: MapSection): string[] {
  return section.paths.map(baseDir)
}
