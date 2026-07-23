import { describe, expect, it } from 'bun:test';
import {
  CREDENTIAL_CUSTODY,
  HARNESSES,
  HARNESS_IDS,
  type HarnessAuthKind,
  compatibleHarnessesFor,
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
  // `stability` is a maturity signal only (caps config-validation lint
  // severity) — it does not gate selection/start; every harness is equally
  // selectable regardless of this value.
  it('marks only opencode stable', () => {
    expect(HARNESSES.opencode.stability).toBe('stable');
    for (const id of HARNESS_IDS) {
      if (id === 'opencode') continue;
      expect(HARNESSES[id].stability).toBe('experimental');
    }
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
      // 2026-07-22 Codex-subscription widening: OpenCode's OpenAI-compatible
      // client speaks chat-completions, which the subscription relay now
      // translates to the ChatGPT-backend Responses shape server-side
      // (docs/specs/2026-07-21-llm-credential-and-model-management.md D1), so
      // it is usable on OpenCode as well as Codex/Pi.
      'codex_subscription',
      'openai_api_key',
      'openai_compatible',
      'native_config',
    ]);
    expect(HARNESSES.pi.authKinds).toEqual([
      'managed_gateway',
      'anthropic_api_key',
      // 2026-07-22 Codex-subscription widening: Pi speaks OpenAI Responses
      // natively and the credential relays server-side, so it is usable on Pi
      // as well as Codex (docs/specs/2026-07-21-llm-credential-and-model-
      // management.md D1).
      'codex_subscription',
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

  it('matches the founder matrix per kind (with the 2026-07-22 Codex-subscription widening)', () => {
    expect(compatibleHarnessesFor('managed_gateway').sort()).toEqual(['opencode', 'pi']);
    expect(compatibleHarnessesFor('claude_subscription')).toEqual(['claude']);
    // 2026-07-22: Codex subscription is now usable on Codex, OpenCode, and Pi —
    // the credential relays server-side (never reaches the sandbox), which is
    // safe per docs/specs/2026-07-21-llm-credential-and-model-management.md D1.
    // OpenCode reaches it through the chat-completions→Responses translation
    // lane on the same relay. HARNESS_IDS order is [claude, codex, opencode,
    // pi], so the derived inverse is [codex, opencode, pi]. Claude subscription
    // stays pinned to Claude only (Anthropic ToS: direct-only custody).
    expect(compatibleHarnessesFor('codex_subscription')).toEqual(['codex', 'opencode', 'pi']);
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
