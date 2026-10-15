/** What the drawings put in and around each box. */

/** What a drawing highlights: sections being worked in now, and the ones touched before. */
export type Highlight = {
  active: ReadonlySet<string>
  trail: ReadonlySet<string>
  /** The file being worked on, by active section. */
  files: ReadonlyMap<string, string>
}

/**
 * What a box shows under its label: its first pattern's folder, or the file's
 * name when it names one file, and how many more patterns it has.
 */
export function pathHint(paths: string[]): string {
  const first = (paths[0] ?? '').replace(/\/\*\*$/, '')
  const last = first.split('/').pop() ?? ''
  const hint = /[*?]/.test(first) || !/\.[A-Za-z0-9]+$/.test(last) ? first || '.' : last
  return paths.length > 1 ? `${hint} +${paths.length - 1}` : hint
}
