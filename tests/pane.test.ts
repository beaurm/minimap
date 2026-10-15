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
  title: 'Claude Nodes',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const PANE = { component: 'Pane', props: PROPS, requestId: 'claude-nodes' } as const

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

/** Runs `/claude-nodes <args>` as the person would. */
const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'claude-nodes',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  } as never)

test('no map: the pane says how to make one', async ($, on) => {
  fakeRepo(on, {}, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /No map yet/ })).toBeDefined()
  await ui.unmount()
})

test('a map draws its sections and reports drift', async ($, on) => {
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db', 'scripts'])
  await run($, 'reload')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claude-nodes', surface, ...PANE })
    if (surface === 'terminal') {
      for (const label of ['API', 'Database', 'Legacy']) {
        expect(await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })).toBeDefined()
      }
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    // scripts/ is covered by no section; legacy/ no longer exists.
    expect(await ui.find({ type: 'Text', text: /1 unmapped, 1 missing section/ })).toBeDefined()
    if (surface === 'terminal') {
      // The legend: one entry per line, "orange" drawn in orange.
      expect((await ui.find({ type: 'Text', text: /^orange$/ }))?.props).toMatchObject({ color: 'claude' })
      expect(await ui.find({ type: 'Text', text: /^▼ depends on$/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('an invalid map shows the error instead of a graph', async ($, on) => {
  fakeRepo(on, { 'claude-nodes.json': '{"sections": []}' }, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
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
  expect(prompts[0]).toContain('claude-nodes.json')
})

test('a tool call lights up its section, and the turn ending leaves a trail', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  await run($, 'reload')

  await $.turn.start({ text: 'fix the api', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/src/api/routes.ts', old_string: 'a', new_string: 'b' } as never)

  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Editing$/ })).toBeDefined()
  // The active box shows the file it is on instead of its folder.
  expect(await ui.find({ type: 'Text', text: /^routes\.ts$/ })).toBeDefined()
  expect((await ui.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'double', borderColor: 'claude' })
  expect((await ui.find({ key: 'box-db' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle' })
  await ui.unmount()

  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
  const after = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /Idle · last/ })).toBeDefined()
  // Off duty: no box is doubled, and the section it worked in stays dim orange.
  expect((await after.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude', borderDimColor: true })
  await after.unmount()
})

test('a subagent shows on its own line and leaves when its turn ends', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  await run($, 'reload')

  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', agentId: 'a1', file_path: '/repo/src/db/schema.sql' } as never)
  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^subagent $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^schema\.sql$/ })).toBeDefined()
  await ui.unmount()

  await $.turn.complete({ agentId: 'a1', turnId: 't2', answer: '', durationMs: 5, isAborted: false, reason: 'answer' } as never)
  const after = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /^subagent $/ })).toBeUndefined()
  await after.unmount()
})

test('reading a file no section owns marks the map out of date', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify({ ...MAP, sections: MAP.sections.slice(0, 2) }) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  await run($, 'reload')
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/repo/src/jobs/queue.ts' } as never)
  // Hidden folders are not part of the map, so reading there is no drift.
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/repo/.github/ci.yml' } as never)

  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Map out of date: 1 unmapped$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/jobs\/queue\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('parallel commands over several files light every section they touch', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db', 'legacy'])
  // Hold each call open until the test lets it finish, as a slow command would.
  const finish: (() => void)[] = []
  on('tool.call', () => new Promise(resolve => finish.push(() => resolve({ result: { ok: true } } as never))))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)
  await run($, 'reload')
  await $.turn.start({ text: 'explain each file', turnId: 't1' } as never)

  // The two commands Claude ran side by side when asked to explain each file.
  const first = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'cat -n src/api/a.ts src/db/b.sql' } as never)
  const second = $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'sed -n 1,20p legacy/old.ts' } as never)
  // Let both calls get past the plugin to the (held) tool.
  for (let i = 0; i < 1000 && finish.length < 2; i++) await Promise.resolve()
  expect(finish).toHaveLength(2)

  const ui = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  for (const id of ['api', 'db', 'gone']) {
    expect((await ui.find({ key: `box-${id}` }))?.props).toMatchObject({ borderStyle: 'double' })
  }
  // Each box shows the file the command reads there.
  expect(await ui.find({ type: 'Text', text: /^b\.sql$/ })).toBeDefined()
  await ui.unmount()

  // Once both finish, the latest call stays lit and the other becomes trail.
  for (const done of finish) done()
  await Promise.all([first, second])
  const after = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect((await after.find({ key: 'box-gone' }))?.props).toMatchObject({ borderStyle: 'double' })
  expect((await after.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude' })
  await after.unmount()
})

test('a session that starts with the pane closed says how to reopen it', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('session.start', async (_, e) => e as never)
  mock.store(on, { paneClosed: true })
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  expect(statuses.at(-1)).toBe('pane closed · /claude-nodes to reopen')

  await run($, '')
  expect(statuses.at(-1)).toBeUndefined()
})

test('after a /clear the map loads again without a session start', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('session.end', async (_, e) => ({ sessionId: e.sessionId }) as never)
  on('ui.panes', async () => ({ value: [{ id: 'claude-nodes', title: 'Claude Nodes', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  // A fresh session's state: nothing loaded, as the pane found it after /clear.
  const before = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await before.find({ type: 'Text', text: /No map yet/ })).toBeDefined()
  await before.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1)

  const after = await $.ui.mount({ plugin: 'claude-nodes', surface: 'terminal', ...PANE })
  expect(await after.find({ key: 'box-api' })).toBeDefined()
  await after.unmount()
  // The pane is still up, so no "pane closed" hint.
  expect(statuses.at(-1)).toBeUndefined()
})
