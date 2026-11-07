// A space's agents are a boundary (flag `chat`): the pure halves of
// projects/lib/front-thread.ts that decide which agents a router of a space
// may hand work to. session-create.ts refuses a router's worker spawn outside
// this roster with 400 AGENT_NOT_IN_SPACE and the roster in the message.
import { describe, expect, test } from 'bun:test';
import { spaceRosterAllows, spaceRowAgents } from '../projects/lib/front-thread';

describe('spaceRowAgents', () => {
  test('a channel returns its agents in order, the first is the default', () => {
    expect(spaceRowAgents({ kind: 'channel', agents: ['worker', 'writer'], dmAgentName: null })).toEqual(['worker', 'writer']);
  });

  test('a channel with no agents returns an empty list', () => {
    expect(spaceRowAgents({ kind: 'channel', agents: null, dmAgentName: null })).toEqual([]);
  });

  test('the person\'s own space leads with My Kortix, then its agents, without a duplicate', () => {
    expect(spaceRowAgents({ kind: 'dm', agents: ['worker', 'mykortix'], dmAgentName: 'mykortix' })).toEqual(['mykortix', 'worker']);
  });
});

describe('spaceRosterAllows', () => {
  test('allows an agent of the space, case-insensitive', () => {
    expect(spaceRosterAllows(['worker'], null, 'Worker')).toEqual({ allowed: true, roster: ['worker'] });
  });

  test('refuses an agent outside the space and returns the roster', () => {
    expect(spaceRosterAllows(['worker'], null, 'mykortix')).toEqual({ allowed: false, roster: ['worker'] });
  });

  test('an empty space falls back to the project default agent only', () => {
    expect(spaceRosterAllows([], 'writer', 'writer').allowed).toBe(true);
    expect(spaceRosterAllows([], 'writer', 'worker')).toEqual({ allowed: false, roster: ['writer'] });
  });

  test('an empty space in a project with no default agent allows My Kortix only', () => {
    expect(spaceRosterAllows([], null, 'mykortix')).toEqual({ allowed: true, roster: ['mykortix'] });
    expect(spaceRosterAllows([], null, 'worker').allowed).toBe(false);
  });
});
