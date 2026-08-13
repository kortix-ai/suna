import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PROVIDER_NOTES } from './provider-branding';
import {
  FIRST_CLASS_PROVIDER_IDS,
  ProviderConnectView,
  providerKeyFieldId,
  type ProviderConnectRow,
  type ProviderConnectViewProps,
} from './provider-connect';

/**
 * `ProviderConnectView` is the pure, props-only half of `provider-connect.tsx`
 * — no hooks, no data fetching, no `QueryClientProvider` needed, so it renders
 * under `renderToStaticMarkup` (the repo's only render-assertion idiom; there
 * is no DOM testing library in `apps/web` and none may be added).
 *
 * These four blocks pin JAY-510's acceptance criteria as markup facts.
 */

function row(overrides: Partial<ProviderConnectRow> & { id: string }): ProviderConnectRow {
  return {
    label: overrides.id,
    note: PROVIDER_NOTES[overrides.id],
    envVars: [`${overrides.id.toUpperCase().replace(/-/g, '_')}_API_KEY`],
    helpUrl: null,
    connected: false,
    modelCount: 0,
    ...overrides,
  };
}

const ANTHROPIC = row({ id: 'anthropic', label: 'Anthropic' });
const OPENAI = row({ id: 'openai', label: 'OpenAI' });
const GOOGLE = row({ id: 'google', label: 'Google' });

function props(overrides: Partial<ProviderConnectViewProps> = {}): ProviderConnectViewProps {
  return {
    firstClass: [ANTHROPIC, OPENAI, GOOGLE],
    more: [],
    values: {},
    onValueChange: () => {},
    onConnect: () => {},
    canWrite: true,
    search: '',
    onSearchChange: () => {},
    moreOpen: false,
    onMoreOpenChange: () => {},
    connectedCount: 0,
    ...overrides,
  };
}

describe('ProviderConnectView — Add a provider (section 2)', () => {
  test('renders all three first-class providers with no disclosure and no search', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);

    for (const provider of [ANTHROPIC, OPENAI, GOOGLE]) {
      expect(out).toContain(provider.label);
      expect(out).toContain(`data-provider-row="${provider.id}"`);
    }
    // Nothing is hidden behind a disclosure: the three rows are not inside any
    // element the More-providers disclosure owns.
    expect(out).not.toContain('data-more-providers');
    // And no search field stands between the user and them.
    expect(out).not.toContain('data-provider-search');
  });

  test('the three ids come from FIRST_CLASS_PROVIDER_IDS, in that order', () => {
    expect([...FIRST_CLASS_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'google']);

    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);
    const positions = FIRST_CLASS_PROVIDER_IDS.map((id) =>
      out.indexOf(`data-provider-row="${id}"`),
    );
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('connecting is one field and one button — and opens no dialog', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ firstClass: [ANTHROPIC] })} />,
    );

    expect(out.match(/<input/g)?.length).toBe(1);
    expect(out.match(/<button/g)?.length).toBe(1);
    expect(out).toContain('>Connect<');
    // JAY-510: "Connecting Anthropic opens no dialog."
    expect(out).not.toContain('role="dialog"');
  });

  test('a connected first-class provider still shows its row, marked connected', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ firstClass: [{ ...ANTHROPIC, connected: true }] })} />,
    );
    expect(out).toContain('data-provider-row="anthropic"');
    expect(out).toContain('Connected');
  });

  test('read-only members get no key field and no Connect button', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ firstClass: [ANTHROPIC], canWrite: false })} />,
    );
    expect(out).toContain('data-provider-row="anthropic"');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('>Connect<');
  });
});

describe('ProviderConnectView — subscription wording', () => {
  test('reuses PROVIDER_NOTES verbatim, not a rewrite', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);

    expect(PROVIDER_NOTES.anthropic).toBe('Claude Pro/Max subscription or your own API key');
    expect(PROVIDER_NOTES.openai).toBe('ChatGPT Pro/Plus subscription or your own API key');
    expect(PROVIDER_NOTES.google).toBe('Gemini models from Google AI Studio');

    expect(out).toContain(PROVIDER_NOTES.anthropic);
    expect(out).toContain(PROVIDER_NOTES.openai);
    expect(out).toContain(PROVIDER_NOTES.google);
  });
});

describe('ProviderConnectView — More providers (section 3)', () => {
  const MORE = [row({ id: 'groq', label: 'Groq' }), row({ id: 'mistral', label: 'Mistral' })];

  test('search lives INSIDE the disclosure — closed, it is not in the markup at all', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ more: MORE, moreOpen: false })} />,
    );
    expect(out).toContain('data-more-providers');
    expect(out).not.toContain('data-provider-search');
    expect(out).not.toContain('Groq');
  });

  test('search appears only once the disclosure is open, and AFTER its trigger', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ more: MORE, moreOpen: true })} />,
    );
    const trigger = out.indexOf('data-more-providers-trigger');
    const search = out.indexOf('data-provider-search');
    expect(trigger).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(trigger);
    expect(out).toContain('Groq');
    expect(out).toContain('Mistral');
  });

  test('the first-class rows are rendered BEFORE the disclosure, never inside it', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ more: MORE, moreOpen: true })} />,
    );
    const lastFirstClass = out.indexOf('data-provider-row="google"');
    const disclosure = out.indexOf('data-more-providers');
    expect(lastFirstClass).toBeGreaterThan(-1);
    expect(disclosure).toBeGreaterThan(lastFirstClass);
  });
});

