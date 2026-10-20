import { describe, expect, test } from 'claude-code/testing'

import type { MapActivity, ProjectMap } from '../types'
import { connectorRows, routeBand } from '../hooks/connectors'
import { globToRegExp } from '../hooks/graph'
import { layoutMap } from '../hooks/layout'
import { EMPTY_TRACKING, MAIN, endCall, endTurn, highlightOf, sanitize, startCall, startTurn } from '../hooks/tracking'

const act = (sections: string[], file: string, callId: string, action: MapActivity['action'] = 'Reading'): MapActivity => ({
  sections,
  files: Object.fromEntries(sections.map(id => [id, file])),
  file,
  action,
  callId,
})

describe('tracking', () => {
  test('a call lights its sections while it runs, then stays lit as the latest while the turn runs', () => {
    let t = startTurn(EMPTY_TRACKING)
    const a = act(['api', 'db'], 'src/api/a.ts', 'c1')
    t = startCall(t, MAIN, a)
    expect([...highlightOf(t).active]).toEqual(['api', 'db'])
    expect(t.touches).toEqual({ api: { reads: 1, edits: 0, runs: 0 }, db: { reads: 1, edits: 0, runs: 0 } })

    t = endCall(t, 'c1')
    expect(t.running).toEqual({})
    expect(t.live[MAIN]).toEqual(a)
    expect([...highlightOf(t).active]).toEqual(['api', 'db'])

    // The turn ends: nothing is active, what it touched stays as the trail.
    t = endTurn(t, MAIN)
    expect(highlightOf(t).active.size).toBe(0)
    expect([...highlightOf(t).trail]).toEqual(['api', 'db'])
  })

  test('parallel calls are all lit; the one that ends first leaves the latest alone', () => {
    let t = startTurn(EMPTY_TRACKING)
    const a = act(['api'], 'src/api/a.ts', 'c1')
    const b = act(['db'], 'src/db/b.sql', 'c2', 'Editing')
    t = startCall(t, MAIN, a)
    t = startCall(t, MAIN, b)
    expect(new Set(highlightOf(t).active)).toEqual(new Set(['api', 'db']))

    t = endCall(t, 'c1')
    // b is still the latest and still running; a joins the trail.
    expect(t.live[MAIN]).toEqual(b)
    expect([...highlightOf(t).active]).toEqual(['db'])
    expect([...highlightOf(t).trail]).toEqual(['api'])
    expect(t.touches.db).toEqual({ reads: 0, edits: 1, runs: 0 })
  })

  test("a subagent's turn ending takes it, and any call it left running, off the map", () => {
    let t = startTurn(EMPTY_TRACKING)
    t = startCall(t, 'agent-1', act(['api'], 'src/api/a.ts', 'c1'))
    expect([...highlightOf(t).active]).toEqual(['api'])
    t = endTurn(t, 'agent-1')
    expect(t.live).toEqual({})
    expect(t.running).toEqual({})
    expect(highlightOf(t).active.size).toBe(0)
  })

  test('an interrupted main turn drops the calls it left running', () => {
    let t = startTurn(EMPTY_TRACKING)
    t = startCall(t, MAIN, act(['api'], 'src/api/a.ts', 'c1'))
    t = endTurn(t, MAIN)
    expect(t.running).toEqual({})
    expect(t.busy).toBe(false)
  })

  test('sanitize keeps what this version wrote and drops what an older one did', () => {
    const good = act(['api'], 'src/api/a.ts', 'c1')
    // What 0.2.0 stored before calls were told apart by id.
    const old = { sections: ['api'], files: {}, file: 'src/api/a.ts', action: 'Reading', at: 1, isRunning: false }
    const t = sanitize({ busy: true, live: { main: good, other: old }, running: { c: old }, trail: ['api', 3], touches: {} })
    expect(t).toEqual({ busy: true, live: { main: good }, running: {}, trail: ['api'], touches: {} })
    expect(sanitize(undefined)).toEqual(EMPTY_TRACKING)
    expect(sanitize({ live: 'nonsense' })).toEqual(EMPTY_TRACKING)
  })
})

describe('caches', () => {
  const MAP: ProjectMap = {
    version: 1,
    sections: [
      { id: 'a', label: 'A', paths: ['a'] },
      { id: 'b', label: 'B', paths: ['b'] },
    ],
    edges: [['a', 'b']],
  }

  test('a pattern compiles once', () => {
    expect(globToRegExp('src/**')).toBe(globToRegExp('src/**'))
  })

  test('the same map at the same width reuses its layout and routes', () => {
    const layout = layoutMap(MAP, 60)
    // A copy, as each state read hands back: equal content, same layout.
    expect(layoutMap(JSON.parse(JSON.stringify(MAP)), 60)).toBe(layout)
    expect(layoutMap(MAP, 80)).not.toBe(layout)
    expect(routeBand(layout, 0)).toBe(routeBand(layout, 0))
  })
})

