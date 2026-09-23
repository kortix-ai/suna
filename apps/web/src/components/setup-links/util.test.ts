import { afterEach, describe, expect, test } from 'bun:test';

import { HostBoundaryError } from '@kortix/sdk';
import {
  classifySetupLinkError,
  describeLinkExpiry,
  holdPendingSetupLink,
  parsePendingSetupLinkHref,
  parseSetupLinkHref,
  partialSetupLinkKind,
  pendingSetupLinkHref,
  setupLinkChipLabel,
  splitTextLinks,
} from './util';

describe('splitTextLinks', () => {
  test('plain text stays one text part', () => {
    expect(splitTextLinks('Settings → API in Apollo')).toEqual([
      { type: 'text', value: 'Settings → API in Apollo' },
    ]);
  });

  test('a bare URL becomes a link labelled without the protocol, and keeps the sentence period out', () => {
    expect(splitTextLinks('Create one at https://platform.openai.com/api-keys.')).toEqual([
      { type: 'text', value: 'Create one at ' },
      {
        type: 'link',
        href: 'https://platform.openai.com/api-keys',
        label: 'platform.openai.com/api-keys',
      },
      { type: 'text', value: '.' },
    ]);
  });

  test('a markdown link keeps its own label', () => {
    expect(
      splitTextLinks('Open [Apollo settings](https://app.apollo.io/#/settings/api) → API'),
    ).toEqual([
      { type: 'text', value: 'Open ' },
      { type: 'link', href: 'https://app.apollo.io/#/settings/api', label: 'Apollo settings' },
      { type: 'text', value: ' → API' },
    ]);
  });

  test('a bare URL inside parentheses does not swallow the closing parenthesis', () => {
    expect(splitTextLinks('(see https://dashboard.stripe.com/apikeys)')).toEqual([
      { type: 'text', value: '(see ' },
      {
        type: 'link',
        href: 'https://dashboard.stripe.com/apikeys',
        label: 'dashboard.stripe.com/apikeys',
      },
      { type: 'text', value: ')' },
    ]);
  });

  test('a non-http scheme is never a link', () => {
    expect(splitTextLinks('javascript:alert(1) and [x](javascript:alert(1))')).toEqual([
      { type: 'text', value: 'javascript:alert(1) and [x](javascript:alert(1))' },
    ]);
  });
});

const TOKEN = `ksl_${'A'.repeat(400)}`;

