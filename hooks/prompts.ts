/** What `/minimap init` and `update` ask Claude: the only token spend. */
import { MAP_PATH } from './graph'

const SCHEMA = `{
  "version": 1,
  "sections": [
    { "id": "api", "label": "API", "description": "HTTP routes and handlers", "paths": ["src/api/**"] }
  ],
  "edges": [["api", "auth"]]
}`

const RULES = `Rules for the file:
- Sections are the main parts of the codebase a newcomer would want on a diagram: usually 4 to 12.
- "paths" are glob patterns relative to the repo root ("*" within a folder, "**" any depth; a plain folder means everything in it). Together they should cover every source folder; skip build output, dependencies and hidden folders.
- "id" is short kebab-case; "label" is 1-2 words (it is drawn in a small box); "description" is one short line.
- "edges" are [from, to] pairs meaning "from depends on / uses to". Keep only the main dependencies.
- No positions or layout: the plugin computes those.`

export function initPrompt(): string {
  return `Create the project map for the minimap plugin.

Explore this repository's structure (folders, entry points, and imports where needed to tell what depends on what; don't read every file), then write \`${MAP_PATH}\` in exactly this JSON shape:

\`\`\`json
${SCHEMA}
\`\`\`

${RULES}

Write only that file, then reply with a one-line summary of the sections.`
}

/**
 * `text` is the map file as it is on disk, not as the plugin parsed it, so
 * Claude keeps whatever else the file holds. `file` is the map file in use:
 * a repo may still have it under an earlier name.
 */
export function updatePrompt(text: string, drift: { unmapped: string[]; missing: string[] }, file: string): string {
  const lines = [
    drift.unmapped.length ? `- Not covered by any section: ${drift.unmapped.join(', ')}` : '',
    drift.missing.length ? `- Sections whose folders no longer exist: ${drift.missing.join(', ')}` : '',
  ].filter(Boolean)
  return `Update the project map at \`${file}\`; the project has changed since it was written.

Current file:

\`\`\`json
${text.trimEnd()}
\`\`\`

What the plugin detected:
${lines.length ? lines.join('\n') : '- Nothing specific; check whether the sections and edges still match the code.'}

Make the smallest change that brings it up to date: keep existing ids and labels, cover new folders by extending a section's paths or adding a section, remove or repoint sections that are gone, and adjust edges only where the change requires it.

${RULES}

Write only that file, then reply with a one-line summary of what changed.`
}
