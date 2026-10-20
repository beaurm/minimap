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
  title: 'Minimap',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const PANE = { component: 'Pane', props: PROPS, requestId: 'minimap' } as const

/**
 * A fake repo: the files the plugin may read, and its folders. The engine
 * hands these hooks absolute paths, so a key matches as a path suffix.
 */
function fakeRepo(on: On, files: Record<string, string>, dirs: string[], stamps: Record<string, number> = {}) {
  const is = (path: string, key: string) => path === key || path.endsWith(`/${key}`)
  const file = (path: string) => Object.keys(files).find(key => is(path, key))
  const exists = (path: string) => file(path) !== undefined || dirs.some(d => is(path, d))
  on('fs.exists', async (_, e) => ({ value: exists(e.path) }))
  on('fs.read', async (_, e) => {
    const key = file(e.path)
    return key ? { value: files[key]! } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.stat', async (_, e) => ({ value: { kind: 'file', size: 0, mtimeMs: stamps[file(e.path) ?? ''] ?? 1, isLink: false } }) as never)
  on('fs.list', async () => ({
    value: [...new Set(dirs.map(d => d.split('/')[0]!))].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('session.cwd', async () => ({ value: '/repo' }))
}

/** Runs `/minimap <args>` as the person would. */
const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'minimap',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  } as never)

test('no map: the pane says how to make one', async ($, on) => {
  fakeRepo(on, {}, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /No map yet/ })).toBeDefined()
  await ui.unmount()
})

test('a map draws its sections and reports drift', async ($, on) => {
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db', 'scripts'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  for (const label of ['API', 'Database', 'Legacy']) {
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })).toBeDefined()
  }
  // scripts/ is covered by no section; legacy/ no longer exists.
  expect(await ui.find({ type: 'Text', text: /1 unmapped, 1 missing section/ })).toBeDefined()
  // The legend: one entry per line, "orange" drawn in orange.
  expect((await ui.find({ type: 'Text', text: /^orange$/ }))?.props).toMatchObject({ color: 'claude' })
  expect(await ui.find({ type: 'Text', text: /^▼ depends on$/ })).toBeDefined()
  await ui.unmount()
})

test('an invalid map shows the error instead of a graph', async ($, on) => {
  fakeRepo(on, { 'minimap.json': '{"sections": []}' }, ['src'])
  await run($, 'reload')
  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
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
  expect(prompts[0]).toContain('minimap.json')
})

test('a tool call lights up its section, and the turn ending leaves a trail', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  await run($, 'reload')

  await $.turn.start({ text: 'fix the api', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/src/api/routes.ts', old_string: 'a', new_string: 'b' } as never)

  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Editing$/ })).toBeDefined()
  // The active box shows the file it is on instead of its folder.
  expect(await ui.find({ type: 'Text', text: /^routes\.ts$/ })).toBeDefined()
  expect((await ui.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'double', borderColor: 'claude' })
  expect((await ui.find({ key: 'box-db' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle' })
  await ui.unmount()

  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
  const after = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /Idle · last/ })).toBeDefined()
  // Off duty: no box is doubled, and the section it worked in stays dim orange.
  expect((await after.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude', borderDimColor: true })
  await after.unmount()
})

test('a subagent shows on its own line and leaves when its turn ends', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  await run($, 'reload')

  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', agentId: 'a1', file_path: '/repo/src/db/schema.sql' } as never)
  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^subagent $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^schema\.sql$/ })).toBeDefined()
  await ui.unmount()

  await $.turn.complete({ agentId: 'a1', turnId: 't2', answer: '', durationMs: 5, isAborted: false, reason: 'answer' } as never)
  const after = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /^subagent $/ })).toBeUndefined()
  await after.unmount()
})

