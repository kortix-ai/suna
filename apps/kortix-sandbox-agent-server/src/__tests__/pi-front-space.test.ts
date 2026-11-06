import { describe, expect, test } from 'bun:test'

import { frontCall, frontAgentsFromDetail } from '@/harness/pi/front'
import { frontSpaceAgentsFrom, frontSpaceRoster, frontSpaceRosterSection } from '@/harness/pi/front-space'

const project = [
  { name: 'worker', description: 'General-purpose worker' },
  { name: 'researcher', description: 'Finds sources', isDefault: true },
]
const call = { description: 'Write a haiku', prompt: 'Write a haiku about Porto' }

describe("a router's roster inside a space", () => {
  test('the space body list: names only, trimmed, once each; anything else is no list', () => {
    expect(frontSpaceAgentsFrom([' worker', 'Worker', 7, '', 'researcher'])).toEqual(['worker', 'researcher'])
    expect(frontSpaceAgentsFrom(undefined)).toBeNull()
    expect(frontSpaceAgentsFrom('worker')).toBeNull()
  })

  test("only the space's agents, in order, the first the default, with the project's descriptions", () => {
    const roster = frontSpaceRoster(project, ['worker'])!
    expect(roster.agents).toEqual([{ name: 'worker', description: 'General-purpose worker' }])
    expect(roster.defaultAgent).toBe('worker')
    const section = frontSpaceRosterSection(roster)
    expect(section).toContain('- worker (the default): General-purpose worker')
    expect(section).not.toContain('researcher')
    expect(section).not.toContain('mykortix')
  })

  test("an empty space list: the project's default agent alone; without one, My Kortix", () => {
    expect(frontSpaceRoster(project, [])!.agents.map((a) => a.name)).toEqual(['researcher'])
    expect(frontSpaceRoster([{ name: 'worker' }], [])!.agents.map((a) => a.name)).toEqual(['mykortix'])
  })

  test("the person's own space: My Kortix", () => {
    const roster = frontSpaceRoster(project, ['mykortix'])!
    expect(roster.defaultAgent).toBe('mykortix')
    expect(roster.agents[0]!.description).toContain('My Kortix')
  })

  test('no list (an older API, no space): the project roster rules as before', () => {
    expect(frontSpaceRoster(project, null)).toBeNull()
  })

  test("the project's default is marked from /detail", () => {
    const agents = frontAgentsFromDetail({ config: { default_agent: 'researcher', agents: [{ name: 'worker' }, { name: 'researcher' }] } })
    expect(agents).toEqual([{ name: 'worker' }, { name: 'researcher', isDefault: true }])
  })
})

describe("a router's hand-off inside a space", () => {
  const router = { agents: ['worker'], spaceDefault: 'worker' }

  test("no agent named: the space's default, not My Kortix", () => {
    expect(frontCall(call, router).subagent_type).toBe('worker')
  })

  test('an agent outside the space, My Kortix included, is refused with the roster', () => {
    expect(() => frontCall({ ...call, subagent_type: 'researcher' }, router)).toThrow('"researcher" is not an agent of this space. Pick one of: worker.')
    expect(() => frontCall({ ...call, subagent_type: 'mykortix' }, router)).toThrow('is not an agent of this space')
  })

  test('outside a space, My Kortix stays the default and always allowed', () => {
    expect(frontCall(call, { agents: ['worker'] }).subagent_type).toBe('mykortix')
    expect(frontCall({ ...call, subagent_type: 'mykortix' }, { agents: ['worker'] }).subagent_type).toBe('mykortix')
  })
})
