import { describe, expect, test } from 'bun:test';
import { goalAgentCandidates } from './rules';

const agents = [
  { name: 'mykortix', mode: 'primary', platform: true, enabled: true, sandbox: 'mykortix' },
  { name: 'helper', mode: 'subagent', enabled: true },
  { name: 'worker', mode: 'primary', enabled: true },
  { name: 'hidden-one', mode: 'primary', enabled: true, hidden: true },
  { name: 'off', mode: 'primary', enabled: false },
];

describe('goalAgentCandidates', () => {
  test('a default without Files (My Kortix) is skipped: primary agents with Files first, then subagents', () => {
    expect(goalAgentCandidates({ default_agent: 'mykortix', agents })).toEqual(['worker', 'helper']);
  });
  test('a default that can work a goal comes first', () => {
    expect(goalAgentCandidates({ default_agent: 'helper', agents })).toEqual(['helper', 'worker']);
  });
  test('no agent with Files, or no config → empty', () => {
    expect(goalAgentCandidates({ default_agent: 'mykortix', agents: [agents[0]!] })).toEqual([]);
    expect(goalAgentCandidates(null)).toEqual([]);
  });
});
