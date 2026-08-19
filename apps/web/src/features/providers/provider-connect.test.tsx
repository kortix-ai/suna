import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FIRST_CLASS_PROVIDER_IDS,
  PROVIDER_PAGE_SIZE,
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
 * The screen is ONE list. It used to be four stacked sections — Connected,
 * Add a key, a "Show 181 more providers" disclosure, and Custom provider —
 * and every test below pins one of the specific failures that produced:
 * a saved row teleporting into a section that grew under it, the same
 * provider on screen twice, and a long tail hidden behind a number that read
 * as a warning.
 */

function row(overrides: Partial<ProviderConnectRow> & { id: string }): ProviderConnectRow {
  return {
    label: overrides.id,
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
    rows: [ANTHROPIC, OPENAI, GOOGLE],
    totalCount: 184,
    values: {},
    onValueChange: () => {},
    onCommit: () => {},
    onToggleReveal: () => {},
    canWrite: true,
    search: '',
    onSearchChange: () => {},
    ...overrides,
  };
}

/** Every heading the four-section version used to render. */
const DEAD_SECTION_HEADINGS = [
  'Connected',
  'Add a key',
  'Add a provider',
  'More providers',
  'more providers',
  'Custom provider',
  'Something else',
];

describe('ProviderConnectView — one list, no sections', () => {
  test('renders every row it is given, and no section heading at all', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);

    for (const provider of [ANTHROPIC, OPENAI, GOOGLE]) {
      expect(out).toContain(provider.label);
      expect(out).toContain(`data-provider-row="${provider.id}"`);
    }
    for (const heading of DEAD_SECTION_HEADINGS) {
      expect(out).not.toContain(heading);
    }
  });

  test('the disclosure is gone — the long tail lives behind the search field', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);

    expect(out).not.toContain('data-more-providers');
    // The search is always present, never inside anything that has to be
    // opened first — and it carries the count, so no row has to advertise it.
    expect(out).toContain('data-provider-search');
    expect(out).toContain('Search 184 providers…');
  });

  test('the three first-class ids come from FIRST_CLASS_PROVIDER_IDS, in that order', () => {
    expect([...FIRST_CLASS_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'google']);

    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);
    const positions = FIRST_CLASS_PROVIDER_IDS.map((id) =>
      out.indexOf(`data-provider-row="${id}"`),
    );
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('connecting is ONE field and no Connect button — and opens no dialog', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [ANTHROPIC] })} />);

    // One key field plus the always-on search input.
    expect(out.match(/<input/g)?.length).toBe(2);
    expect(out).not.toContain('>Connect<');
    expect(out).not.toContain('role="dialog"');
  });

  test('a search miss says so instead of rendering an empty list', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [], search: 'zzz' })} />,
    );
    // `&quot;` — `renderToStaticMarkup` escapes the quotes around the query.
    expect(out).toContain('No provider matches &quot;zzz&quot;');
  });
});

/**
 * The defect this whole rewrite exists to remove. Saving a key used to move
 * that provider OUT of the grid and into a "Connected" block above it — so
 * finishing a field made the row jump, a section appeared that was not there
 * a second earlier, and the same provider was on screen twice.
 */
