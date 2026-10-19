import { describe, expect, test } from 'claude-code/testing'

import type { ProjectMap } from '../types'
import { baseDir, globToRegExp, parseMap, relativeTo, sectionOf, unmappedTopDirs } from '../hooks/graph'
import { displayEdges, layoutMap } from '../hooks/layout'
import { isActivity, locate, pathsInCommand } from '../hooks/activity'
import { pathHint } from '../hooks/boxes'

const MAP: ProjectMap = {
  version: 1,
  sections: [
    { id: 'ui', label: 'UI', paths: ['src/ui/**'] },
    { id: 'api', label: 'API', paths: ['src/api'] },
    { id: 'core', label: 'Core', paths: ['src/**'] },
    { id: 'docs', label: 'Docs', paths: ['*.md', 'docs/**'] },
  ],
  edges: [['ui', 'api'], ['api', 'core'], ['ui', 'core']],
}

describe('globToRegExp', () => {
  test('** spans folders, * stays in one', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
  })
  test('a plain folder owns what is inside it', () => {
    expect(globToRegExp('src/api').test('src/api/routes.ts')).toBe(true)
    expect(globToRegExp('src/api').test('src/apiary/x.ts')).toBe(false)
  })
  test('baseDir stops at the first glob', () => {
    expect(baseDir('src/api/**')).toBe('src/api')
    expect(baseDir('*.md')).toBe('')
    expect(baseDir('./lib')).toBe('lib')
  })
})

describe('sectionOf', () => {
  test('the most specific pattern wins', () => {
    expect(sectionOf(MAP, 'src/ui/App.tsx')?.id).toBe('ui')
    expect(sectionOf(MAP, 'src/api/x.ts')?.id).toBe('api')
    expect(sectionOf(MAP, 'src/other/x.ts')?.id).toBe('core')
    expect(sectionOf(MAP, 'README.md')?.id).toBe('docs')
    expect(sectionOf(MAP, 'scripts/build.sh')).toBeUndefined()
  })
  test('relativeTo keeps paths inside the repo only', () => {
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/repository/a.ts')).toBeUndefined()
  })
  test('top-level folders no section reaches are drift; hidden and build ones are not', () => {
    expect(unmappedTopDirs(MAP, ['src', 'docs', 'scripts', '.git', 'node_modules'])).toEqual(['scripts/'])
  })
})

describe('parseMap', () => {
  test('accepts a valid map and drops self-edges', () => {
    const parsed = parseMap(JSON.stringify({ ...MAP, edges: [...MAP.edges, ['ui', 'ui']] }))
    expect('map' in parsed && parsed.map.edges.length).toBe(3)
  })
  test('names the problem', () => {
    expect(parseMap('{')).toMatchObject({ error: expect.stringContaining('not valid JSON') })
    expect(parseMap('{"sections": []}')).toEqual({ error: '"sections" must be a non-empty array' })
    expect(parseMap(JSON.stringify({ sections: [{ id: 'a', label: 'A', paths: ['a'] }], edges: [['a', 'b']] }))).toEqual({
      error: 'edges[0] names unknown section "b"',
    })
  })
})

describe('layoutMap', () => {
  test('a section that uses only something deep sits right above it, not on the top row', () => {
    // As in a real map: the peer tracker only reads the logs, at the bottom.
    const map: ProjectMap = {
      version: 1,
      sections: ['launchers', 'monitor', 'node', 'logs', 'tracker'].map(id => ({ id, label: id, paths: [id] })),
      edges: [['launchers', 'monitor'], ['monitor', 'node'], ['node', 'logs'], ['tracker', 'logs']],
    }
    const rowOf = (id: string) => layoutMap(map, 80).slots.get(id)!.layer
    expect(rowOf('tracker')).toBe(rowOf('logs') - 1)
    expect(rowOf('launchers')).toBe(0)
  })
  test('an edge that has to skip a layer passes it through a lane', () => {
    // x uses w (one layer down) and c (two down), so x stays on top and x → c skips a layer.
    const map: ProjectMap = {
      version: 1,
      sections: ['v', 'u', 'x', 'w', 'k', 'c'].map(id => ({ id, label: id, paths: [id] })),
      edges: [['v', 'w'], ['u', 'k'], ['k', 'c'], ['x', 'w'], ['x', 'c']],
    }
    const layout = layoutMap(map, 80)
    expect(layout.slots.get('x')!.layer).toBe(0)
    expect(layout.layers[1]!.some(s => s.kind === 'lane')).toBe(true)
    expect(layout.segments.filter(s => s.edge[0] === 'x' && s.edge[1] === 'c')).toHaveLength(2)
  })
  test('an edge a longer path already implies is not drawn', () => {
    // ui → core is implied by ui → api → core.
    expect(displayEdges(MAP.edges)).toEqual([['ui', 'api'], ['api', 'core']])
    expect(layoutMap(MAP, 80).layers[1]!.some(s => s.kind === 'lane')).toBe(false)
  })
  test('boxes shrink to fit narrow panes, and a narrower pane wraps them instead', () => {
    const wide = { ...MAP, sections: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, paths: [`s${i}`] })), edges: [] }
    expect(layoutMap(wide, 200).boxW).toBe(18)
    expect(layoutMap(wide, 80).boxW).toBe(11)
    const narrow = layoutMap(wide, 30)
    expect(narrow.width).toBeLessThanOrEqual(30)
    expect(narrow.boxW).toBeGreaterThanOrEqual(10)
  })
  test('a layer too wide for the pane wraps onto balanced rows, and lines reach the lower row through lanes', () => {
    const leaves = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, label: `L${i}`, paths: [`l${i}`] }))
    const map: ProjectMap = {
      version: 1,
      sections: [{ id: 'app', label: 'App', paths: ['app'] }, ...leaves],
      edges: leaves.map(l => ['app', l.id] as [string, string]),
    }
    const layout = layoutMap(map, 60)
    expect(layout.width).toBeLessThanOrEqual(60)
    const boxesPerRow = layout.layers.map(row => row.filter(s => s.kind === 'box').length)
    expect(boxesPerRow).toEqual([1, 3, 3])
    // Every leaf on the lower row is reached through a lane on the row above.
    const lower = layout.layers[2]!.filter(s => s.kind === 'box').map(s => s.id)
    for (const id of lower) expect(layout.segments.filter(s => s.edge[1] === id)).toHaveLength(2)
    // Wide enough, the layer stays one row.
    expect(layoutMap(map, 200).layers.map(row => row.length)).toEqual([1, 6])
  })
  test('boxes stay wide enough for the longest label, wrapping rows instead; only a pane too narrow for one box cuts labels', () => {
    const names = ['Authentication', 'Billing', 'Search Index', 'Notifications', 'Background Jobs', 'Admin']
    const map: ProjectMap = {
      version: 1,
      sections: [{ id: 'app', label: 'Web App', paths: ['app'] }, ...names.map((label, i) => ({ id: `s${i}`, label, paths: [`s${i}`] }))],
      edges: names.map((_, i) => ['app', `s${i}`] as [string, string]),
    }
    // "Background Jobs" is 15 characters: a box needs 19 columns to show it whole.
    const layout = layoutMap(map, 60)
    expect(layout.boxW).toBeGreaterThanOrEqual(19)
    expect(layout.width).toBeLessThanOrEqual(60)
    expect(layout.layers.length).toBeGreaterThan(2)
    // A pane too narrow for one such box (with the lines passing beside it): the boxes shrink to fit after all.
    const narrow = layoutMap(map, 30)
    expect(narrow.width).toBeLessThanOrEqual(30)
    expect(narrow.boxW).toBeLessThan(19)
  })
  test('a cycle does not hang the layout', () => {
    const cyclic: ProjectMap = { ...MAP, edges: [['ui', 'api'], ['api', 'ui']] }
    expect(layoutMap(cyclic, 80).layers.length).toBeGreaterThan(0)
  })
})

