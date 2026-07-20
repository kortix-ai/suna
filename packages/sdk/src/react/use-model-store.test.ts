import { describe, expect, test } from 'bun:test';

import type { FlatModel } from './model-flatten';
import { getRuntimeModel, hasUsableModel, setRuntimeModel } from './use-model-store';

describe('runtime model store — per-agent harness-native model', () => {
  test('round-trips a model id keyed by agent name', () => {
    setRuntimeModel('claude-reviewer', 'claude-opus-4-8');
    expect(getRuntimeModel('claude-reviewer')).toBe('claude-opus-4-8');
  });

  test('keys two agents on the same harness independently', () => {
    setRuntimeModel('claude-reviewer', 'claude-opus-4-8');
    setRuntimeModel('claude-builder', 'claude-sonnet-4-6');
    expect(getRuntimeModel('claude-reviewer')).toBe('claude-opus-4-8');
    expect(getRuntimeModel('claude-builder')).toBe('claude-sonnet-4-6');
  });

  test('clearing to undefined drops the entry (falls back to harness default)', () => {
    setRuntimeModel('codex-agent', 'gpt-5.4');
    expect(getRuntimeModel('codex-agent')).toBe('gpt-5.4');
    setRuntimeModel('codex-agent', undefined);
    expect(getRuntimeModel('codex-agent')).toBeUndefined();
  });

  test('an agent with no stored pick reads as undefined (harness default)', () => {
    expect(getRuntimeModel('never-touched-agent')).toBeUndefined();
  });
});

// Regression coverage for connection-gating (`hasUsableModel`/`isVisible`)
// preferring the explicit `provider` field the gateway now serves per model
// over parsing it out of the wire model id — see `subProviderOf` in
// use-model-store.ts. Every model under the gateway is registered under
// `providerID: 'kortix'`; `provider` is the field that says who REALLY
// serves it.
function gatewayModel(partial: Partial<FlatModel> & Pick<FlatModel, 'modelID'>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelName: partial.modelID,
    ...partial,
  };
}

describe('hasUsableModel — gateway connection gating prefers the explicit `provider` field', () => {
  test('a BYOK model is usable when its explicit `provider` is connected, even with an ambiguous modelID', () => {
    // Two embedded slashes — a naive `indexOf('/')` split still happens to
    // work here, but the explicit field is what should actually be read.
    const models = [gatewayModel({ modelID: 'mixlayer/qwen/qwen3.5-9b', provider: 'mixlayer' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['mixlayer']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['qwen']) })).toBe(false);
  });

  test('falls back to string-splitting modelID when `provider` is absent (stale/older catalog)', () => {
    const models = [gatewayModel({ modelID: 'anthropic/claude-opus-4-8' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set() })).toBe(false);
  });

  test('the explicit `provider` field wins even when it disagrees with a naive modelID split', () => {
    // A models.dev provider alias/namespace prefix ("anthropic-legacy") that
    // does not match the real connect-form provider id ("anthropic") — this
    // is exactly the class of drift string-splitting can never handle but an
    // explicit field sidesteps entirely.
    const models = [gatewayModel({ modelID: 'anthropic-legacy/claude-2', provider: 'anthropic' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic-legacy']) })).toBe(false);
  });

  test('a codex/<id> model gates on the codex subscription, not the raw openai BYOK key', () => {
    const models = [gatewayModel({ modelID: 'codex/gpt-5.6-sol', provider: 'codex' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['openai']) })).toBe(false);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['codex']) })).toBe(true);
  });

  test('a managed model is usable iff the caller is not free-tier, regardless of `provider`', () => {
    const models = [gatewayModel({ modelID: 'claude-opus-4.8', provider: 'kortix' })];
    expect(hasUsableModel(models, { freeTier: true })).toBe(false);
    expect(hasUsableModel(models, { freeTier: false })).toBe(true);
  });
});
