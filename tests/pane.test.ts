import { expect, test } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Project map' }, requestId: 'project-map' } as const

test('terminal pane draws every section and the active step', async $ => {
  const ui = await $.ui.mount({ plugin: 'project-map', surface: 'terminal', ...PANE })
  for (const label of ['Web UI', 'CLI', 'API', 'Auth', 'Services', 'Database', 'Utils']) {
    expect(await ui.find({ type: 'Text', text: new RegExp(label) })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /Reading/ })).toBeDefined()
  await ui.unmount()
})

test('desktop pane draws the map as an svg', async $ => {
  const ui = await $.ui.mount({ plugin: 'project-map', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})
