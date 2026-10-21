import { describe, expect, test } from 'bun:test';

import { PLATINUM_MODELS_RESPONSE, TEST_MANAGED_LINEUP } from '../../__tests__/fixtures/managed-lineup';
import {
  canonicalManagedModelId,
  getRuntimeManagedModel,
  isKnownManagedModelId,
  isRetiredManagedModelId,
  LEGACY_MANAGED_IDS,
  loadManagedLineup,
  managedLineup,
  managedModelsFromPlatinum,
  type ManagedModel,
  resolveLegacyIdChain,
  resolvePlatformDefaultModelId,
  retiredManagedModelReplacement,
  __setManagedLineupForTest,
} from './managed-models';

const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('the managed lineup is what Platinum Inference lists', () => {
  test('maps Platinum /models to the lineup, in Platinum order', () => {
    expect(managedModelsFromPlatinum(PLATINUM_MODELS_RESPONSE)).toEqual(TEST_MANAGED_LINEUP);
  });

  test('skips entries Platinum does not own or did not price', () => {
    const [model] = PLATINUM_MODELS_RESPONSE.data;
    expect(managedModelsFromPlatinum({ data: [
      { ...model, owned_by: 'tabby' },
      { ...model, id: 'unpriced', pricing: undefined },
      { ...model, id: 'text-only', modalities: { input: ['text'], output: ['text'] }, reasoning_efforts: [] },
    ] })).toEqual([{ ...TEST_MANAGED_LINEUP[0]!, id: 'text-only', vision: false, reasoningOptions: undefined }].map(
      ({ reasoningOptions: _, ...m }) => m,
    ));
  });

  test('a model Platinum adds is served the next load, with no code change', async () => {
    const added = { ...PLATINUM_MODELS_RESPONSE.data[1]!, id: 'qwen-x', name: 'Qwen X', pricing: { input: 0.2, output: 0.8 } };
    expect(await loadManagedLineup(answer({ data: [...PLATINUM_MODELS_RESPONSE.data, added] }))).toBe(true);
    expect(managedLineup().map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen-x']);
    expect(getRuntimeManagedModel('qwen-x')?.pricing).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.8 });
    expect(isKnownManagedModelId('qwen-x')).toBe(true);
  });

  test('a failed load keeps the last good lineup', async () => {
    __setManagedLineupForTest(TEST_MANAGED_LINEUP);
    expect(await loadManagedLineup(answer({ error: 'down' }, 503))).toBe(false);
    expect(await loadManagedLineup(async () => { throw new Error('network'); })).toBe(false);
    expect(await loadManagedLineup(answer({ object: 'list' }))).toBe(false);
    expect(managedLineup()).toEqual(TEST_MANAGED_LINEUP);
  });

  test('sends the Platinum key to {PLATINUM_INFERENCE_URL}/models', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    await loadManagedLineup(async (url, init) => {
      seen = { url, auth: new Headers(init?.headers).get('authorization') };
      return new Response(JSON.stringify(PLATINUM_MODELS_RESPONSE));
    });
    expect(seen!.url.endsWith('/models')).toBe(true);
    expect(seen!.auth).toMatch(/^Bearer \S+/);
  });
});

const managed = (id: string): ManagedModel => ({
  id,
  name: id,
  pricing: { inputPerMillion: 1, outputPerMillion: 1 },
  vision: false,
  limit: { context: 1_000, output: 1_000 },
});

describe('resolvePlatformDefaultModelId — the platform default must always be reachable', () => {
  const lineup = [managed('kimi-k3'), managed('morph-dsv4flash')];

  test('keeps the configured default when it is actually served', () => {
    const served = [managed('morph-glm53-744b'), ...lineup];
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', served)).toBe('morph-glm53-744b');
  });

  test('maps an old Morph default to the equivalent served model', () => {
    expect(resolvePlatformDefaultModelId('morph-kimik3', lineup)).toBe('kimi-k3');
    const deepseek = managed('deepseek-v4.1-flash');
    expect(resolvePlatformDefaultModelId('kortix/morph-dsv41flash', [deepseek])).toBe('deepseek-v4.1-flash');
  });

  test('falls back to the first served model (Platinum order) when the configured default is unreachable', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', lineup)).toBe('kimi-k3');
  });

  test('accepts and preserves the opencode `kortix/<id>` ref form', () => {
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', lineup)).toBe('kimi-k3');
    const served = [managed('morph-glm53-744b'), ...lineup];
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', served)).toBe('kortix/morph-glm53-744b');
  });

  test('an empty configured default takes the first served model', () => {
    expect(resolvePlatformDefaultModelId('', lineup)).toBe('kimi-k3');
  });

  test('leaves a BYOK default untouched — it resolves from a project key, not a managed transport', () => {
    expect(resolvePlatformDefaultModelId('anthropic/claude-opus-4-8', lineup)).toBe(
      'anthropic/claude-opus-4-8',
    );
  });

  test('leaves the configured default unchanged when nothing managed is served at all', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', [])).toBe('morph-glm53-744b');
    expect(resolvePlatformDefaultModelId('', [])).toBe('');
  });
});

