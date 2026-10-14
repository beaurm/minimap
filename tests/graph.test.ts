import { describe, expect, test } from 'claude-code/testing'

import type { ProjectMap } from '../types'
import { baseDir, globToRegExp, parseMap, relativeTo, sectionOf, unmappedTopDirs } from '../hooks/graph'
import { layoutMap } from '../hooks/layout'

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
  test('layers follow the edges, and a skipped layer gets a lane', () => {
    const layout = layoutMap(MAP, 80)
    expect(layout.layers.map(row => row.filter(s => s.kind === 'box').map(s => s.id))).toEqual([
      ['ui', 'docs'],
      ['api'],
      ['core'],
    ])
    // ui → core skips the API layer, so it passes through a lane there.
    expect(layout.layers[1]!.some(s => s.kind === 'lane')).toBe(true)
    expect(layout.segments.filter(s => s.edge[0] === 'ui' && s.edge[1] === 'core')).toHaveLength(2)
  })
  test('boxes shrink to fit narrow panes, never below 10 columns', () => {
    const wide = { ...MAP, sections: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, paths: [`s${i}`] })), edges: [] }
    expect(layoutMap(wide, 200).boxW).toBe(18)
    expect(layoutMap(wide, 80).boxW).toBe(11)
    expect(layoutMap(wide, 30).boxW).toBe(10)
  })
  test('a cycle does not hang the layout', () => {
    const cyclic: ProjectMap = { ...MAP, edges: [['ui', 'api'], ['api', 'ui']] }
    expect(layoutMap(cyclic, 80).layers.length).toBeGreaterThan(0)
  })
})