function withWindowOrigin(origin: string) {
  (globalThis as any).window = { location: { origin } };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('parseSetupLinkHref', () => {
  test('parses a same-origin secret-intake URL', () => {
    withWindowOrigin('https://kortix.com');
    expect(parseSetupLinkHref(`https://kortix.com/secret-intake/${TOKEN}`)).toEqual({
      kind: 'secret',
      token: TOKEN,
    });
  });

  test('parses a relative connect path', () => {
    expect(parseSetupLinkHref(`/connect/${TOKEN}`)).toEqual({
      kind: 'connector',
      token: TOKEN,
    });
  });

  test('cross-origin ksl_ links are still intercepted (FRONTEND_URL ≠ app origin)', () => {
    withWindowOrigin('https://staging.kortix.com');
    expect(parseSetupLinkHref(`https://kortix.com/secret-intake/${TOKEN}`)).toEqual({
      kind: 'secret',
      token: TOKEN,
    });
  });

  test('cross-origin non-ksl paths stay plain links', () => {
    withWindowOrigin('https://kortix.com');
    expect(parseSetupLinkHref('https://example.com/connect/some-other-token')).toBeNull();
  });

  test('unrelated URLs are ignored', () => {
    expect(parseSetupLinkHref('https://kortix.com/docs')).toBeNull();
    expect(parseSetupLinkHref('/projects/p1')).toBeNull();
    expect(parseSetupLinkHref(undefined)).toBeNull();
  });
});

describe('setupLinkChipLabel', () => {
  test('a raw URL as link text falls back to the friendly label', () => {
    expect(
      setupLinkChipLabel(`https://kortix.com/secret-intake/${TOKEN}`, TOKEN, 'Enter credentials'),
    ).toBe('Enter credentials');
  });

  test('link text containing the token falls back', () => {
    expect(setupLinkChipLabel(`secret-intake/${TOKEN}`, TOKEN, 'Enter credentials')).toBe(
      'Enter credentials',
    );
  });

  test('a long unbroken string falls back', () => {
    expect(setupLinkChipLabel('x'.repeat(80), TOKEN, 'Connect app')).toBe('Connect app');
  });

  test('empty text falls back', () => {
    expect(setupLinkChipLabel('  ', TOKEN, 'Connect app')).toBe('Connect app');
  });

  test('no token yet (the URL is still streaming) keeps a human label', () => {
    // An empty token is a substring of every string, so a bare
    // `text.includes(token)` would send every pending card to the fallback.
    expect(setupLinkChipLabel('Connect Outlook', '', 'Connect app')).toBe('Connect Outlook');
    expect(setupLinkChipLabel('', '', 'Connect app')).toBe('Connect app');
  });

  test('a human-authored label is kept', () => {
    expect(setupLinkChipLabel('Enter your Slack credentials', TOKEN, 'Enter credentials')).toBe(
      'Enter your Slack credentials',
    );
  });
});

describe('classifySetupLinkError', () => {
  test('410 means expired — the recoverable, expected state', () => {
    expect(classifySetupLinkError(new HostBoundaryError('This link has expired', 410, null))).toBe(
      'expired',
    );
  });

  test('404 and 400 mean the link itself is bad (truncated copy, wrong type)', () => {
    expect(
      classifySetupLinkError(new HostBoundaryError('Invalid or unknown link', 404, null)),
    ).toBe('invalid');
    expect(classifySetupLinkError(new HostBoundaryError('Wrong link type', 400, null))).toBe(
      'invalid',
    );
  });

  test('status carried structurally (no instanceof) still classifies', () => {
    expect(classifySetupLinkError({ status: 410 })).toBe('expired');
    expect(classifySetupLinkError({ status: 404 })).toBe('invalid');
  });

  test('anything without a known status is a network problem', () => {
    expect(classifySetupLinkError(new TypeError('fetch failed'))).toBe('network');
    expect(classifySetupLinkError(new HostBoundaryError('rate limited', 429, null))).toBe(
      'network',
    );
    expect(classifySetupLinkError(undefined)).toBe('network');
  });
});

describe('describeLinkExpiry', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');

  test('rounds to the largest sensible unit', () => {
    expect(describeLinkExpiry('2026-08-14T12:00:00.000Z', now)).toBe('7 days');
    expect(describeLinkExpiry('2026-08-07T17:00:00.000Z', now)).toBe('5 hours');
    expect(describeLinkExpiry('2026-08-07T12:25:00.000Z', now)).toBe('25 minutes');
    expect(describeLinkExpiry('2026-08-07T12:01:00.000Z', now)).toBe('less than 2 minutes');
  });

  test('past or unparseable expiry yields null', () => {
    expect(describeLinkExpiry('2026-08-07T11:00:00.000Z', now)).toBeNull();
    expect(describeLinkExpiry('not-a-date', now)).toBeNull();
  });
});

// ─── A setup link whose URL is still streaming ──────────────────────────────
// The token is several hundred characters, so a setup link takes a second or
// two to stream. Until its closing paren arrives the renderer only has the
// part so far, and the reader should see the card it will become, with
// nothing to click, instead of the raw `[label](` text.
// ────────────────────────────────────────────────────────────────────────────

describe('partialSetupLinkKind', () => {
  test('answers as soon as the path names a setup route', () => {
    withWindowOrigin('https://kortix.com');
    expect(partialSetupLinkKind('https://kortix.com/connect/')).toBe('connector');
    expect(partialSetupLinkKind('https://kortix.com/connect/ksl_AB')).toBe('connector');
    expect(partialSetupLinkKind('https://kortix.com/secret-intake/k')).toBe('secret');
    expect(partialSetupLinkKind('/connect/ksl_AB')).toBe('connector');
  });

  test('says nothing while the URL could still be anything', () => {
    withWindowOrigin('https://kortix.com');
    for (const partial of [
      '',
      'h',
      'https:/',
      'https://kort',
      'https://kortix.com/co',
      '/connect',
    ]) {
      expect(partialSetupLinkKind(partial)).toBeNull();
    }
  });

  test('a cross-origin URL counts only while its token can still be ksl_', () => {
    withWindowOrigin('https://staging.kortix.com');
    expect(partialSetupLinkKind('https://kortix.com/connect/')).toBe('connector');
    expect(partialSetupLinkKind('https://kortix.com/connect/ks')).toBe('connector');
    expect(partialSetupLinkKind('https://kortix.com/connect/ksl_AB')).toBe('connector');
    expect(partialSetupLinkKind('https://example.com/connect/other-token')).toBeNull();
  });

  test('other routes and schemes are not setup links', () => {
    expect(partialSetupLinkKind('https://kortix.com/docs/connect/')).toBeNull();
    expect(partialSetupLinkKind('javascript:/connect/')).toBeNull();
    expect(partialSetupLinkKind('Connect Outlook')).toBeNull();
  });
});

