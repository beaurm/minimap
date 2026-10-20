import type { MapActivity, ProjectMap } from '../types'
import { isAbsolute, relativeTo, sectionOf, toSlashes } from './graph'

/** The tools whose calls say where Claude is working, and what each one counts as. */
export const TRACKED_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'LSP', 'Bash'] as const
export type TrackedTool = (typeof TRACKED_TOOLS)[number]

const ACTION: Record<TrackedTool, MapActivity['action']> = {
  Read: 'Reading',
  LSP: 'Reading',
  Edit: 'Editing',
  Write: 'Editing',
  NotebookEdit: 'Editing',
  Bash: 'Running',
}

export const actionOf = (tool: TrackedTool) => ACTION[tool]

/** The file a file tool's call names, if any. */
export function fileArg(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The words of a shell command that look like paths, quotes and trailing
 * punctuation stripped: `grep -rn foo src/api "lib/x.ts";` → src/api, lib/x.ts.
 * Flags, operators, URLs and words with no slash or extension are left out.
 */
export function pathsInCommand(command: string): string[] {
  const words = command.split(/[\s|;&<>()]+/)
  const found: string[] = []
  for (const raw of words) {
    let word = raw.replace(/^['"`]+|['"`,:]+$/g, '').replace(/^[^=\s/\\]+=/, '')
    // A Windows path (`C:\repo\a.ts`, `src\api\a.ts`) to the `/` form; other backslashes
    // (a regex, an escape) are left alone, so they never pass for paths.
    if (/^[A-Za-z]:\\/.test(word) || /^[\w.-]+(\\[\w.-]+)+$/.test(word)) word = toSlashes(word)
    if (!word || word.startsWith('-') || word.includes('://') || /[${}]/.test(word)) continue
    // A glob counts for the folder it starts in: src/api/*.ts → src/api.
    const glob = word.search(/[*?[]/)
    if (glob !== -1) word = word.slice(0, word.lastIndexOf('/', glob) + 1)
    if (!word.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(word)) continue
    found.push(word.replace(/\/+$/, ''))
  }
  return found
}

/** `path` with `.`, `..` and repeated slashes resolved: `/repo/src/../lib` → `/repo/lib`. */
function tidy(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const parts: string[] = []
  for (const part of path.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

/**
 * The paths a command names, made absolute against the folder each step runs
 * in: a plain `cd <dir>` step moves it for the steps after (`&&`, `||`, `;`, a
 * new line), and the folder it moves to counts as touched too. After a `cd` to
 * somewhere unknowable (`~`, `-`, a variable), relative paths count for nothing
 * rather than for the wrong place. Subshells, `pushd` and the like are left as
 * plain words.
 */
export function pathsFrom(cwd: string, command: string): string[] {
  let dir: string | undefined = tidy(toSlashes(cwd))
  const found: string[] = []
  const resolve = (path: string) => (isAbsolute(path) ? tidy(path) : dir === undefined ? undefined : tidy(`${dir}/${path}`))
  for (const step of command.split(/&&|\|\||;|\n/)) {
    const cd = /^\s*cd(?:\s+(\S+))?\s*$/.exec(step)
    if (cd) {
      const target = (cd[1] ?? '').replace(/^['"]|['"]$/g, '')
      dir = target === '' || /^[~-]|[$`]/.test(target) ? undefined : resolve(toSlashes(target))
      if (dir !== undefined) found.push(dir)
      continue
    }
    for (const word of pathsInCommand(step)) {
      const path = resolve(word)
      if (path !== undefined) found.push(path)
    }
  }
  return found
}

/** Where a tool call happens: its main file, and every section it touches with the first file in each. */
export type Location = Pick<MapActivity, 'file' | 'sections' | 'files'>

/**
 * Where a tool call happens, or undefined when it names nothing inside the
 * repo. A file tool touches its file's section; a command touches every
 * section its paths fall in, the one it names most first.
 */
export function locate(
  map: ProjectMap,
  cwd: string,
  tool: TrackedTool,
  args: Record<string, unknown>,
): Location | undefined {
  const inRepo = (path: string) => {
    const rel = relativeTo(cwd, path)
    return rel === undefined || rel === '' || rel.startsWith('../') ? undefined : rel
  }

  if (tool !== 'Bash') {
    const path = fileArg(args)
    const rel = path === undefined ? undefined : inRepo(path)
    if (rel === undefined) return undefined
    const id = sectionOf(map, rel)?.id
    return { file: rel, sections: id ? [id] : [], files: id ? { [id]: rel } : {} }
  }

  const command = typeof args.command === 'string' ? args.command : ''
  const counts = new Map<string, { n: number; file: string }>()
  for (const path of pathsFrom(cwd, command)) {
    const rel = inRepo(path)
    const id = rel === undefined ? undefined : sectionOf(map, rel)?.id
    if (rel === undefined || !id) continue
    const seen = counts.get(id)
    counts.set(id, { n: (seen?.n ?? 0) + 1, file: seen?.file ?? rel })
  }
  // Most named first; a tie keeps the order the command names them in.
  const sections = [...counts.keys()].sort((a, b) => counts.get(b)!.n - counts.get(a)!.n)
  if (sections.length) {
    const files = Object.fromEntries(sections.map(id => [id, counts.get(id)!.file]))
    return { file: files[sections[0]!]!, sections, files }
  }
  const head = command.trim().split('\n')[0] ?? ''
  return head ? { file: head.length > 48 ? `${head.slice(0, 47)}…` : head, sections: [], files: {} } : undefined
}

/**
 * Whether a stored activity has the shape this version records. State outlives
 * a reload of the module, so entries an older version wrote can still be there.
 */
export function isActivity(value: unknown): value is MapActivity {
  const a = value as Partial<MapActivity> | null
  return (
    !!a &&
    Array.isArray(a.sections) &&
    typeof a.files === 'object' &&
    a.files !== null &&
    typeof a.file === 'string' &&
    typeof a.callId === 'string'
  )
}

/** The last segment of a path, for a box too narrow for the whole of it. */
export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