describe('ProviderConnectView — a saved provider stays exactly where it was', () => {
  const CONNECTED = { ...ANTHROPIC, connected: true, modelCount: 13 };

  test('a connected provider is one row in the same list, in the same position', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [CONNECTED, OPENAI, GOOGLE] })} />,
    );

    // Once. Not once as a summary and once as a field.
    expect(out.match(/data-provider-row="anthropic"/g)?.length).toBe(1);
    // Still first, exactly where it sat before it had a key.
    expect(out.indexOf('data-provider-row="anthropic"')).toBeLessThan(
      out.indexOf('data-provider-row="openai"'),
    );
  });

  test('its field says a key is stored AND that typing replaces it', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [CONNECTED] })} />);
    // The placeholder is the whole state report: the stored key can never be
    // read back, so the field is empty and this text is all the reader gets.
    expect(out).toContain('Saved — paste a new key to replace it');
  });

  test('there is no Replace key button — typing in the field IS replacing', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [CONNECTED] })} />);
    expect(out).not.toContain('Replace key');
  });

  test('a saved row offers remove, right in the field', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [CONNECTED], onRemoveKey: () => {} })} />,
    );
    expect(out).toContain('aria-label="Remove the Anthropic key"');
    expect(out).toContain('Key saved');
  });

  test('no remove control when the host supplies none — read-only members get no delete', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [CONNECTED] })} />);
    expect(out).not.toContain('aria-label="Remove the Anthropic key"');
  });

  // Once you start typing, the row is being EDITED, so it reports as an edit:
  // the saved check and the remove button give way to the reveal toggle.
  test('typing into a saved row swaps the saved state for the editing controls', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [CONNECTED],
          onRemoveKey: () => {},
          values: { 'anthropic:ANTHROPIC_API_KEY': 'sk-ant-new' },
        })}
      />,
    );
    expect(out).not.toContain('aria-label="Remove the Anthropic key"');
    expect(out).toContain('aria-label="Show Anthropic key"');
  });
});

describe('ProviderConnectView — the key field', () => {
  // The field was `type="text"`, which left a pasted key legible on screen and
  // in any screenshot or screen share of this settings tab.
  test('is masked by default and reveals per field, once there is something to reveal', () => {
    const masked = renderToStaticMarkup(
      <ProviderConnectView
        {...props({ rows: [ANTHROPIC], values: { 'anthropic:ANTHROPIC_API_KEY': 'sk' } })}
      />,
    );
    expect(masked).toContain('type="password"');
    expect(masked).toContain('aria-label="Show Anthropic key"');

    const revealed = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [ANTHROPIC],
          values: { 'anthropic:ANTHROPIC_API_KEY': 'sk' },
          revealedFields: { 'anthropic:ANTHROPIC_API_KEY': true },
        })}
      />,
    );
    expect(revealed).toContain('aria-label="Hide Anthropic key"');
  });

  // An eye beside an empty field promises it can show you the stored key. It
  // cannot — the key is write-only.
  test('offers no reveal button while it is empty', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [ANTHROPIC] })} />);
    expect(out).not.toContain('aria-label="Show Anthropic key"');
  });

  // Bedrock/Vertex need three fields for ONE credential. Three separately
  // bordered boxes read as three unrelated settings, so the stack shares one.
  test('a multi-field provider renders every field, in one bordered group', () => {
    const bedrock = row({
      id: 'amazon-bedrock',
      label: 'AWS Bedrock',
      envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
      placeholders: {
        AWS_ACCESS_KEY_ID: 'Access key id',
        AWS_SECRET_ACCESS_KEY: 'Secret access key',
        AWS_REGION: 'Region',
      },
    });
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [bedrock] })} />);

    // Three key fields plus the search input.
    expect(out.match(/<input/g)?.length).toBe(4);
    for (const envVar of bedrock.envVars) {
      expect(out).toContain(`id="${providerKeyFieldId('amazon-bedrock', envVar)}"`);
    }
    // Human field names, never the env-var names, in the placeholders.
    expect(out).toContain('Secret access key');
    expect(out).not.toContain('placeholder="AWS_SECRET_ACCESS_KEY"');
    expect(out).toContain('divide-y');
  });

  test('the status glyph rides the LAST field only — one save, one indicator', () => {
    const bedrock = row({
      id: 'amazon-bedrock',
      label: 'AWS Bedrock',
      envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    });
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({ rows: [bedrock], statuses: { 'amazon-bedrock': 'error' } })}
      />,
    );
    expect(out.match(/role="status"/g)?.length).toBe(1);
    expect(out).toContain('Could not save');
  });

  test('an error is shown on the row, not only in a toast', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [ANTHROPIC],
          statuses: { anthropic: 'error' },
          errors: { anthropic: 'That key was rejected.' },
        })}
      />,
    );
    expect(out).toContain('That key was rejected.');
  });

  test('the error text is shown ONLY while that provider is in the error status', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [ANTHROPIC],
          statuses: { anthropic: 'idle' },
          errors: { anthropic: 'That key was rejected.' },
        })}
      />,
    );
    expect(out).not.toContain('That key was rejected.');
  });

  test('providerKeyFieldId is the one id the row and the detail both use', () => {
    // `ProviderDetail`'s Connect closes the detail and focuses the row's field
    // by this id. If the row stopped using it the focus would silently no-op.
    expect(providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')).toBe(
      'provider-connect-anthropic-ANTHROPIC_API_KEY',
    );
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [ANTHROPIC] })} />);
    expect(out).toContain(`id="${providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')}"`);
    expect(out).toContain(`for="${providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY')}"`);
  });
});