describe('ProviderConnectView — the long-tail detail path', () => {
  /**
   * `ProviderDetail` (the browse-before-you-connect model list) was re-homed
   * here out of the deleted `catalog-tab.tsx`. It is reachable only through a
   * three-condition gate — `onOpenDetail && row.modelCount > 0`, the disclosure
   * open, and `detailProviderId` set — so without these tests the whole
   * capability could be deleted and every other test would still pass. That is
   * exactly the hole six orphans have shipped through in this effort.
   */
  const GROQ = row({ id: 'groq', label: 'Groq', modelCount: 12 });

  test('a long-tail row with models offers the detail affordance', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({ more: [GROQ], moreOpen: true, onOpenDetail: () => {} })}
      />,
    );
    expect(out).toContain('12 models');
  });

  test('no affordance when the row declares no models', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          more: [row({ id: 'groq', label: 'Groq', modelCount: 0 })],
          moreOpen: true,
          onOpenDetail: () => {},
        })}
      />,
    );
    expect(out).not.toContain('0 model');
  });

  test('no affordance when the host supplies no onOpenDetail', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ more: [GROQ], moreOpen: true })} />,
    );
    expect(out).not.toContain('12 models');
  });

  test('the detail REPLACES the search and the row list inside the disclosure', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          more: [GROQ],
          moreOpen: true,
          onOpenDetail: () => {},
          detailProviderId: 'groq',
          detailSlot: <div>provider-detail-marker</div>,
        })}
      />,
    );
    expect(out).toContain('provider-detail-marker');
    // The detail owns the whole disclosure body while it is open.
    expect(out).not.toContain('data-provider-search');
    expect(out).not.toContain('data-provider-row="groq"');
    // Still inside the disclosure, never a dialog.
    expect(out.indexOf('provider-detail-marker')).toBeGreaterThan(
      out.indexOf('data-more-providers-trigger'),
    );
    expect(out).not.toContain('role="dialog"');
  });

  test('the detail never opens over the first-class rows', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          more: [GROQ],
          moreOpen: true,
          detailProviderId: 'groq',
          detailSlot: <div>provider-detail-marker</div>,
        })}
      />,
    );
    for (const id of FIRST_CLASS_PROVIDER_IDS) {
      expect(out).toContain(`data-provider-row="${id}"`);
    }
  });

  test('providerKeyFieldId is the one id the row and the detail both use', () => {
    // `ProviderDetail`'s Connect closes the detail and focuses the row's field
    // by this id. If the row stopped using it the focus would silently no-op.
    expect(providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')).toBe(
      'provider-connect-anthropic-ANTHROPIC_API_KEY',
    );
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          firstClass: [row({ id: 'anthropic', label: 'Anthropic' })],
        })}
      />,
    );
    expect(out).toContain(`id="${providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')}"`);
    expect(out).toContain(`for="${providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')}"`);
  });
});

describe('ProviderConnectView — subtitles', () => {
  /**
   * `PROVIDER_NOTES` has 7 keys. The long tail is ~40 providers. Rendering
   * `PROVIDER_NOTES[id]` alone left every one of them with no subtitle, which
   * `catalog-tab.tsx` did not do — it showed `provider.hint` on every row.
   */
  test('a long-tail row renders the subtitle it was given', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          more: [row({ id: 'groq', label: 'Groq', note: 'Llama 3.3 70B, +8 more' })],
          moreOpen: true,
        })}
      />,
    );
    expect(out).toContain('Llama 3.3 70B, +8 more');
  });
});

describe('ProviderConnectView — section order and slots', () => {
  test('renders the four sections in JAY-510 order: Connected, Add, More, Custom', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          more: [row({ id: 'groq', label: 'Groq' })],
          connectedCount: 1,
          connectedSlot: <div>connected-slot-marker</div>,
          customSlot: <div>custom-slot-marker</div>,
        })}
      />,
    );

    const connected = out.indexOf('connected-slot-marker');
    const add = out.indexOf('data-provider-row="anthropic"');
    const more = out.indexOf('data-more-providers');
    const custom = out.indexOf('custom-slot-marker');

    expect(connected).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(connected);
    expect(more).toBeGreaterThan(add);
    expect(custom).toBeGreaterThan(more);
  });

  test('the Connected section is omitted entirely when nothing is connected', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({ connectedCount: 0, connectedSlot: <div>connected-slot-marker</div> })}
      />,
    );
    expect(out).not.toContain('connected-slot-marker');
  });

  test('the bare view renders with no slots and no providers — needs no providers tree', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ firstClass: [], more: [] })} />,
    );
    expect(out).toContain('Add a provider');
    expect(out).not.toContain('role="dialog"');
  });

  test('the OpenAI subscription slot renders inside the OpenAI row, not as a dialog', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          firstClass: [OPENAI],
          subscriptionSlots: { openai: <div>chatgpt-oauth-marker</div> },
        })}
      />,
    );
    const rowStart = out.indexOf('data-provider-row="openai"');
    const slot = out.indexOf('chatgpt-oauth-marker');
    expect(rowStart).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(rowStart);
    expect(out).not.toContain('role="dialog"');
  });
});
