import { describe, expect, test } from 'bun:test';
import { applyAgentScopeV2, grantSecretToAgentV2 } from './agent-config-v2';

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
});

// `revision` is what tells the helper the manifest exists on disk; a committed
// manifest always carries a blob SHA (readManifest → readManifestFromRepo).
const committed = (agents?: Record<string, unknown>) => ({
  schemaVersion: 2,
  format: 'yaml' as const,
  path: 'kortix.yaml',
  revision: 'a'.repeat(40),
  raw: {
    kortix_version: 2,
    default_agent: 'support',
    ...(agents === undefined ? {} : { agents }),
  },
});

describe('grantSecretToAgentV2', () => {
  test('appends to an existing list and preserves every other governance field', () => {
    const res = grantSecretToAgentV2(
      committed({ support: { secrets: ['ALPHA'], connectors: ['gmail'], skills: 'all' } }),
      'support',
      'BETA',
    );
    expect(res).toMatchObject({ ok: true, alreadyGranted: false, adoptedGovernance: false });
    if (!res.ok) return;
    const support = (res.raw.agents as Record<string, any>).support;
    expect(support.secrets).toEqual(['ALPHA', 'BETA']);
    expect(support.connectors).toEqual(['gmail']);
    expect(support.skills).toBe('all');
  });

  test('an already-admitting list returns the ORIGINAL raw, so no commit rewrites the file', () => {
    const source = committed({ support: { secrets: ['alpha'] } });
    const res = grantSecretToAgentV2(source, 'support', 'ALPHA');
    expect(res).toMatchObject({ ok: true, alreadyGranted: true, adoptedGovernance: false });
    if (!res.ok) return;
    expect(res.raw).toBe(source.raw);
  });

  test('an omitted `secrets` key becomes an explicit single-entry list', () => {
    const res = grantSecretToAgentV2(committed({ support: { connectors: 'all' } }), 'support', 'ALPHA');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const support = (res.raw.agents as Record<string, any>).support;
    expect(support.secrets).toEqual(['ALPHA']);
    expect(support.connectors).toBe('all');
  });

  test('`secrets: all` expands to what it currently means, never to the one identifier', () => {
    const res = grantSecretToAgentV2(committed({ support: { secrets: 'all' } }), 'support', 'BETA', [
      'ALPHA',
      'BETA',
      'GAMMA',
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.raw.agents as Record<string, any>).support.secrets).toEqual([
      'ALPHA',
      'GAMMA',
      'BETA',
    ]);
  });

  test('an absent `agents:` map adopts governance and creates the entry', () => {
    const res = grantSecretToAgentV2(committed(), 'support', 'ALPHA');
    expect(res).toMatchObject({ ok: true, alreadyGranted: false, adoptedGovernance: true });
    if (!res.ok) return;
    expect(res.raw.agents).toEqual({ support: { secrets: ['ALPHA'] } });
  });

  test('a v1 manifest is refused with the upgrade flag, not a throw', () => {
    const res = grantSecretToAgentV2(
      { schemaVersion: 1, format: 'toml', path: 'kortix.toml', revision: 'b', raw: {} },
      'support',
      'ALPHA',
    );
    expect(res).toMatchObject({ ok: false, unsupportedV1: true });
  });

  test('a malformed `agents:` value is refused instead of overwritten', () => {
    const res = grantSecretToAgentV2(
      { ...committed(), raw: { kortix_version: 2, agents: [{ name: 'support' }] } },
      'support',
      'ALPHA',
    );
    expect(res.ok).toBe(false);
  });
});
