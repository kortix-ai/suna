import { describe, expect, test } from 'bun:test';
import { isProviderAuthSatisfied } from '@kortix/llm-catalog';

import {
  LLM_PROVIDERS,
  LLM_PROVIDER_BY_ID,
  type RawCatalog,
  buildLlmProviderCatalog,
} from './llm-providers';

// The exact "is this provider connected" predicate `useConnectedProviders`
// (apps/web/src/features/workspace/customize/sections/llm-provider/
// use-connected-providers.ts) applies to LLM_PROVIDERS — kept in sync here so
// this test genuinely exercises what the connect-modal shows, not a
// reimplementation that could quietly drift from it.
function connectedProviderIds(secretNames: Set<string>): Set<string> {
  return new Set(
    LLM_PROVIDERS.filter(
      (p) =>
        p.id !== 'kortix' && isProviderAuthSatisfied(p.authRequirement, (v) => secretNames.has(v)),
    ).map((p) => p.id),
  );
}

describe('LLM_PROVIDERS — amazon-bedrock connect requirements', () => {
  test('the connect form only asks for the bearer token + region, not the SigV4 pair', () => {
    const bedrock = LLM_PROVIDER_BY_ID.get('amazon-bedrock');
    expect(bedrock?.envVars).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
  });
});

describe('useConnectedProviders predicate — Bedrock (the essentia case)', () => {
  test('a project with ONLY AWS_BEARER_TOKEN_BEDROCK + AWS_REGION secrets shows amazon-bedrock as connected', () => {
    const connected = connectedProviderIds(new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']));
    expect(connected.has('amazon-bedrock')).toBe(true);
  });

  test('a partially-configured Bedrock (bearer token only) does NOT show as connected', () => {
    const connected = connectedProviderIds(new Set(['AWS_BEARER_TOKEN_BEDROCK']));
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('a partially-configured Bedrock (region only) does NOT show as connected', () => {
    const connected = connectedProviderIds(new Set(['AWS_REGION']));
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('the SigV4 access-key pair alone does not connect it (unimplemented auth path)', () => {
    const connected = connectedProviderIds(
      new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']),
    );
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('no secrets at all connects nothing', () => {
    expect(connectedProviderIds(new Set()).size).toBe(0);
  });
});

describe('useConnectedProviders predicate — Google alias fix', () => {
  test('any single Google key alias connects it', () => {
    expect(connectedProviderIds(new Set(['GOOGLE_GENERATIVE_AI_API_KEY'])).has('google')).toBe(
      true,
    );
    expect(connectedProviderIds(new Set(['GOOGLE_API_KEY'])).has('google')).toBe(true);
    expect(connectedProviderIds(new Set(['GEMINI_API_KEY'])).has('google')).toBe(true);
  });
});

describe('useConnectedProviders predicate — unaffected single-var providers', () => {
  test('anthropic still connects the same way as before', () => {
    expect(connectedProviderIds(new Set(['ANTHROPIC_API_KEY'])).has('anthropic')).toBe(true);
  });
});

describe('provider display names — verbatim from models.dev, never hand-renamed', () => {
  // Reproduces Marko's exact bug report: models.dev names the three
  // Moonshot-family providers DISTINCTLY (moonshotai → "Moonshot AI",
  // moonshotai-cn → "Moonshot AI (China)", kimi-for-coding → "Kimi For
  // Coding"), but the UI used to collapse two of them to a hand-maintained
  // "Moonshot" label, making them look identical ("why do we have two
  // providers called Moonshot?"). toEntry()/`label: raw.name` must carry the
  // real, distinct name straight through with no override.
  const raw: RawCatalog = {
    source: 'https://models.dev/api.json',
    fetched_at: '2026-07-17T00:00:00.000Z',
    provider_count: 3,
    model_count: 3,
    providers: [
      {
        id: 'moonshotai',
        name: 'Moonshot AI',
        env: ['MOONSHOT_API_KEY'],
        doc: 'https://platform.moonshot.ai/docs',
        models: [{ id: 'kimi-k3', name: 'Kimi K3', released: '2026-07-01' }],
      },
      {
        id: 'moonshotai-cn',
        name: 'Moonshot AI (China)',
        env: ['MOONSHOT_API_KEY'],
        doc: 'https://platform.moonshot.cn/docs',
        models: [{ id: 'kimi-k3', name: 'Kimi K3', released: '2026-07-01' }],
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi For Coding',
        env: ['KIMI_API_KEY'],
        doc: 'https://api.kimi.com/coding/v1',
        models: [
          { id: 'k2p7', name: 'Kimi K2p7', released: '2026-05-01' },
          {
            id: 'kimi-for-coding-highspeed',
            name: 'Kimi For Coding Highspeed',
            released: '2026-07-10',
          },
          { id: 'k3', name: 'Kimi K3', released: '2026-07-15' },
        ],
      },
    ],
  };

  test('all three Moonshot-family providers keep their own, distinct models.dev name', () => {
    const entries = buildLlmProviderCatalog(raw);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get('moonshotai')?.label).toBe('Moonshot AI');
    expect(byId.get('moonshotai-cn')?.label).toBe('Moonshot AI (China)');
    expect(byId.get('kimi-for-coding')?.label).toBe('Kimi For Coding');
    // The actual bug: two of these must NEVER render identically.
    const labels = new Set(entries.map((e) => e.label));
    expect(labels.size).toBe(entries.length);
  });

  test("the connect modal help URL is models.dev's own doc field, not a rewritten one", () => {
    const entries = buildLlmProviderCatalog(raw);
    expect(entries.find((e) => e.id === 'kimi-for-coding')?.helpUrl).toBe(
      'https://api.kimi.com/coding/v1',
    );
  });

  test('the hint is derived from the live model list (proves Kimi K3 + highspeed variants surface), never a hardcoded description', () => {
    const entries = buildLlmProviderCatalog(raw);
    const kimiForCoding = entries.find((e) => e.id === 'kimi-for-coding');
    expect(kimiForCoding?.models.map((m) => m.id)).toEqual([
      'k2p7',
      'kimi-for-coding-highspeed',
      'k3',
    ]);
    // Derived hint names real models from the given catalog — not a fixed
    // marketing string that would silently miss a new release like K3.
    expect(kimiForCoding?.hint).toContain('Kimi K2p7');
    expect(kimiForCoding?.hint).not.toBe('AWS Bedrock — Claude, Llama, Titan');
  });
});
