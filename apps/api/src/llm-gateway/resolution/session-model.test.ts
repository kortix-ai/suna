import { describe, expect, test } from 'bun:test';
import { resolveSessionManagedModel } from './session-model';
import type { ManagedModel } from '../models/managed-models';

function served(...ids: string[]): ManagedModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    upstreamModelId: `vendor/${id}`,
    transport: 'openrouter',
    pricingRef: `openrouter/vendor/${id}`,
    tier: 'balanced',
    vision: true,
    limit: { context: 200_000, output: 32_000 },
    openrouterProvider: { only: ['x'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
  })) as unknown as ManagedModel[];
}

describe('resolveSessionManagedModel', () => {
  test('a BYOK/codex ref (not a managed id at all) is kept', () => {
    expect(resolveSessionManagedModel('anthropic/claude-sonnet-4-6', served('kimi-k3'), null)).toEqual({
      kind: 'kept',
    });
  });

  test('a managed id still in the runtime lineup is kept', () => {
    expect(resolveSessionManagedModel('kimi-k3', served('kimi-k3', 'glm-5.3-flash'), null)).toEqual({
      kind: 'kept',
    });
  });

  // The evidence case: `deepseek-v4-flash-0731` is retired, but the catalog
  // declares `deepseek-v4.1-flash` as its successor (managed-models.ts
  // LEGACY_MANAGED_IDS) — and that successor IS in the runtime lineup here.
  test('a retired id with a servable declared successor re-points to it', () => {
    expect(
      resolveSessionManagedModel('deepseek-v4-flash-0731', served('deepseek-v4.1-flash', 'kimi-k3'), null),
    ).toEqual({ kind: 'repoint', to: 'deepseek-v4.1-flash', reason: 'successor' });
  });

  // The other evidence case: `grok-4.6` is retired with NO declared successor
  // at all — the project's current default is the only fallback.
  test('a retired id with no declared successor falls back to the project default', () => {
    expect(resolveSessionManagedModel('grok-4.6', served('kimi-k3'), 'kimi-k3')).toEqual({
      kind: 'repoint',
      to: 'kimi-k3',
      reason: 'project_default',
    });
  });

  test('a retired id whose declared successor is ITSELF not servable here falls back to the project default', () => {
    // deepseek-v4-flash-0731's declared successor is deepseek-v4.1-flash, but
    // this deployment's lineup does not serve it (e.g. no credential) — must
    // not hand a session a second dead pin, must fall through to the default.
    expect(
      resolveSessionManagedModel('deepseek-v4-flash-0731', served('glm-5.3-flash'), 'glm-5.3-flash'),
    ).toEqual({ kind: 'repoint', to: 'glm-5.3-flash', reason: 'project_default' });
  });

  test('a retired id with no successor and no project default is kept — the turn error names the real cause', () => {
    expect(resolveSessionManagedModel('grok-4.6', served('kimi-k3'), null)).toEqual({ kind: 'kept' });
  });

  test('never re-points a retired id onto itself as a "project default"', () => {
    expect(resolveSessionManagedModel('grok-4.6', served('kimi-k3'), 'grok-4.6')).toEqual({ kind: 'kept' });
  });
});
