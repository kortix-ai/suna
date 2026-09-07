/**
 * The usability rule, host-side (spec 2026-09-06 §2): a roster entry is
 * usable in a session iff it is global, or the session's space owns or
 * references it. Pure — every host (web, mobile, demo) filters the same way.
 */
import { describe, expect, test } from 'bun:test';
import { agentsUsableIn, type RosterAgent } from './index';

const roster: RosterAgent[] = [
  { name: 'kortix', space: null } as RosterAgent,
  { name: 'writer', space: 'marketing' } as RosterAgent,
  { name: 'researcher', space: 'research' } as RosterAgent,
  { name: 'legacy' } as RosterAgent, // an older server: no field at all ⇒ global
];

describe('agentsUsableIn', () => {
  test('the whole project sees globals only', () => {
    expect(agentsUsableIn(roster, null).map((a) => a.name)).toEqual(['kortix', 'legacy']);
    expect(agentsUsableIn(roster, undefined).map((a) => a.name)).toEqual(['kortix', 'legacy']);
  });

  test('a space sees globals plus what it owns or references, in roster order', () => {
    expect(
      agentsUsableIn(roster, { agents: ['writer', 'researcher'] }).map((a) => a.name),
    ).toEqual(['kortix', 'writer', 'researcher', 'legacy']);
    expect(agentsUsableIn(roster, { agents: ['researcher'] }).map((a) => a.name)).toEqual([
      'kortix',
      'researcher',
      'legacy',
    ]);
  });

  test('never mutates the input', () => {
    const copy = roster.map((a) => ({ ...a }));
    agentsUsableIn(roster, { agents: ['writer'] });
    expect(roster).toEqual(copy);
  });
});
