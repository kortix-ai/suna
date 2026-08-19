/**
 * `KORTIX_LLM_CONNECTED_PROVIDERS` — the list the API tells every sandbox.
 *
 * The sandbox uses it to bound its model reconcile to the set the picker can
 * actually offer (`managed ∪ connected-provider models`). If this list ever
 * disagreed with `projectPickerCatalog`, one of two failures follows:
 *   - too NARROW → the picker offers a model the sandbox never registers, and
 *     the turn dies with `ModelNotFound: kortix/<id>` (prod, 2026-08-19);
 *   - too WIDE  → the sandbox diffs providers nobody can pick, and since
 *     models.dev adds ~60 models a day it finds something missing on every
 *     boot and restarts OpenCode every time.
 *
 * So this test pins the two against each other, not just against themselves.
 */
import { describe, expect, test } from 'bun:test';
import { connectedProviderIds, projectPickerCatalog } from './picker-catalog';
import { gatewayModelCatalog } from './catalog-models';
import { CONNECTED_PROVIDERS_ENV_NAME } from './connected-providers';

describe('connectedProviderIds', () => {
  test('a connected provider is named by its CATALOG id, not its env var', () => {
    expect(connectedProviderIds(new Set(['ANTHROPIC_API_KEY']))).toContain('anthropic');
  });

  test('no secrets ⇒ no providers (managed-only project)', () => {
    expect(connectedProviderIds(new Set())).toEqual([]);
  });

  test('an unrelated secret connects nothing', () => {
    expect(connectedProviderIds(new Set(['STRIPE_SECRET_KEY', 'DATABASE_URL']))).toEqual([]);
  });

  test('a ChatGPT subscription connects `codex`, which has no catalog env var', () => {
    expect(connectedProviderIds(new Set(['CODEX_AUTH_JSON']))).toEqual(['codex']);
    expect(connectedProviderIds(new Set(['OPENCODE_AUTH_JSON']))).toEqual(['codex']);
  });

  test('several providers come back sorted and deduplicated', () => {
    const ids = connectedProviderIds(new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_AUTH_JSON']));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('codex');
  });
});

describe('the list AGREES with the picker it is derived from', () => {
  test('every BYOK model the picker keeps belongs to a listed provider', () => {
    const connectedEnvVars = new Set(['ANTHROPIC_API_KEY', 'CODEX_AUTH_JSON']);
    const listed = new Set(connectedProviderIds(connectedEnvVars));
    const picker = projectPickerCatalog(
      gatewayModelCatalog('project-1'),
      connectedEnvVars,
      [],
    );

    const byokProviders = new Set(
      Object.keys(picker)
        .filter((id) => id.includes('/'))
        .map((id) => id.slice(0, id.indexOf('/'))),
    );
    // Not one BYOK model in the picker comes from a provider the sandbox was
    // not told about — the "too narrow" failure.
    for (const provider of byokProviders) expect(listed.has(provider)).toBe(true);
    // And nothing was listed that contributes no model — the "too wide" failure.
    for (const provider of listed) expect(byokProviders.has(provider)).toBe(true);
  });

  test('an unconnected provider is neither listed nor in the picker', () => {
    const connectedEnvVars = new Set(['ANTHROPIC_API_KEY']);
    expect(connectedProviderIds(connectedEnvVars)).not.toContain('openai');
    const picker = projectPickerCatalog(gatewayModelCatalog('project-1'), connectedEnvVars, []);
    expect(Object.keys(picker).some((id) => id.startsWith('openai/'))).toBe(false);
  });
});

describe('the env name', () => {
  test('matches the name the daemon reads', () => {
    // The daemon's own constant is asserted against this literal in
    // apps/kortix-sandbox-agent-server/src/__tests__/runtime-env-allowlist-completeness.test.ts.
    expect(CONNECTED_PROVIDERS_ENV_NAME).toBe('KORTIX_LLM_CONNECTED_PROVIDERS');
  });
});