describe('ProviderConnectView — access and copy', () => {
  test('read-only members get no key field and no save control', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [ANTHROPIC], canWrite: false })} />,
    );
    expect(out).toContain('data-provider-row="anthropic"');
    expect(out).not.toContain(providerKeyFieldId('anthropic', 'ANTHROPIC_API_KEY'));
    expect(out).not.toContain('>Connect<');
  });

  /**
   * The save has no button, so this sentence is the ONLY thing telling a user
   * their key will be written. Losing it turns a working auto-save into an
   * edit that silently vanished, which is why it is pinned.
   */
  test('the screen says the field saves itself', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props()} />);
    expect(out).toContain('it saves when you click away');
  });

  test('read-only members are told who can add a key instead', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ canWrite: false })} />);
    expect(out).not.toContain('it saves when you click away');
    expect(out).toContain('read-only access');
  });

  test('the bare view renders with no rows and no slots — needs no providers tree', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [] })} />);
    expect(out).not.toContain('role="dialog"');
  });
});

describe('ProviderConnectView — the long-tail detail path', () => {
  /**
   * `ProviderDetail` (the browse-before-you-connect model list) was re-homed
   * here out of the deleted `catalog-tab.tsx`. It is reachable only through a
   * two-condition gate — `onOpenDetail && row.modelCount > 0`, then
   * `detailProviderId` set — so without these tests the whole capability could
   * be deleted and every other test would still pass.
   */
  const GROQ = row({ id: 'groq', label: 'Groq', modelCount: 12 });

  test('a row with models offers the detail affordance', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [GROQ], onOpenDetail: () => {} })} />,
    );
    expect(out).toContain('12 models');
  });

  test('no affordance when the row declares no models', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({ rows: [row({ id: 'groq', label: 'Groq' })], onOpenDetail: () => {} })}
      />,
    );
    expect(out).not.toContain('0 model');
  });

  test('no affordance when the host supplies no onOpenDetail', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [GROQ] })} />);
    expect(out).not.toContain('12 models');
  });

  test('the detail REPLACES the whole list, and is never a dialog', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [GROQ, ANTHROPIC],
          onOpenDetail: () => {},
          detailProviderId: 'groq',
          detailSlot: <div>provider-detail-marker</div>,
        })}
      />,
    );
    expect(out).toContain('provider-detail-marker');
    expect(out).not.toContain('data-provider-search');
    expect(out).not.toContain('data-provider-row=');
    expect(out).not.toContain('role="dialog"');
  });
});

/**
 * The list pages. The search does not.
 *
 * Both halves are pinned because either one alone is the wrong screen: a list
 * with no `Load more` is the 184-row wall this file's header describes, and a
 * `Load more` that also gates the search results is the "Show 181 more
 * providers" disclosure it deleted, wearing a different label. The host decides
 * what is in `rows`; the view's job is to say what is missing and offer the
 * way to it, and only when there is something missing.
 */
