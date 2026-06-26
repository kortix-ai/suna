import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS } from '@kortix/shared/llm-catalog';

// catalog-models now imports the real ../../config to gate managed models on
// their transport key (OpenRouter/Bedrock). The real config calls process.exit(1)
// on an incomplete env (e.g. under `bun test`, where .env is dotenvx-encrypted),
// so mock it with BOTH managed keys SET — matching production with keys present,
// where the full managed lineup (Bedrock + OpenRouter + the synthetic `auto`)
// is advertised.
mock.module('../../config', () => ({
  config: { OPENROUTER_API_KEY: 'test-openrouter', AWS_BEDROCK_API_KEY: 'test-bedrock' },
}));

const { gatewayModelCatalog } = await import('./catalog-models');

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
describe('gatewayModelCatalog — served catalog', () => {
  const full = gatewayModelCatalog('proj');

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('AUTO + managed lineup present; anonymous callers get managed-only', () => {
    expect(full.auto).toBeDefined();
    expect(full['claude-opus-4.8']).toBeDefined();

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeDefined();
    // anonymous = managed-only; with a project, BYOK + codex widen the catalog
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(managedOnly).length);
  });

  test('OpenCode Zen free models are managed, not leaked as native opencode catalog entries', () => {
    for (const id of DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS) {
      expect(full[id], id).toBeDefined();
      expect(full[id]?.free, id).toBe(true);
      expect(full[`opencode/${id}`], `opencode/${id}`).toBeUndefined();
    }
    expect(full['big-pickle']).toBeUndefined();
    expect(full['opencode/big-pickle']).toBeUndefined();
  });

  test('BYOK catalog entries preserve models.dev metadata for picker visibility', () => {
    const anthropic = full['anthropic/claude-opus-4-8'];
    expect(anthropic).toBeDefined();
    expect(anthropic?.name).toBe('Claude Opus 4.8');
    expect(anthropic?.released).toBeDefined();
    expect(anthropic?.release_date).toBe(anthropic?.released);
  });

  test('catalog is a memoized singleton (built once, not per call)', () => {
    expect(gatewayModelCatalog('proj')).toBe(full);
  });

  test('google (Gemini / Vertex) is dropped from the served catalog', () => {
    const googleKeys = Object.keys(full).filter(
      (id) => id.startsWith('google/') || id.startsWith('google-vertex/'),
    );
    expect(googleKeys).toEqual([]);
  });
});
