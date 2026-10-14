import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import {
  FIRST_CLASS_PROVIDER_IDS,
  PROVIDER_PAGE_SIZE,
  ProviderConnectView,
  connectedVia,
  providerMethod,
  supportsPooledProviderKey,
  type ProviderConnectViewProps,
  type ProviderListRow,
} from './provider-connect';

/**
 * `ProviderConnectView` is the pure half of the Providers list. It renders
 * under `renderToStaticMarkup` with no provider tree — the repo's only
 * render-assertion idiom.
 */

function row(overrides: Partial<ProviderListRow> & { id: string }): ProviderListRow {
  return { label: overrides.id, method: 'key', modelCount: 0, status: 'none', ...overrides };
}

const KORTIX = row({ id: 'kortix', label: 'Kortix', method: 'included', status: 'included', modelCount: 42 });
const ANTHROPIC = row({ id: 'anthropic', label: 'Anthropic', status: 'connected', modelCount: 14 });
const GOOGLE = row({ id: 'google', label: 'Google Gemini', modelCount: 18 });

function props(overrides: Partial<ProviderConnectViewProps> = {}): ProviderConnectViewProps {
  return {
    inUse: [KORTIX, ANTHROPIC],
    available: [GOOGLE],
    totalCount: 184,
    search: '',
    onSearchChange: () => {},
    onSelect: () => {},
    ...overrides,
  };
}

const render = (overrides: Partial<ProviderConnectViewProps> = {}) =>
  renderToStaticMarkup(<ProviderConnectView {...props(overrides)} />);

describe('ProviderConnectView — two groups, rows open the sheet', () => {
  test('In use counts its rows; Available follows', () => {
    const out = render();
    expect(out).toContain('In use · 2');
    expect(out).toContain('Available');
    expect(out.indexOf('In use')).toBeLessThan(out.indexOf('Available'));
  });

  test('every row is one button, and the list holds no key field', () => {
    const out = render();
    expect(out.match(/<button[^>]*data-provider-row=/g)?.length).toBe(3);
    expect(out).not.toContain('type="password"');
  });

  test('a solid green check on the logo for Kortix and a stored key, none otherwise', () => {
    const out = render();
    expect(out).toContain('aria-label="Included"');
    expect(out).toContain('aria-label="Connected"');
    expect(out.match(/text-kortix-green/g)?.length).toBe(2);
    const google = out.slice(out.indexOf('data-provider-row="google"'));
    expect(google).not.toContain('Connected');
  });

  test('the meta line names the method and the model count', () => {
    const out = render();
    expect(out).toContain('Included with your plan · 42 models');
    expect(out).toContain('API key · 14 models');
  });

  test('a connected two-way provider says how it is connected, not how it could be', () => {
    const openai = row({ id: 'openai', label: 'OpenAI', method: 'signInOrKey', status: 'connected', modelCount: 53 });
    expect(render({ inUse: [{ ...openai, via: 'signIn' }] })).toContain('ChatGPT Plus or Pro plan · 53 models');
    expect(render({ inUse: [{ ...openai, via: 'key' }] })).toContain('API key · 53 models');
    expect(render({ inUse: [{ ...openai, via: 'both' }] })).toContain('ChatGPT Plus or Pro plan and API key');
    expect(render({ inUse: [], available: [{ ...openai, status: 'none' }] })).toContain('Sign in or API key');
  });

  test('connectedVia tells the ChatGPT sign-in (codex) from the OpenAI key', () => {
    expect(connectedVia('openai', new Set(['codex']))).toBe('signIn');
    expect(connectedVia('openai', new Set(['openai']))).toBe('key');
    expect(connectedVia('openai', new Set(['openai', 'codex']))).toBe('both');
    expect(connectedVia('openai', new Set())).toBeUndefined();
    expect(connectedVia('groq', new Set(['groq']))).toBeUndefined();
  });

  test('a provider turned off for the project says so on its row', () => {
    const out = render({ available: [{ ...GOOGLE, disabled: true }] });
    expect(out).toContain('Turned off');
  });

  test('the open provider is marked current', () => {
    const out = render({ selectedId: 'anthropic' });
    expect(out).toMatch(/data-provider-row="anthropic"[^>]*aria-current="true"|aria-current="true"[^>]*data-provider-row="anthropic"/);
    expect(out.match(/aria-current/g)?.length).toBe(1);
  });

  test('an empty group renders no heading', () => {
    const out = render({ inUse: [] });
    expect(out).not.toContain('In use');
  });

  test('a search miss says so instead of rendering an empty list', () => {
    const out = render({ inUse: [], available: [], search: 'zzz' });
    expect(out).toContain('No provider matches “zzz”');
  });

  test('the search counts the whole catalogue', () => {
    expect(render()).toContain('Search 184 providers');
  });

  test('no instruction line unless the host passes one', () => {
    expect(render()).not.toContain('px-3 text-xs text-pretty');
    expect(render({ note: 'Ask an owner of this project to add a key.' })).toContain(
      'Ask an owner of this project to add a key.',
    );
  });
});

describe('ProviderConnectView — Show more', () => {
  test('a batch is a screen, not a catalogue', () => {
    expect(PROVIDER_PAGE_SIZE).toBe(12);
  });

  test('offers Show more with the remainder counted', () => {
    const out = render({ hiddenCount: 170, onLoadMore: () => {} });
    expect(out).toContain('Show more');
    expect(out).toContain('3 of 173');
  });

  test('no Show more when everything is on screen, or the host offers no way', () => {
    expect(render({ hiddenCount: 0, onLoadMore: () => {} })).not.toContain('Show more');
    expect(render({ hiddenCount: 5 })).not.toContain('Show more');
  });
});

describe('provider metadata', () => {
  test('the first-class trio, in order', () => {
    expect([...FIRST_CLASS_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'google']);
  });

  test('providerMethod: included, two-way, key', () => {
    expect(providerMethod({ id: 'kortix', envVars: [], managed: true })).toBe('included');
    expect(providerMethod({ id: 'openai', envVars: ['OPENAI_API_KEY'] })).toBe('signInOrKey');
    expect(providerMethod({ id: 'groq', envVars: ['GROQ_API_KEY'] })).toBe('key');
    expect(providerMethod({ id: 'github-copilot', envVars: [] })).toBe('signIn');
  });

  test('pooled keys only where the gateway can route a single API key', () => {
    expect(supportsPooledProviderKey(LLM_PROVIDER_BY_ID.get('anthropic'))).toBe(true);
    expect(supportsPooledProviderKey(LLM_PROVIDER_BY_ID.get('openai'))).toBe(true);
    expect(supportsPooledProviderKey(LLM_PROVIDER_BY_ID.get('google'))).toBe(true);
    expect(supportsPooledProviderKey(LLM_PROVIDER_BY_ID.get('qvac'))).toBe(false);
  });
});