describe('ProviderConnectView — Load more', () => {
  test('a batch size is declared, and it is a screen and not a catalogue', () => {
    expect(PROVIDER_PAGE_SIZE).toBe(12);
  });

  test('offers Load more with the remainder counted, when rows are held back', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ hiddenCount: 172, onLoadMore: () => {} })} />,
    );
    expect(out).toContain('data-provider-load-more');
    expect(out).toContain('Load more');
    // Says how many of how many — the button is the bottom of a list, not a
    // door with a number on it.
    expect(out).toContain('3');
    expect(out).toContain('175');
  });

  test('no Load more when every matching row is already on screen', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ hiddenCount: 0, onLoadMore: () => {} })} />,
    );
    expect(out).not.toContain('data-provider-load-more');
    expect(out).not.toContain('Load more');
  });

  test('no Load more when the host offers no way to load more', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ hiddenCount: 172 })} />);
    expect(out).not.toContain('data-provider-load-more');
  });

  // The count in the search placeholder is the CATALOGUE's, never the page's —
  // it is the promise that typing reaches all of them.
  test('the search still counts every provider, not the ones rendered', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ totalCount: 184, hiddenCount: 172, onLoadMore: () => {} })} />,
    );
    expect(out).toContain('Search 184 providers…');
  });
});

/**
 * A provider whose credential takes more than one field — Bedrock's bearer
 * token + region, Vertex's JSON + project + location.
 *
 * Saving one used to erase the difference between its fields: both placeholders
 * became the same "Saved — paste a new key to replace it", and only the LAST
 * field showed the saved check and the remove button. Two identical-looking
 * rows, one of which could be cleared. Both defects are pinned here.
 */
describe('ProviderConnectView — a saved multi-field provider', () => {
  const BEDROCK = row({
    id: 'amazon-bedrock',
    label: 'AWS Bedrock',
    envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
    placeholders: { AWS_BEARER_TOKEN_BEDROCK: 'Bearer token bedrock', AWS_REGION: 'Region' },
    connected: true,
  });

  test('each field keeps its own name once it is saved', () => {
    const out = renderToStaticMarkup(<ProviderConnectView {...props({ rows: [BEDROCK] })} />);
    expect(out).toContain('Bearer token bedrock — saved, paste a new one to replace it');
    expect(out).toContain('Region — saved, paste a new one to replace it');
    // The generic sentence belongs to single-field providers only — it is what
    // made these two rows indistinguishable.
    expect(out).not.toContain('placeholder="Saved — paste a new key to replace it"');
  });

  test('every saved field gets the check and the remove, not just the last', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [BEDROCK], onRemoveKey: () => {} })} />,
    );
    expect(out.match(/aria-label="Key saved"/g)?.length).toBe(2);
    expect(out.match(/aria-label="Remove the AWS Bedrock key"/g)?.length).toBe(2);
  });

  test('a single-field provider keeps the sentence it always had', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView {...props({ rows: [{ ...ANTHROPIC, connected: true }] })} />,
    );
    expect(out).toContain('Saved — paste a new key to replace it');
  });

  // Typing into either field is an EDIT of the whole credential, so the saved
  // report gives way across the group — not just on the field being typed in.
  test('typing into one field drops the saved report on both', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [BEDROCK],
          onRemoveKey: () => {},
          values: { 'amazon-bedrock:AWS_REGION': 'us-east-1' },
        })}
      />,
    );
    expect(out).not.toContain('aria-label="Key saved"');
    expect(out).not.toContain('aria-label="Remove the AWS Bedrock key"');
  });
});

describe('ProviderConnectView — the subscription slot', () => {
  test('renders inside the OpenAI row, not as a dialog', () => {
    const out = renderToStaticMarkup(
      <ProviderConnectView
        {...props({
          rows: [OPENAI],
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
