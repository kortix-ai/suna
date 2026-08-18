import { describe, expect, test } from 'bun:test';

import {
  formatPricePerMillion,
  formatTokenCount,
  gatewayModelId,
  orderProviderRows,
  pickInitialTab,
  providerDisconnectPlan,
  shouldSaveCredential,
} from './utils';

/**
 * The "Add a key" grid has no Connect button — focus leaving a provider's
 * fields is the save. That trigger fires on rows nobody touched, so this
 * predicate is the ONLY thing standing between a settings screen and a burst
 * of writes. Each of its three rules gets its own test.
 */
describe('shouldSaveCredential — the auto-save guard', () => {
  const single = { providerId: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] };
  const bedrock = {
    providerId: 'amazon-bedrock',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
  };

  test('saves a key that was typed and never saved before', () => {
    expect(
      shouldSaveCredential({
        ...single,
        values: { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-live' },
        savedValues: {},
      }),
    ).toBe(true);
  });

  // Rule 1 — the common case by a mile: forty rows, none of them touched.
  test('an untouched row saves nothing', () => {
    expect(shouldSaveCredential({ ...single, values: {}, savedValues: {} })).toBe(false);
  });

  test('whitespace alone is not a key', () => {
    expect(
      shouldSaveCredential({
        ...single,
        values: { 'anthropic:ANTHROPIC_API_KEY': '   ' },
        savedValues: {},
      }),
    ).toBe(false);
  });

  // Rule 2 — the one that would corrupt state rather than just waste a call:
  // two of Bedrock's three fields is a credential that cannot authenticate,
  // and the provider would still report itself connected.
  test('a partly filled multi-field credential saves nothing', () => {
    expect(
      shouldSaveCredential({
        ...bedrock,
        values: {
          'amazon-bedrock:AWS_ACCESS_KEY_ID': 'AKIA',
          'amazon-bedrock:AWS_SECRET_ACCESS_KEY': 'secret',
        },
        savedValues: {},
      }),
    ).toBe(false);
  });

  test('the same credential saves once every field is filled', () => {
    expect(
      shouldSaveCredential({
        ...bedrock,
        values: {
          'amazon-bedrock:AWS_ACCESS_KEY_ID': 'AKIA',
          'amazon-bedrock:AWS_SECRET_ACCESS_KEY': 'secret',
          'amazon-bedrock:AWS_REGION': 'us-east-1',
        },
        savedValues: {},
      }),
    ).toBe(true);
  });

  // Rule 3 — without it, every pass of focus over a saved row re-POSTs the key.
  test('re-entering and leaving an already-saved row saves nothing', () => {
    const values = { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-live' };
    expect(shouldSaveCredential({ ...single, values, savedValues: { ...values } })).toBe(false);
  });

  test('editing an already-saved key saves again', () => {
    expect(
      shouldSaveCredential({
        ...single,
        values: { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-rotated' },
        savedValues: { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-live' },
      }),
    ).toBe(true);
  });

  test('one changed field out of three is still an edit', () => {
    const saved = {
      'amazon-bedrock:AWS_ACCESS_KEY_ID': 'AKIA',
      'amazon-bedrock:AWS_SECRET_ACCESS_KEY': 'secret',
      'amazon-bedrock:AWS_REGION': 'us-east-1',
    };
    expect(
      shouldSaveCredential({
        ...bedrock,
        values: { ...saved, 'amazon-bedrock:AWS_REGION': 'eu-west-1' },
        savedValues: saved,
      }),
    ).toBe(true);
  });

  // The saved snapshot is trimmed, so a stray space must not read as an edit.
  test('trailing whitespace on an unchanged key is not an edit', () => {
    expect(
      shouldSaveCredential({
        ...single,
        values: { 'anthropic:ANTHROPIC_API_KEY': '  sk-ant-live  ' },
        savedValues: { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-live' },
      }),
    ).toBe(false);
  });

  test('a provider that declares no fields never saves', () => {
    expect(
      shouldSaveCredential({ providerId: 'x', envVars: [], values: {}, savedValues: {} }),
    ).toBe(false);
  });
});

/**
 * The row that jumped. Saving a key used to move that provider out of the list
 * you were reading and into a "Connected" block above it, so finishing a field
 * made the row leap and a section appear that was not there a second earlier.
 * These pin the fix as arithmetic, where it cannot be undone by a layout edit.
 */
describe('orderProviderRows — a saved key never moves a row', () => {
  const p = (id: string, envVars = [`${id.toUpperCase()}_API_KEY`]) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    envVars,
  });
  const CATALOG = [p('anthropic'), p('openai'), p('google'), p('groq'), p('mistral')];
  const FIRST_CLASS = ['anthropic', 'openai', 'google'] as const;
  const order = (connected: string[], search = '') =>
    orderProviderRows({
      providers: CATALOG,
      firstClassIds: FIRST_CLASS,
      connectedIds: new Set(connected),
      search,
    }).map((provider) => provider.id);

  test('the whole catalog renders, first-class three first, then catalog order', () => {
    expect(order([])).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  // THE regression. Anthropic is first before it has a key and first after.
  test('connecting a first-class provider does not change its position', () => {
    expect(order([])).toEqual(order(['anthropic']));
    expect(order(['anthropic'])[0]).toBe('anthropic');
  });

  test('connecting every one of them still does not reorder anything', () => {
    expect(order(['google', 'openai', 'anthropic'])).toEqual(order([]));
  });

  // THE second regression, and the reason the long tail is not sorted by
  // connectedness: a connected provider keeps its catalog position instead of
  // being promoted above the ones next to it.
  test('connecting a long-tail provider does not move it either', () => {
    expect(order(['groq'])).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  test('an unconnected long-tail provider is listed anyway — every provider shows', () => {
    expect(order([])).toContain('groq');
    expect(order([])).toContain('mistral');
  });

  test('a connected provider is never listed twice', () => {
    const ids = order(['anthropic', 'groq']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('search replaces the list with catalog matches, connected or not', () => {
    expect(order([], 'gro')).toEqual(['groq']);
    expect(order(['groq'], 'gro')).toEqual(['groq']);
  });

  test('search matches label, id, and env-var name', () => {
    const bedrock = { id: 'amazon-bedrock', label: 'AWS Bedrock', envVars: ['AWS_ACCESS_KEY_ID'] };
    const find = (search: string) =>
      orderProviderRows({
        providers: [...CATALOG, bedrock],
        firstClassIds: FIRST_CLASS,
        connectedIds: new Set<string>(),
        search,
      }).map((provider) => provider.id);

    expect(find('bedrock')).toEqual(['amazon-bedrock']);
    expect(find('AWS Bed')).toEqual(['amazon-bedrock']);
    expect(find('aws_access')).toEqual(['amazon-bedrock']);
  });

  test('whitespace is not a search — it shows the ordered full list, unfiltered', () => {
    expect(order([], '   ')).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  test('a first-class id missing from the catalog is skipped, not rendered empty', () => {
    const ids = orderProviderRows({
      providers: [p('openai')],
      firstClassIds: FIRST_CLASS,
      connectedIds: new Set<string>(),
      search: '',
    }).map((provider) => provider.id);
    expect(ids).toEqual(['openai']);
  });
});

describe('pickInitialTab', () => {
  test('opens Providers by default', () => {
    expect(pickInitialTab(undefined)).toBe('providers');
  });

  test('opens Providers when Providers is asked for', () => {
    expect(pickInitialTab('providers')).toBe('providers');
  });

  test('honors an explicit Models tab', () => {
    expect(pickInitialTab('models')).toBe('models');
  });
});

describe('providerDisconnectPlan', () => {
  test('uses the OAuth removal route for ChatGPT and deletes only its legacy row directly', () => {
    expect(
      providerDisconnectPlan({
        id: 'codex',
        envVars: ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'],
      }),
    ).toEqual({ oauthProvider: 'openai', secretNames: ['OPENCODE_AUTH_JSON'] });
  });

  test('removes an OpenAI API key and the subscription credentials', () => {
    expect(providerDisconnectPlan({ id: 'openai', envVars: ['OPENAI_API_KEY'] })).toEqual({
      oauthProvider: 'openai',
      secretNames: ['OPENAI_API_KEY', 'OPENCODE_AUTH_JSON'],
    });
  });

  test('uses secret removal only for a regular provider', () => {
    expect(providerDisconnectPlan({ id: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] })).toEqual({
      oauthProvider: null,
      secretNames: ['ANTHROPIC_API_KEY'],
    });
  });
});

describe('gatewayModelId', () => {
  test('BYOK provider gets a provider/model wire id', () => {
    expect(gatewayModelId({ id: 'anthropic', managed: false }, 'claude-sonnet-4.6')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
  });

  test('managed Kortix provider stays bare (single-segment)', () => {
    expect(gatewayModelId({ id: 'kortix', managed: true }, 'claude-opus-4.8')).toBe(
      'claude-opus-4.8',
    );
  });

  test('codex (ChatGPT subscription) gets a codex/ prefix', () => {
    expect(gatewayModelId({ id: 'codex', managed: false }, 'gpt-5.6-sol')).toBe(
      'codex/gpt-5.6-sol',
    );
  });
});

describe('formatTokenCount', () => {
  test('formats millions with a decimal only when not whole', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  test('formats thousands rounded to the nearest K', () => {
    expect(formatTokenCount(128_000)).toBe('128K');
    expect(formatTokenCount(8_192)).toBe('8K');
  });

  test('formats sub-1000 values verbatim', () => {
    expect(formatTokenCount(512)).toBe('512');
  });

  test('returns empty string for falsy or non-positive input', () => {
    expect(formatTokenCount(undefined)).toBe('');
    expect(formatTokenCount(null)).toBe('');
    expect(formatTokenCount(0)).toBe('');
    expect(formatTokenCount(-5)).toBe('');
  });
});

describe('formatPricePerMillion', () => {
  test('formats whole-dollar rates with two decimals', () => {
    expect(formatPricePerMillion(3)).toBe('$3.00');
    expect(formatPricePerMillion(15)).toBe('$15.00');
  });

  test('formats sub-dollar rates with three decimals', () => {
    expect(formatPricePerMillion(0.25)).toBe('$0.250');
  });

  test('formats sub-cent rates with four decimals', () => {
    expect(formatPricePerMillion(0.0007)).toBe('$0.0007');
  });

  test('zero rate reads as Free', () => {
    expect(formatPricePerMillion(0)).toBe('Free');
  });

  test('returns empty string when the rate is unknown', () => {
    expect(formatPricePerMillion(null)).toBe('');
    expect(formatPricePerMillion(undefined)).toBe('');
  });
});
