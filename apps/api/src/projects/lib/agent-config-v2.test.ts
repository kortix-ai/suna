import { describe, expect, test } from 'bun:test';
import { applyAgentScopeV2 } from './agent-config-v2';

const manifest = (agents: Record<string, unknown>) => ({
  schemaVersion: 2,
  format: 'yaml' as const,
  path: 'kortix.yaml',
  raw: { kortix_version: 2, default_agent: 'support', agents },
});

const manifestV3 = (agents: Record<string, unknown>) => ({
  schemaVersion: 3,
  format: 'yaml' as const,
  path: 'kortix.yaml',
  raw: {
    kortix_version: 3,
    default_agent: 'support',
    runtimes: {
      opencode: {
        harness: 'opencode',
        config_dir: '.kortix/opencode',
      },
    },
    agents,
  },
});

const blockOf = (result: { ok: boolean; raw?: Record<string, unknown> }, name = 'support') =>
  (result as { raw: Record<string, unknown> }).raw.agents as Record<
    string,
    Record<string, unknown>
  >;

describe('applyAgentScopeV2 — connectors_required', () => {
  test('writes a required subset alongside the grant', () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: ['gmail', 'slack'] } }), 'support', {
      connectors: ['gmail', 'slack'],
      connectorsRequired: ['gmail'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_required).toEqual(['gmail']);
    expect(blockOf(res).support).not.toHaveProperty('connectors_personal');
  });

  test('an empty list CLEARS the field rather than writing []', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], connectors_required: ['gmail'] } }),
      'support',
      { connectorsRequired: [] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support).not.toHaveProperty('connectors_required');
  });

  test('narrowing the grant PRUNES a required entry that just lost it', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail', 'slack'], connectors_required: ['gmail', 'slack'] } }),
      'support',
      { connectors: ['gmail'] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_required).toEqual(['gmail']);
  });

  test('clearing the grant entirely also clears the required list', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], connectors_required: ['gmail'] } }),
      'support',
      { connectors: [] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support).not.toHaveProperty('connectors');
    expect(blockOf(res).support).not.toHaveProperty('connectors_required');
  });

  test("a grant of 'all' keeps every required entry", () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: 'all' } }), 'support', {
      connectors: 'all',
      connectorsRequired: ['gmail', 'slack'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_required).toEqual(['gmail', 'slack']);
  });

  test('dedupes a repeated required entry', () => {
    const res = applyAgentScopeV2(manifest({ support: { connectors: ['gmail'] } }), 'support', {
      connectors: ['gmail'],
      connectorsRequired: ['gmail', 'gmail'],
    });
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_required).toEqual(['gmail']);
  });

  test('imports the deprecated alias and serializes only the canonical field', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], connectors_personal: ['gmail'] } }),
      'support',
      {},
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.connectors_required).toEqual(['gmail']);
    expect(blockOf(res).support).not.toHaveProperty('connectors_personal');
  });

  test('leaves other governance keys on the block untouched', () => {
    const res = applyAgentScopeV2(
      manifest({ support: { connectors: ['gmail'], secrets: 'all', kortix_cli: ['project.read'] } }),
      'support',
      { connectorsRequired: ['gmail'] },
    );
    expect(res.ok).toBe(true);
    expect(blockOf(res).support.secrets).toBe('all');
    expect(blockOf(res).support.kortix_cli).toEqual(['project.read']);
  });

  test('updates a version-3 logical agent without removing its runtime identity', () => {
    const res = applyAgentScopeV2(
      manifestV3({
        support: {
          runtime: 'opencode',
          agent: 'kortix',
          connectors: 'all',
          secrets: 'all',
        },
      }),
      'support',
      {
        connectors: ['gmail'],
        connectorsRequired: ['gmail'],
      },
    );

    expect(res.ok).toBe(true);
    expect(blockOf(res).support).toMatchObject({
      runtime: 'opencode',
      agent: 'kortix',
      connectors: ['gmail'],
      connectors_required: ['gmail'],
      secrets: 'all',
    });
  });
});