describe('isRetiredManagedModelId', () => {
  test('the two ids from the 2026-09-28 sweep are retired', () => {
    expect(isRetiredManagedModelId('deepseek-v4-flash-0731')).toBe(true);
    expect(isRetiredManagedModelId('grok-4.6')).toBe(true);
  });

  test('a current lineup id is not retired', () => {
    expect(isRetiredManagedModelId('deepseek-v4.1-flash')).toBe(false);
    expect(isRetiredManagedModelId('glm-5.3-flash')).toBe(false);
    // Kimi K3 left the lineup on 2026-10-19.
    expect(isRetiredManagedModelId('kimi-k3')).toBe(true);
  });

  test('an id this catalog has never heard of is not retired — it is simply unknown', () => {
    expect(isRetiredManagedModelId('not-a-real-model')).toBe(false);
  });
});

describe('deepseek-v4-flash-0731 declares deepseek-v4.1-flash as its successor', () => {
  test('canonicalManagedModelId resolves it', () => {
    expect(canonicalManagedModelId('deepseek-v4-flash-0731')).toBe('deepseek-v4.1-flash');
  });

  // deepseek-v4-flash-0731 is ITSELF the one-hop target of two older aliases —
  // a single lookup would leave morph-dsv4flash/deepseek-v4-flash pointing at
  // a now-also-retired id. canonicalManagedModelId must follow the full chain.
  test('a two-hop alias (morph-dsv4flash / deepseek-v4-flash) resolves through it, not to it', () => {
    expect(canonicalManagedModelId('morph-dsv4flash')).toBe('deepseek-v4.1-flash');
    expect(canonicalManagedModelId('deepseek-v4-flash')).toBe('deepseek-v4.1-flash');
  });
});

// The guard against this exact class of bug recurring: someone retires a
// model that is itself the declared successor of an older alias, and does not
// revisit that alias. Every entry in the map must resolve — however many hops
// it takes — to something that is NOT ALSO retired.
describe('every LEGACY_MANAGED_IDS chain resolves off of a retired id', () => {
  for (const alias of Object.keys(LEGACY_MANAGED_IDS)) {
    test(`"${alias}" -> ... -> a non-retired id`, () => {
      const resolved = canonicalManagedModelId(alias);
      expect(isRetiredManagedModelId(resolved)).toBe(false);
      // Idempotent: a true fixed point, not an intermediate hop left behind
      // by the bound or a cycle guard.
      expect(canonicalManagedModelId(resolved)).toBe(resolved);
    });
  }
});

describe('resolveLegacyIdChain is bounded and cycle-safe (synthetic tables — the real map is never mutated)', () => {
  test('a direct cycle stops instead of looping forever', () => {
    const cyclic = { a: 'b', b: 'a' };
    // Enters the cycle at 'a' -> 'b' -> 'a' (seen) -> stops at 'b'.
    expect(resolveLegacyIdChain('a', cyclic)).toBe('b');
  });

  test('a self-referencing entry stops immediately', () => {
    expect(resolveLegacyIdChain('a', { a: 'a' })).toBe('a');
  });

  test('a chain longer than the hop bound stops rather than hanging', () => {
    const long: Record<string, string> = {};
    for (let i = 0; i < 20; i++) long[`chain-${i}`] = `chain-${i + 1}`;
    const resolved = resolveLegacyIdChain('chain-0', long, 8);
    expect(resolved).not.toBe('chain-20'); // never reaches the true (unbounded) end
    expect(resolved.startsWith('chain-')).toBe(true); // stopped mid-chain, not a wrong answer
  });

  test('a chain within the bound fully resolves', () => {
    const short = { a: 'b', b: 'c', c: 'd' };
    expect(resolveLegacyIdChain('a', short, 8)).toBe('d');
  });
});

describe('retiredManagedModelReplacement', () => {
  const lineup = [managed('deepseek-v4.1-flash'), managed('kimi-k3')];

  test('names the declared successor when it is actually served', () => {
    expect(retiredManagedModelReplacement('deepseek-v4-flash-0731', lineup)).toBe('deepseek-v4.1-flash');
  });

  test('returns null when the declared successor is not itself served here', () => {
    expect(retiredManagedModelReplacement('deepseek-v4-flash-0731', [managed('kimi-k3')])).toBeNull();
  });

  test('returns null when there is no declared successor at all', () => {
    expect(retiredManagedModelReplacement('grok-4.6', lineup)).toBeNull();
  });

  test('returns null for an id that was never retired', () => {
    expect(retiredManagedModelReplacement('glm-5.3-flash', lineup)).toBeNull();
  });
});
