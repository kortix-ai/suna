import { describe, expect, test } from 'bun:test';
import { applyAgentScopeV2 } from './agent-config-v2';

/**
 * `connectors_personal` is the subset of an agent's `connectors` grant that must
 * resolve to the LAUNCHING USER's own connection. The manifest parser rejects the
 * whole agent block if that subset rule is violated — and a manifest that fails
 * to parse breaks session-create for the agent — so the scope editor must never
 * be able to WRITE an invalid combination, no matter which order the user edits
 * the two fields in.
 */
const manifest = (agents: Record<string, unknown>) => ({
  schemaVersion: 2,
  format: 'yaml' as const,
  path: 'kortix.yaml',
  raw: { kortix_version: 2, default_agent: 'support', agents },
});

const blockOf = (result: { ok: boolean; raw?: Record<string, unknown> }, name = 'support') =>
  (result as { raw: Record<string, unknown> }).raw.agents as Record<
    string,
    Record<string, unknown>
  >;

describe('applyAgentScopeV2 — connectors_personal', () => {
  test('writes a personal subset alongside the grant', () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: ['gmail', 'slack'] } }), 'support', {
      connectors: ['gmail', 'slack'],
      connectorsPersonal: ['gmail'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_personal).toEqual(['gmail']);
  });

  test('an empty list CLEARS the field rather than writing []', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], connectors_personal: ['gmail'] } }),
      'support',
      { connectorsPersonal: [] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support).not.toHaveProperty('connectors_personal');
  });

  test('narrowing the grant PRUNES a personal entry that just lost it', () => {
    // The user removes `slack` from the grant in an edit that doesn't mention
    // connectors_personal. Writing the old personal list unchanged would leave
    // `slack` personal-but-ungranted — a manifest the parser refuses.
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail', 'slack'], connectors_personal: ['gmail', 'slack'] } }),
      'support',
      { connectors: ['gmail'] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_personal).toEqual(['gmail']);
  });

  test('clearing the grant entirely also clears the personal list', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], connectors_personal: ['gmail'] } }),
      'support',
      { connectors: [] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support).not.toHaveProperty('connectors');
    expect(blockOf(res).support).not.toHaveProperty('connectors_personal');
  });

  test("a grant of 'all' keeps every personal entry (everything is granted)", () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: 'all' } }), 'support', {
      connectors: 'all',
      connectorsPersonal: ['gmail', 'slack'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_personal).toEqual(['gmail', 'slack']);
  });

  test('dedupes a repeated personal entry', () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: ['gmail'] } }), 'support', {
      connectors: ['gmail'],
      connectorsPersonal: ['gmail', 'gmail'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_personal).toEqual(['gmail']);
  });

  test('leaves other governance keys on the block untouched', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], secrets: 'all', kortix_cli: ['project.read'] } }),
      'support',
      { connectorsPersonal: ['gmail'] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.secrets).toBe('all');
    expect(blockOf(res).support.kortix_cli).toEqual(['project.read']);
  });
});