describe('pending setup-link href', () => {
  test('round-trips each kind', () => {
    expect(parsePendingSetupLinkHref(pendingSetupLinkHref('connector'))).toBe('connector');
    expect(parsePendingSetupLinkHref(pendingSetupLinkHref('secret'))).toBe('secret');
  });

  test('is a fragment, so it can never navigate anywhere', () => {
    expect(pendingSetupLinkHref('connector').startsWith('#')).toBe(true);
  });

  test('anything else is not a pending setup link', () => {
    expect(parsePendingSetupLinkHref(undefined)).toBeNull();
    expect(parsePendingSetupLinkHref('#section')).toBeNull();
    expect(parsePendingSetupLinkHref(`${pendingSetupLinkHref('connector')}x`)).toBeNull();
    expect(parsePendingSetupLinkHref(`/connect/${TOKEN}`)).toBeNull();
  });
});

describe('holdPendingSetupLink', () => {
  const LEAD = "Here's a fresh authorization link:\n\n";
  const URL = `https://kortix.com/connect/${TOKEN}`;
  const LINK = `[Connect Outlook](${URL})`;

  test('holds the link as a pending card from the moment the path names a setup route', () => {
    withWindowOrigin('https://kortix.com');
    const pending = `${LEAD}[Connect Outlook](${pendingSetupLinkHref('connector')})`;
    for (const cut of ['https://kortix.com/connect/', 'https://kortix.com/connect/ksl_AAA', URL]) {
      expect(holdPendingSetupLink(`${LEAD}[Connect Outlook](${cut}`)).toBe(pending);
    }
  });

  test('leaves the text alone before the route is known and after the link closes', () => {
    withWindowOrigin('https://kortix.com');
    for (const text of [
      `${LEAD}[Connect Outl`,
      `${LEAD}[Connect Outlook](`,
      `${LEAD}[Connect Outlook](https://kortix.com/co`,
      `${LEAD}${LINK}`,
      `${LEAD}${LINK}\n\nIt expires in about 30 minutes.`,
    ]) {
      expect(holdPendingSetupLink(text)).toBe(text);
    }
  });

  test('holds a link on the line after a bold heading in the same paragraph', () => {
    withWindowOrigin('https://kortix.com');
    const heading = `${LEAD}📅 **Google Calendar (member level):**\n`;
    expect(holdPendingSetupLink(`${heading}[Authorize my Calendar](${URL.slice(0, 40)}`)).toBe(
      `${heading}[Authorize my Calendar](${pendingSetupLinkHref('connector')})`,
    );
  });

  test('a label that is itself the setup URL holds with no label, like the bare URL it becomes', () => {
    withWindowOrigin('https://kortix.com');
    expect(holdPendingSetupLink(`${LEAD}[https://kortix.com/secret-intake/ksl_A`)).toBe(
      `${LEAD}[](${pendingSetupLinkHref('secret')})`,
    );
  });

  test('ordinary links are never held', () => {
    withWindowOrigin('https://kortix.com');
    const text = `${LEAD}[the docs](https://kortix.com/docs/conn`;
    expect(holdPendingSetupLink(text)).toBe(text);
  });

  test('a label with brackets inside is left to the generic path', () => {
    withWindowOrigin('https://kortix.com');
    const text = `${LEAD}[a] b](https://kortix.com/connect/ksl_A`;
    expect(holdPendingSetupLink(text)).toBe(text);
  });
});
