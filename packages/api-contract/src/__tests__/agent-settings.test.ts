import { describe, expect, test } from 'bun:test';
import { AGENT_SETTING_HARNESSES, ignoredAgentSettings, type AgentSetting } from '../runtime-relay';

describe('ignoredAgentSettings', () => {
  test('pi ignores only the OpenCode provider options and the TUI color', () => {
    expect(ignoredAgentSettings('pi')).toEqual(['options', 'color']);
  });

  test('OpenCode applies every setting', () => {
    expect(ignoredAgentSettings('opencode')).toEqual([]);
  });

  test('an unknown harness applies none', () => {
    expect(ignoredAgentSettings('other')).toEqual(Object.keys(AGENT_SETTING_HARNESSES) as AgentSetting[]);
  });
});