test('reading a file no section owns marks the map out of date', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify({ ...MAP, sections: MAP.sections.slice(0, 2) }) }, ['src/api', 'src/db'])
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  await run($, 'reload')
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/repo/src/jobs/queue.ts' } as never)
  // Hidden folders are not part of the map, so reading there is no drift.
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/repo/.github/ci.yml' } as never)

  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Map out of date: 1 unmapped$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/jobs\/queue\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('parallel commands over several files light every section they touch', async ($, on) => {
  mock.clock(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db', 'legacy'])
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

  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  for (const id of ['api', 'db', 'gone']) {
    expect((await ui.find({ key: `box-${id}` }))?.props).toMatchObject({ borderStyle: 'double' })
  }
  // Each box shows the file the command reads there.
  expect(await ui.find({ type: 'Text', text: /^b\.sql$/ })).toBeDefined()
  await ui.unmount()

  // Once both finish, the latest call stays lit and the other becomes trail.
  for (const done of finish) done()
  await Promise.all([first, second])
  const after = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect((await after.find({ key: 'box-gone' }))?.props).toMatchObject({ borderStyle: 'double' })
  expect((await after.find({ key: 'box-api' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude' })
  await after.unmount()
})

/**
 * A fake Claude Code pane: `$.ui.open` places it only when the terminal is wide
 * enough or the person asked (a command), as the real one does; the test
 * widens the terminal by flipping `wide`.
 */
function fakePane(on: On) {
  // `drawsPanes` false is a surface that is attached but places no panes.
  const pane = { isOpen: false, isPlaced: false, wide: false, drawsPanes: true, surfaces: ['terminal'] }
  const statuses: (string | undefined)[] = []
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.surfaces', async () => ({ value: pane.surfaces }) as never)
  on('ui.open', async () => {
    pane.isOpen = true
    pane.isPlaced = pane.drawsPanes && pane.wide
    if (pane.isPlaced) return { value: { isPlaced: true } } as never
    const reason = pane.drawsPanes
      ? 'opened unasked under the 144 columns floor; the terminal is 100 columns'
      : 'the attached surfaces (vscode) place no panes'
    return { value: { isPlaced: false, reason } } as never
  })
  on('ui.panes', async () => ({
    value: pane.isOpen ? [{ id: 'minimap', title: 'Minimap', isShown: pane.isPlaced, isFocused: false, isPlaced: pane.isPlaced }] : [],
  }) as never)
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('session.start', async (_, e) => e as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)
  return { pane, statuses }
}

test('a pane the person closed stays closed, and the line under the prompt says how to reopen it', async ($, on) => {
  const { pane, statuses } = fakePane(on)
  pane.wide = true
  mock.store(on, { paneClosed: true })
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  expect(pane.isOpen).toBe(false)
  expect(statuses.at(-1)).toBe('pane closed · /minimap to reopen')

  await run($, '')
  expect(pane.isPlaced).toBe(true)
  expect(statuses.at(-1)).toBeUndefined()
})

test('in a narrow terminal the pane waits, without claiming it was closed, and is picked up once it shows', async ($, on) => {
  const { pane, statuses } = fakePane(on)
  mock.store(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  // Too narrow for a pane nobody asked for: it waits undrawn.
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  expect(pane.isOpen).toBe(true)
  expect(pane.isPlaced).toBe(false)
  expect(statuses.at(-1)).toBe('/minimap to open the map')

  // The terminal gets wider and Claude Code places the waiting pane; the next turn notices.
  pane.isPlaced = true
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(statuses.at(-1)).toBeUndefined()
})

test('after a /clear the map loads again without a session start', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('session.end', async (_, e) => ({ sessionId: e.sessionId }) as never)
  on('ui.panes', async () => ({ value: [{ id: 'minimap', title: 'Minimap', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  // A fresh session's state: nothing loaded, as the pane found it after /clear.
  const before = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await before.find({ type: 'Text', text: /No map yet/ })).toBeDefined()
  await before.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1)

  const after = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await after.find({ key: 'box-api' })).toBeDefined()
  await after.unmount()
  // The pane is still up, so no "pane closed" hint.
  expect(statuses.at(-1)).toBeUndefined()
})

test('a map changed without the file tools (a script, an editor) reloads when the turn ends', async ($, on) => {
  mock.clock(on)
  const files: Record<string, string> = { 'minimap.json': JSON.stringify({ ...MAP, sections: MAP.sections.slice(0, 2) }) }
  const stamps: Record<string, number> = { 'minimap.json': 1 }
  fakeRepo(on, files, ['src/api', 'src/db', 'scripts'], stamps)
  on('turn.complete', async () => ({ text: '' }) as never)
  await run($, 'reload')

  const before = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await before.find({ type: 'Text', text: /^Map out of date: 1 unmapped$/ })).toBeDefined()
  await before.unmount()

  // What the update did in that repo: a Python script through Bash rewrote the file.
  const updated = { ...MAP, sections: [...MAP.sections.slice(0, 2), { id: 'scripts', label: 'Scripts', paths: ['scripts/**'] }] }
  files['minimap.json'] = JSON.stringify(updated)
  stamps['minimap.json'] = 2
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)

  const after = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await after.find({ key: 'box-scripts' })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /^Map up to date$/ })).toBeDefined()
  await after.unmount()
})

test("a repo still on the old file name keeps its map, and update edits that file", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', async (_, e) => {
    prompts.push(e.text)
    return { drop: 'captured by the test' } as never
  })
  fakeRepo(on, { 'claude-nodes.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])
  await run($, 'reload')

  const ui = await $.ui.mount({ plugin: 'minimap', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'box-api' })).toBeDefined()
  await ui.unmount()

  await run($, 'update')
  await clock.advance(10)
  expect(prompts[0]).toContain('Update the project map at `claude-nodes.json`')
})

test('update sends Claude the map file as it is, fields the plugin ignores included', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', async (_, e) => {
    prompts.push(e.text)
    return { drop: 'captured by the test' } as never
  })
  // "owner" means nothing to minimap, but it is the person's: Claude must see it to keep it.
  const text = JSON.stringify({ ...MAP, owner: 'platform-team' }, null, 2)
  fakeRepo(on, { 'minimap.json': text }, ['src/api', 'src/db'])
  await run($, 'reload')
  await run($, 'update')
  await clock.advance(10)
  expect(prompts[0]).toContain('"owner": "platform-team"')
  expect(prompts[0]).toContain(text)
})

test('where no pane can be drawn, no hint, and /minimap says why', async ($, on) => {
  const { pane, statuses } = fakePane(on)
  pane.drawsPanes = false
  mock.store(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  expect(statuses.at(-1)).toBeUndefined()

  const answer = (await run($, '')) as { text?: string }
  expect(answer.text).toContain("can't show plugin panes")
  expect(statuses.at(-1)).toBeUndefined()
})

test('outside a terminal (the VS Code panel) the pane never opens, even where it could be drawn', async ($, on) => {
  const { pane, statuses } = fakePane(on)
  pane.wide = true
  pane.surfaces = ['vscode']
  mock.store(on)
  fakeRepo(on, { 'minimap.json': JSON.stringify(MAP) }, ['src/api', 'src/db'])

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  expect(pane.isOpen).toBe(false)
  expect(statuses.at(-1)).toBeUndefined()

  const answer = (await run($, '')) as { text?: string }
  expect(answer.text).toContain("can't show plugin panes")
  expect(pane.isOpen).toBe(false)

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(statuses.at(-1)).toBeUndefined()
})
