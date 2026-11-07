import { describe, expect, test } from 'bun:test';

import { type LlmProviderEntry, buildLlmProviderCatalog } from '@kortix/sdk';

import {
  accessLine,
  formatTokens,
  managedProviderEntry,
  providerMeta,
  providerRows,
  providerSheetKind,
} from './providers-model.ts';

const CATALOGUE: LlmProviderEntry[] = buildLlmProviderCatalog({
  providers: [
    { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: [{ id: 'c', name: 'Claude' }] },
    { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: [{ id: 'g', name: 'GPT' }, { id: 'h', name: 'GPT 2' }] },
    { id: 'google', name: 'Google', env: ['GEMINI_API_KEY'], models: [] },
    { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'], models: [{ id: 'l', name: 'Llama' }] },
    { id: 'zeta', name: 'Zeta', env: ['ZETA_A', 'ZETA_B'], api: 'https://api.zeta.test/v1', models: [] },
  ],
});

const rows = (input: Partial<Parameters<typeof providerRows>[0]> = {}) =>
  providerRows({
    catalogue: CATALOGUE,
    managed: managedProviderEntry({ 'kimi-k3': { name: 'Kimi K3' }, 'openai/gpt': { name: 'x' } }),
    connectedIds: new Set(),
    pooledIds: new Set(),
    disabledProviders: new Set(),
    search: '',
    ...input,
  });

describe('providerRows — the web list, in the web order', () => {
  test('Kortix is in use with its own models; everything else is available, first-class first', () => {
    const { inUse, available } = rows();
    expect(inUse.map((row) => row.id)).toEqual(['kortix']);
    expect(inUse[0]!.modelCount).toBe(1);
    expect(available.map((row) => row.id)).toEqual(['anthropic', 'openai', 'google', 'groq', 'zeta']);
  });

  test('a saved key moves a provider to In use without changing the order around it', () => {
    const { inUse, available } = rows({ connectedIds: new Set(['groq']) });
    expect(inUse.map((row) => row.id)).toEqual(['kortix', 'groq']);
    expect(available.map((row) => row.id)).toEqual(['anthropic', 'openai', 'google', 'zeta']);
  });

  test('a ChatGPT sign-in (codex) or a pooled ChatGPT account connects OpenAI', () => {
    expect(rows({ connectedIds: new Set(['codex']) }).inUse.map((row) => row.id)).toContain('openai');
    expect(rows({ pooledIds: new Set(['codex']) }).inUse.map((row) => row.id)).toContain('openai');
  });

  test('a pooled Claude account connects Anthropic', () => {
    expect(rows({ pooledIds: new Set(['claude-agent']) }).inUse.map((row) => row.id)).toContain('anthropic');
  });

  test('Kortix with no servable model is not in use', () => {
    const { inUse } = rows({ managed: managedProviderEntry({}) });
    expect(inUse).toEqual([]);
  });

  test('search matches name, id and env var', () => {
    expect(rows({ search: 'GROQ_API' }).available.map((row) => row.id)).toEqual(['groq']);
    expect(rows({ search: 'zet' }).available.map((row) => row.id)).toEqual(['zeta']);
  });

  test('a provider turned off for the project says so', () => {
    const groq = rows({ connectedIds: new Set(['groq']), disabledProviders: new Set(['groq']) }).inUse.find(
      (row) => row.id === 'groq',
    );
    expect(groq?.disabled).toBe(true);
  });
});

describe('providerMeta — the line under a row', () => {
  test('the web wording per connect method', () => {
    const { available, inUse } = rows({ connectedIds: new Set(['groq']) });
    const by = (id: string) => [...available, ...inUse].find((row) => row.id === id)!;
    expect(providerMeta(by('openai'))).toBe('Sign in or API key · 2 models');
    expect(providerMeta(by('groq'))).toBe('API key · 1 model');
    expect(providerMeta(by('google'))).toBe('API key');
    expect(providerMeta(by('kortix'))).toBe('Paid from credits · Platinum Inference · 1 model');
  });

  test('OpenAI says how it is connected', () => {
    const openai = (ids: string[]) => rows({ connectedIds: new Set(ids) }).inUse.find((row) => row.id === 'openai')!;
    expect(providerMeta(openai(['codex']))).toBe('ChatGPT Plus or Pro plan · 2 models');
    expect(providerMeta(openai(['openai']))).toBe('API key · 2 models');
    expect(providerMeta(openai(['codex', 'openai']))).toBe('ChatGPT Plus or Pro plan and API key · 2 models');
  });

  test('Kortix with no models shows the upgrade hint', () => {
    const managed = managedProviderEntry({});
    expect(providerMeta({ id: 'kortix', method: 'included', modelCount: 0, hint: managed.hint })).toBe(
      "Upgrade to use Kortix's managed models, or connect your own provider.",
    );
  });
});

describe('providerSheetKind — the web ProviderSheet branch order', () => {
  const entry = (id: string) => CATALOGUE.find((item) => item.id === id)!;

  test('pooled accounts when the flag is on', () => {
    expect(providerSheetKind(entry('openai'), true)).toBe('pooled-chatgpt');
    expect(providerSheetKind(entry('anthropic'), true)).toBe('pooled-claude');
    expect(providerSheetKind(entry('groq'), true)).toBe('pooled-key');
  });

  test('a provider whose key cannot be pooled keeps the project key form', () => {
    expect(providerSheetKind(entry('zeta'), true)).toBe('key');
  });

  test('flag off: subscriptions and project keys', () => {
    expect(providerSheetKind(entry('openai'), false)).toBe('subscription');
    expect(providerSheetKind(entry('anthropic'), false)).toBe('subscription');
    expect(providerSheetKind(entry('groq'), false)).toBe('key');
  });

  test('Kortix is included', () => {
    expect(providerSheetKind(managedProviderEntry({}), true)).toBe('included');
  });
});

describe('accessLine', () => {
  test('the web access words', () => {
    expect(accessLine({ kind: 'project' })).toBe('Everyone in this workspace');
    expect(accessLine({ kind: 'you' })).toBe('Only you');
    expect(accessLine({ kind: 'owner', ownerId: 'u' }, 'ada@example.test')).toBe('Only ada@example.test');
    expect(accessLine({ kind: 'members', count: 1 })).toBe('1 member');
    expect(accessLine({ kind: 'members', count: 3 })).toBe('3 members');
  });
});

describe('formatTokens', () => {
  test('context sizes', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(128_000)).toBe('128K');
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(0)).toBe('');
    expect(formatTokens(null)).toBe('');
  });
});