describe('activity', () => {
  test('isActivity rejects what an older version stored', () => {
    expect(isActivity({ sections: ['api'], files: { api: 'a.ts' }, file: 'a.ts', action: 'Reading', callId: 'c1' })).toBe(true)
    expect(isActivity({ sections: ['api'], files: {}, file: 'a.ts', action: 'Reading', at: 1, isRunning: false })).toBe(false)
    expect(isActivity({ section: 'api', file: 'a.ts', action: 'Reading', at: 1, isRunning: false })).toBe(false)
    expect(isActivity(null)).toBe(false)
  })
  test('pathsInCommand keeps the words that look like paths', () => {
    expect(pathsInCommand(`grep -rn "foo" src/api 'lib/x.ts'; cat README.md | head -5`)).toEqual(['src/api', 'lib/x.ts', 'README.md'])
    expect(pathsInCommand('ls src/ui/*.tsx && curl https://x.dev/a.json')).toEqual(['src/ui'])
    expect(pathsInCommand('FILE=src/db/a.sql npm test --file=src/core/b.ts')).toEqual(['src/db/a.sql', 'src/core/b.ts'])
  })
  test('locate names the file and the section that owns it', () => {
    expect(locate(MAP, '/repo', 'Read', { file_path: '/repo/src/ui/App.tsx' })).toEqual({
      file: 'src/ui/App.tsx',
      sections: ['ui'],
      files: { ui: 'src/ui/App.tsx' },
    })
    expect(locate(MAP, '/repo', 'Edit', { file_path: '/repo/scripts/x.sh' })).toEqual({ file: 'scripts/x.sh', sections: [], files: {} })
    expect(locate(MAP, '/repo', 'Read', { file_path: '/etc/hosts' })).toBeUndefined()
  })
  test('a command touches every section its paths are in, the most named first', () => {
    expect(locate(MAP, '/repo', 'Bash', { command: 'diff src/ui/c.ts src/api/a.ts src/api/b.ts' })).toEqual({
      file: 'src/api/a.ts',
      sections: ['api', 'ui'],
      files: { api: 'src/api/a.ts', ui: 'src/ui/c.ts' },
    })
    // One file each: they keep the order the command names them in.
    expect(locate(MAP, '/repo', 'Bash', { command: 'cat -n src/ui/a.ts README.md && sed -n 1,9p src/api/b.ts' })?.sections).toEqual([
      'ui',
      'docs',
      'api',
    ])
    expect(locate(MAP, '/repo', 'Bash', { command: 'npm test' })).toEqual({ file: 'npm test', sections: [], files: {} })
  })
})

describe('box labels', () => {
  test('a box names its folder, or its file when it owns one file', () => {
    expect(pathHint(['src/api/**'])).toBe('src/api')
    expect(pathHint(['hooks/register.tsx'])).toBe('register.tsx')
    expect(pathHint(['src/**/*.ts'])).toBe('src/**/*.ts')
    expect(pathHint(['*.md'])).toBe('*.md')
    expect(pathHint(['hooks/boxes.ts', 'hooks/terminal.tsx', 'hooks/connectors.ts'])).toBe('boxes.ts +2')
  })
})
