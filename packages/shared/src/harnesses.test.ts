import { describe, expect, it } from 'bun:test';
import {
  CREDENTIAL_CUSTODY,
  HARNESSES,
  HARNESS_IDS,
  type HarnessAuthKind,
  compatibleHarnessesFor,
  harnessesByStability,
} from './harnesses';

const ALL_AUTH_KINDS: HarnessAuthKind[] = [
  'managed_gateway',
  'claude_subscription',
  'anthropic_api_key',
  'codex_subscription',
  'openai_api_key',
  'openai_compatible',
  'anthropic_compatible',
  'native_config',
];

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
    expect(HARNESSES.opencode.configDir).toBe('.opencode');
    expect(HARNESSES.pi.configDir).toBe('.pi');
  });
  it('matches the SDK presentation labels', () => {
    expect(HARNESSES.claude.label).toBe('Claude Code');
    expect(HARNESSES.codex.label).toBe('Codex');
    expect(HARNESSES.opencode.label).toBe('OpenCode');
    expect(HARNESSES.pi.label).toBe('Pi');
  });
  it('encodes the full auth-kind matrix from the founder decision (2026-07-15)', () => {
    expect(HARNESSES.claude.authKinds).toEqual([
      'claude_subscription',
      'anthropic_api_key',
      'native_config',
    ]);
    expect(HARNESSES.codex.authKinds).toEqual([
      'codex_subscription',
      'openai_api_key',
      'native_config',
    ]);
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

  // 2026-07-21 model-resolution refactor decision: Pi is gateway/catalog-
  // driven, not harness-owned — its declared `ownsDefaultModel` used to
  // contradict its actual gateway-catalog launch behavior. Claude/Codex
  // (subscription-backed) remain the named exceptions.
  it('Pi does NOT own its default model (2026-07-21 decision) — only Claude/Codex do; OpenCode never did', () => {
    expect(HARNESSES.pi.ownsDefaultModel).toBe(false);
    expect(HARNESSES.claude.ownsDefaultModel).toBe(true);
    expect(HARNESSES.codex.ownsDefaultModel).toBe(true);
    expect(HARNESSES.opencode.ownsDefaultModel).toBe(false);
  });
});

describe('compatibleHarnessesFor — pure inverse of HARNESSES[*].authKinds', () => {
  it('round-trips against the one authored direction: every harness/kind pair agrees both ways', () => {
    for (const id of HARNESS_IDS) {
      for (const kind of HARNESS_IDS.flatMap((h) => HARNESSES[h].authKinds)) {
        const forward = HARNESSES[id].authKinds.includes(kind);
        const inverse = compatibleHarnessesFor(kind).includes(id);
        expect(inverse).toBe(forward);
      }
    }
  });

  it('matches the 2026-07-15 founder matrix per kind', () => {
    expect(compatibleHarnessesFor('managed_gateway').sort()).toEqual(['opencode', 'pi']);
    expect(compatibleHarnessesFor('claude_subscription')).toEqual(['claude']);
    expect(compatibleHarnessesFor('codex_subscription')).toEqual(['codex']);
    expect(compatibleHarnessesFor('anthropic_compatible')).toEqual([]);
    expect(compatibleHarnessesFor('native_config').sort()).toEqual([...HARNESS_IDS].sort());
  });
});

describe('CREDENTIAL_CUSTODY — hardcoded per credential kind, never per project', () => {
  it('covers every HarnessAuthKind exactly once', () => {
    expect(Object.keys(CREDENTIAL_CUSTODY).sort()).toEqual([...ALL_AUTH_KINDS].sort());
  });

  it('pins claude_subscription and native_config as direct-only (Anthropic ToS / never-a-Kortix-secret)', () => {
    expect(CREDENTIAL_CUSTODY.claude_subscription).toBe('direct-only');
    expect(CREDENTIAL_CUSTODY.native_config).toBe('direct-only');
  });

  it('pins every other kind, including codex_subscription, as relay-eligible', () => {
    for (const kind of ALL_AUTH_KINDS) {
      if (kind === 'claude_subscription' || kind === 'native_config') continue;
      expect(CREDENTIAL_CUSTODY[kind]).toBe('relay-eligible');
    }
  });
});
