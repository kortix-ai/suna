import { describe, expect, it } from 'bun:test';
import type { AcpSessionConfigOption } from './types';
import {
  findAcpModeConfigOption,
  isAcpModeConfigOption,
  pickMostPermissiveMode,
  resolveDefaultModeToApply,
} from './session-mode';

// Real advertised mode options captured from `kortix.acp_session_envelopes`
// (local DB, 2026-07-22). Kept verbatim so these tests fail loudly if a pinned
// adapter ever changes the ids we default to.
const claudeMode = (currentValue: string, withBypass = true): AcpSessionConfigOption => ({
  id: 'mode',
  name: 'Mode',
  type: 'select',
  category: 'mode',
  currentValue,
  options: [
    { name: 'Auto', value: 'auto' },
    { name: 'Manual', value: 'default' },
    { name: 'Accept Edits', value: 'acceptEdits' },
    { name: 'Plan Mode', value: 'plan' },
    { name: "Don't Ask", value: 'dontAsk' },
    ...(withBypass ? [{ name: 'Bypass Permissions', value: 'bypassPermissions' }] : []),
  ],
});

const codexMode = (currentValue: string): AcpSessionConfigOption => ({
  id: 'mode',
  name: 'Mode',
  type: 'select',
  category: 'mode',
  currentValue,
  options: [
    { name: 'Read-only', value: 'read-only' },
    { name: 'Agent', value: 'agent' },
    { name: 'Agent (full access)', value: 'agent-full-access' },
  ],
});

const opencodeMode = (currentValue: string): AcpSessionConfigOption => ({
  id: 'mode',
  name: 'Session Mode',
  type: 'select',
  category: 'mode',
  currentValue,
  options: [
    { name: 'kortix', value: 'kortix' },
    { name: 'build', value: 'build' },
    { name: 'plan', value: 'plan' },
  ],
});

describe('isAcpModeConfigOption / findAcpModeConfigOption', () => {
  it('matches on id or category', () => {
    expect(isAcpModeConfigOption({ id: 'mode' })).toBe(true);
    expect(isAcpModeConfigOption({ id: 'x', category: 'mode' })).toBe(true);
    expect(isAcpModeConfigOption({ id: 'effort', category: 'thought_level' })).toBe(false);
  });

  it('finds the mode option among siblings', () => {
    const found = findAcpModeConfigOption([
      { id: 'model', category: 'model' },
      claudeMode('default'),
      { id: 'effort', category: 'thought_level' },
    ]);
    expect(found?.id).toBe('mode');
  });
});

describe('pickMostPermissiveMode — most-permissive ADVERTISED mode per harness', () => {
  it('claude → bypassPermissions when advertised (IS_SANDBOX)', () => {
    expect(pickMostPermissiveMode(claudeMode('default'))).toBe('bypassPermissions');
  });

  it('claude → acceptEdits fallback when bypass is NOT advertised (no IS_SANDBOX)', () => {
    expect(pickMostPermissiveMode(claudeMode('default', false))).toBe('acceptEdits');
  });

  it('codex → agent-full-access', () => {
    expect(pickMostPermissiveMode(codexMode('agent'))).toBe('agent-full-access');
  });

  it('opencode → null (personas are not a permission level, never auto-swapped)', () => {
    expect(pickMostPermissiveMode(opencodeMode('kortix'))).toBeNull();
  });

  it('null option / no choices → null', () => {
    expect(pickMostPermissiveMode(null)).toBeNull();
    expect(pickMostPermissiveMode({ id: 'mode', options: [] })).toBeNull();
  });
});

describe('resolveDefaultModeToApply — session-start default', () => {
  it('fresh claude session (current=default) upgrades to bypassPermissions', () => {
    expect(resolveDefaultModeToApply({ option: claudeMode('default') })).toBe('bypassPermissions');
  });

  it('fresh codex session (current=agent) upgrades to agent-full-access', () => {
    expect(resolveDefaultModeToApply({ option: codexMode('agent') })).toBe('agent-full-access');
  });

  it('is a no-op once already in the permissive mode', () => {
    expect(resolveDefaultModeToApply({ option: claudeMode('bypassPermissions') })).toBeNull();
    expect(resolveDefaultModeToApply({ option: codexMode('agent-full-access') })).toBeNull();
  });

  it('does NOT stomp a deliberate non-default current mode (plan / acceptEdits)', () => {
    expect(resolveDefaultModeToApply({ option: claudeMode('plan') })).toBeNull();
    expect(resolveDefaultModeToApply({ option: claudeMode('acceptEdits') })).toBeNull();
  });

  it('opencode session is never touched', () => {
    expect(resolveDefaultModeToApply({ option: opencodeMode('kortix') })).toBeNull();
    expect(resolveDefaultModeToApply({ option: opencodeMode('build') })).toBeNull();
  });

  describe('explicit user choice wins over the permissive default', () => {
    it('restores the persisted explicit mode when the session differs', () => {
      expect(
        resolveDefaultModeToApply({ option: claudeMode('default'), explicitValue: 'plan' }),
      ).toBe('plan');
    });

    it('is a no-op when the session already matches the explicit choice', () => {
      expect(
        resolveDefaultModeToApply({ option: claudeMode('plan'), explicitValue: 'plan' }),
      ).toBeNull();
    });

    it('falls back to the permissive default when the explicit choice is no longer advertised', () => {
      expect(
        resolveDefaultModeToApply({ option: claudeMode('default'), explicitValue: 'no-such-mode' }),
      ).toBe('bypassPermissions');
    });
  });
});
