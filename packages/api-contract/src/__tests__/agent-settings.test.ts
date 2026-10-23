import { describe, expect, test } from 'bun:test';
import { AGENT_SETTING_HARNESSES, ignoredAgentSettings, type AgentSetting, toolAllowed } from '../runtime-relay';

describe('ignoredAgentSettings', () => {
  test('pi ignores only the OpenCode provider options and the TUI color', () => {
    expect(ignoredAgentSettings('pi')).toEqual(['options', 'color']);
  });

  test('OpenCode applies every setting', () => {
    expect(ignoredAgentSettings('opencode')).toEqual(['codemode']);
  });

  test('an unknown harness applies none', () => {
    expect(ignoredAgentSettings('other')).toEqual(Object.keys(AGENT_SETTING_HARNESSES) as AgentSetting[]);
  });
});

describe('toolAllowed', () => {
  test('a tool is allowed unless its own entry or `*` says false', () => {
    expect(toolAllowed(undefined, 'bash')).toBe(true);
    expect(toolAllowed({}, 'bash')).toBe(true);
    expect(toolAllowed({ bash: false }, 'bash')).toBe(false);
    expect(toolAllowed({ bash: false }, 'read')).toBe(true);
    expect(toolAllowed({ '*': false, read: true }, 'read')).toBe(true);
    expect(toolAllowed({ '*': false, read: true }, 'bash')).toBe(false);
    expect(toolAllowed({ '*': false }, 'constructor')).toBe(false);
    expect(toolAllowed({ bash: false }, 'constructor')).toBe(true);
  });

  test('an allowlist keeps the platform tools; only an entry that names one removes it', () => {
    expect(toolAllowed({ '*': false, read: true }, 'remember')).toBe(true);
    expect(toolAllowed({ '*': false }, 'memory_search')).toBe(true);
    expect(toolAllowed({ '*': false, remember: false }, 'remember')).toBe(false);
    expect(toolAllowed({ remember: false }, 'remember')).toBe(false);
  });
});
