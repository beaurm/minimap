import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAP = {
  version: 1,
  sections: [
    { id: 'api', label: 'API', paths: ['src/api/**'] },
    { id: 'db', label: 'Database', paths: ['src/db/**'] },
    { id: 'gone', label: 'Legacy', paths: ['legacy/**'] },
  ],
  edges: [['api', 'db']],
}

const PROPS = {
  title: 'Project map',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const PANE = { component: 'Pane', props: PROPS, requestId: 'project-map' } as const

/**
 * A fake repo: the files the plugin may read, and its folders. The engine
 * hands these hooks absolute paths, so a key matches as a path suffix.
 */
function fakeRepo(on: On, files: Record<string, string>, dirs: string[]) {
  const is = (path: string, key: string) => path === key || path.endsWith(`/${key}`)
  const file = (path: string) => Object.keys(files).find(key => is(path, key))
  const exists = (path: string) => file(path) !== undefined || dirs.some(d => is(path, d))
  on('fs.exists', async (_, e) => ({ value: exists(e.path) }))
  on('fs.read', async (_, e) => {
    const key = file(e.path)
    return key ? { value: files[key]! } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', async () => ({
    value: [...new Set(dirs.map(d => d.split('/')[0]!))].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('session.cwd', async () => ({ value: '/repo' }))
}

/** Runs `/project-map <args>` as the person would. */
const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'project-map',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  } as never)

test('no map: the pane says how to make one', async ($, on) => {
  fakeRepo(on, {}, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'project-map', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /No project map yet/ })).toBeDefined()
  await ui.unmount()
})

test('a map draws its sections and reports drift', async ($, on) => {
  fakeRepo(on, { '.claude/project-map.json': JSON.stringify(MAP) }, ['src/api', 'src/db', 'scripts'])
  await run($, 'reload')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'project-map', surface, ...PANE })
    if (surface === 'terminal') {
      for (const label of ['API', 'Database', 'Legacy']) {
        expect(await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })).toBeDefined()
      }
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    // scripts/ is covered by no section; legacy/ no longer exists.
    expect(await ui.find({ type: 'Text', text: /1 unmapped, 1 missing section/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an invalid map shows the error instead of a graph', async ($, on) => {
  fakeRepo(on, { '.claude/project-map.json': '{"sections": []}' }, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'project-map', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /non-empty array/ })).toBeDefined()
  await ui.unmount()
})

test('init asks Claude only when there is no map yet', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', async (_, e) => {
    prompts.push(e.text)
    return { drop: 'captured by the test' } as never
  })
  fakeRepo(on, {}, ['src'])
  await run($, 'reload')
  await run($, 'init')
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('.claude/project-map.json')
})
