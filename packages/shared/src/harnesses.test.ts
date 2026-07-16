import { describe, it, expect } from 'bun:test';
import { HARNESS_IDS, HARNESSES, harnessesByStability } from './harnesses';

describe('HARNESSES descriptor', () => {
  it('covers exactly the four harness ids', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(Object.keys(HARNESSES).sort()).toEqual([...HARNESS_IDS].sort());
  });
  it('marks only opencode stable', () => {
    expect(harnessesByStability('stable')).toEqual(['opencode']);
    expect(harnessesByStability('experimental').sort()).toEqual(['claude', 'codex', 'pi']);
  });
  it('encodes namespacing + default ownership per grounding', () => {
    expect(HARNESSES.opencode.modelNamespacing).toBe('gateway-prefixed');
    expect(HARNESSES.claude.modelNamespacing).toBe('bare');
    expect(HARNESSES.opencode.ownsDefaultModel).toBe(false);
    expect(HARNESSES.claude.ownsDefaultModel).toBe(true);
  });
  it('restricts claude/codex to harness-based auth (no managed_gateway)', () => {
    expect(HARNESSES.claude.authKinds).not.toContain('managed_gateway');
    expect(HARNESSES.codex.authKinds).not.toContain('managed_gateway');
    expect(HARNESSES.opencode.authKinds).toContain('managed_gateway');
  });
  it('pins the correct adapter package per grounding matrix', () => {
    expect(HARNESSES.claude.adapterPkg).toBe('@agentclientprotocol/claude-agent-acp');
    expect(HARNESSES.codex.adapterPkg).toBe('@agentclientprotocol/codex-acp');
  });
  it('pins the remaining adapter packages and config directories', () => {
    expect(HARNESSES.opencode.adapterPkg).toBe('opencode-ai');
    expect(HARNESSES.pi.adapterPkg).toBe('pi-acp');
    expect(HARNESSES.claude.configDir).toBe('.claude');
    expect(HARNESSES.codex.configDir).toBe('.codex');
    expect(HARNESSES.opencode.configDir).toBe('.kortix/opencode');
    expect(HARNESSES.pi.configDir).toBe('.pi');
  });
  it('matches the SDK presentation labels', () => {
    expect(HARNESSES.claude.label).toBe('Claude Code');
    expect(HARNESSES.codex.label).toBe('Codex');
    expect(HARNESSES.opencode.label).toBe('OpenCode');
    expect(HARNESSES.pi.label).toBe('Pi');
  });
  it('encodes the full auth-kind matrix from the founder decision (2026-07-15)', () => {
    expect(HARNESSES.claude.authKinds).toEqual(['claude_subscription', 'anthropic_api_key', 'native_config']);
    expect(HARNESSES.codex.authKinds).toEqual(['codex_subscription', 'openai_api_key', 'native_config']);
    expect(HARNESSES.opencode.authKinds).toEqual([
      'managed_gateway',
      'anthropic_api_key',
      'openai_api_key',
      'openai_compatible',
      'native_config',
    ]);
    expect(HARNESSES.pi.authKinds).toEqual([
      'managed_gateway',
      'anthropic_api_key',
      'openai_api_key',
      'openai_compatible',
      'native_config',
    ]);
  });
  it('never routes anthropic_compatible to any harness (parked auth kind)', () => {
    for (const id of HARNESS_IDS) {
      expect(HARNESSES[id].authKinds).not.toContain('anthropic_compatible');
    }
  });
  it('matches subscription auth flows per harness', () => {
    expect(HARNESSES.claude.subscriptionAuth).toBe('oauth-token');
    expect(HARNESSES.codex.subscriptionAuth).toBe('oauth-device');
    expect(HARNESSES.opencode.subscriptionAuth).toBeNull();
    expect(HARNESSES.pi.subscriptionAuth).toBeNull();
  });
  it('encodes live model change only for opencode', () => {
    expect(HARNESSES.opencode.liveModelChange).toBe(true);
    expect(HARNESSES.claude.liveModelChange).toBe(false);
    expect(HARNESSES.codex.liveModelChange).toBe(false);
    expect(HARNESSES.pi.liveModelChange).toBe(false);
  });
});