describe('line ports', () => {
  test("two lines leave a box evenly around its center, turn together, and land on their targets' centers", () => {
    const map: ProjectMap = {
      version: 1,
      sections: [
        { id: 'top', label: 'Top', paths: ['t'] },
        { id: 'left', label: 'Left', paths: ['l'] },
        { id: 'right', label: 'Right', paths: ['r'] },
      ],
      edges: [['top', 'left'], ['top', 'right']],
    }
    const layout = layoutMap(map, 60)
    const { routes } = routeBand(layout, 0)
    const center = (id: string) => layout.slots.get(id)!.center
    const byTarget = new Map([...routes].map(([seg, route]) => [seg.to, route]))
    expect(byTarget.get('left')!.tb).toBe(center('left'))
    expect(byTarget.get('right')!.tb).toBe(center('right'))
    // Symmetric: as far left of Top's center as right of it.
    expect(center('top') - byTarget.get('left')!.fa).toBe(byTarget.get('right')!.fa - center('top'))
    // Both sides turn on the same row.
    expect(byTarget.get('left')!.elbow).toBe(byTarget.get('right')!.elbow)
  })
  test('lines into one box merge: one arrow at its center, joined on one row', () => {
    const map: ProjectMap = {
      version: 1,
      sections: ['a', 'b', 'c', 'db'].map(id => ({ id, label: id, paths: [id] })),
      edges: [['a', 'db'], ['b', 'db'], ['c', 'db']],
    }
    const layout = layoutMap(map, 80)
    const { routes, height } = routeBand(layout, 0)
    expect(new Set([...routes.values()].map(r => r.tb))).toEqual(new Set([layout.slots.get('db')!.center]))
    expect(new Set([...routes.values()].filter(r => r.fa !== r.tb).map(r => r.elbow)).size).toBe(1)
    expect(height).toBe(3)
  })
  test('lines into a box land where one can drop straight in, and a fan keeps its order: no jogs, no needless crossings', () => {
    // A 12-section web app, as minimap init mapped it: at 80 columns API's lane splits to Auth
    // and Search beside Integrations' line, and Auth sits right over Database.
    const map: ProjectMap = {
      version: 1,
      sections: ([['web', 'Web App'], ['api', 'API'], ['auth', 'Auth'], ['billing', 'Billing'], ['jobs', 'Jobs'], ['db', 'Database'], ['tests', 'Tests'], ['admin', 'Admin'], ['files', 'Files'], ['integrations', 'Integrations'], ['notifications', 'Notifications'], ['search', 'Search']] as const).map(([id, label]) => ({ id, label, paths: [`${id}/**`] })),
      edges: [['web', 'api'], ['api', 'auth'], ['api', 'billing'], ['api', 'db'], ['api', 'jobs'], ['api', 'admin'], ['api', 'files'], ['api', 'integrations'], ['api', 'notifications'], ['api', 'search'], ['auth', 'db'], ['auth', 'jobs'], ['billing', 'db'], ['billing', 'jobs'], ['admin', 'billing'], ['admin', 'db'], ['files', 'billing'], ['files', 'db'], ['integrations', 'notifications'], ['integrations', 'jobs'], ['integrations', 'db'], ['notifications', 'jobs'], ['notifications', 'db'], ['search', 'db'], ['tests', 'api']],
    }
    const layout = layoutMap(map, 80)
    const rowOf = (id: string) => layout.slots.get(id)!.layer
    const band = (above: string) => connectorRows(layout, rowOf(above), new Set()).map(runs => runs.map(r => r.text).join(''))
    const bridge = /[─┌└├┬┴]│[─┐┘┤┬┴]/
    const jog = /[┌└├][┐┘┤]/
    // Admin's row to Auth's: Search takes the lane's straight drop, Auth branches off it, nothing crosses.
    expect(band('admin').some(row => bridge.test(row) || jog.test(row))).toBe(false)
    // Auth's row to Database's: Auth drops straight in, and the other lines join that drop.
    const routes = [...routeBand(layout, rowOf('auth')).routes].filter(([seg]) => seg.to === 'db')
    const fromAuth = routes.find(([seg]) => seg.from === 'auth')![1]
    expect(fromAuth.fa).toBe(fromAuth.tb)
    expect(new Set(routes.map(([, r]) => r.tb))).toEqual(new Set([fromAuth.tb]))
    expect(band('auth').some(row => jog.test(row))).toBe(false)
  })
  test('lines that only pass each other bridge over instead of drawing a join', () => {
    // a and b both use c and d: however they are ordered, two of the lines must cross.
    const map: ProjectMap = {
      version: 1,
      sections: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, paths: [id] })),
      edges: [['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd']],
    }
    const text = connectorRows(layoutMap(map, 80), 0, new Set()).map(runs => runs.map(r => r.text).join(''))
    expect(text.some(row => row.includes('─│'))).toBe(true)
    expect(text.some(row => row.includes('┼'))).toBe(false)
  })
})
