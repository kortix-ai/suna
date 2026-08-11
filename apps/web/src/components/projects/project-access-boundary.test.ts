import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  errorStatus,
  gateAction,
  gateCopyKeys,
  gateStateForError,
  gateStateForRequestResult,
  isForbiddenState,
  resolveGateState,
  shouldPollForApproval,
  type AccessGateState,
} from './project-access-boundary';

const componentSource = readFileSync(
  fileURLToPath(new URL('./project-access-boundary.tsx', import.meta.url)),
  'utf8',
);

const ALL_STATES: AccessGateState[] = [
  'request',
  'sent',
  'alreadyRequested',
  'notFound',
  'unavailable',
];

const LOCALES = ['en', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'zh'];

function copyBlock(locale: string): Record<string, string> {
  const path = fileURLToPath(new URL(`../../../translations/${locale}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')).hardcodedUi?.projectAccessBoundary ?? {};
}

const en = copyBlock('en');

/** The English the user actually reads on a given screen. */
function englishCopy(state: AccessGateState) {
  const keys = gateCopyKeys(state);
  return { heading: en[keys.heading], body: en[keys.body] };
}

describe('errorStatus', () => {
  test('reads the status off both SDK error shapes', () => {
    expect(errorStatus({ status: 403 })).toBe(403);
    expect(errorStatus({ response: { status: 404 } })).toBe(404);
    expect(errorStatus({ status: 403, response: { status: 500 } })).toBe(403);
  });

  test('returns undefined for errors that carry no status', () => {
    expect(errorStatus(new Error('network down'))).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
    expect(errorStatus(undefined)).toBeUndefined();
  });
});

describe('gateStateForError', () => {
  test('403 is the only status that offers the request form', () => {
    expect(gateStateForError({ status: 403 })).toBe('request');
    expect(gateStateForError({ response: { status: 403 } })).toBe('request');
  });

  test('404 reports the project as gone', () => {
    expect(gateStateForError({ status: 404 })).toBe('notFound');
  });

  test('never offers a form for a failure that asking cannot fix', () => {
    // A form on a 401 or a 500 would send a request that can only fail again,
    // so anything unrecognised has to land on `unavailable`.
    for (const status of [401, 402, 429, 500, 502, 503]) {
      expect(gateStateForError({ status })).toBe('unavailable');
    }
    expect(gateStateForError(new Error('offline'))).toBe('unavailable');
    expect(gateStateForError(null)).toBe('unavailable');
  });
});

describe('gateStateForRequestResult', () => {
  // Exhaustiveness is a compile-time guarantee, not a runtime one: the function
  // switches over RequestProjectAccessResult['status'] with no default, so a
  // fourth SDK status fails `tsc` here rather than falling through to null.
  test('distinguishes a new request from one that was already waiting', () => {
    // The previous screen collapsed these two, so a user with a pending request
    // was told "Request sent." again on every attempt.
    expect(gateStateForRequestResult('created')).toBe('sent');
    expect(gateStateForRequestResult('pending')).toBe('alreadyRequested');
  });

  test('returns null for already_has_access so the caller re-fetches the project', () => {
    expect(gateStateForRequestResult('already_has_access')).toBeNull();
  });
});

describe('shouldPollForApproval', () => {
  test('polls exactly the states whose copy promises the page self-opens', () => {
    expect(ALL_STATES.filter(shouldPollForApproval)).toEqual(['sent', 'alreadyRequested']);
  });
});

describe('gateAction', () => {
  test('every state gets an action — no screen is a dead end', () => {
    // Enumerated rather than spot-checked: the whole point is that no state
    // silently falls through to whatever the `else` branch happens to render.
    expect(ALL_STATES.map(gateAction)).toEqual(['request', 'recheck', 'recheck', 'leave', 'retry']);
  });

  test('a deleted project is never offered a retry', () => {
    // 404 is terminal. "Try again" there re-runs a request that can only 404
    // again, so the primary action has to be the way out instead.
    expect(gateAction('notFound')).toBe('leave');
    expect(gateAction('notFound')).not.toBe('retry');
  });

  test('only a transient failure offers a retry', () => {
    expect(ALL_STATES.filter((s) => gateAction(s) === 'retry')).toEqual(['unavailable']);
  });

  test('the recheck action lines up exactly with the states that poll', () => {
    // If these ever diverge, a screen either polls with no way to check now, or
    // shows "Check now" on a screen that is not waiting on anything.
    expect(ALL_STATES.filter((s) => gateAction(s) === 'recheck')).toEqual(
      ALL_STATES.filter(shouldPollForApproval),
    );
  });
});

describe('isForbiddenState', () => {
  test('covers exactly the three screens behind a 403', () => {
    expect(ALL_STATES.filter(isForbiddenState)).toEqual(['request', 'sent', 'alreadyRequested']);
  });

  test('a 404 or a transient failure is not a permission problem', () => {
    // This gates the account/project facts, the approval note, and the admin
    // escape hatch. Admin bypass re-fetches with a bypass header — it cannot
    // resurrect a deleted project or clear a 500, so offering it there is a
    // dead control.
    expect(isForbiddenState('notFound')).toBe(false);
    expect(isForbiddenState('unavailable')).toBe(false);
  });

  test('the admin escape hatch is gated on the 403 states, not just on the role', () => {
    expect(componentSource).toContain('const showAdminBypass = forbidden && !!adminRole?.isAdmin');
    expect(componentSource).toContain('{showAdminBypass ? (');
    // The bare role check was what leaked the control onto 404 and 500.
    expect(componentSource).not.toMatch(/\{adminRole\?\.isAdmin \? \(/);
  });
});

describe('resolveGateState', () => {
  test('a sent request survives every transient failure', () => {
    // The 15s poll runs unattended. If an expired JWT (401), a 500, or an
    // offline window could outrank the request, the user would come back to a
    // blank form and re-send something the manager already has.
    for (const transient of [
      gateStateForError({ status: 401 }),
      gateStateForError({ status: 500 }),
      gateStateForError(new Error('offline')),
      gateStateForError({ status: 403 }),
    ]) {
      expect(resolveGateState('sent', transient)).toBe('sent');
      expect(resolveGateState('alreadyRequested', transient)).toBe('alreadyRequested');
    }
  });

  test('a deleted project outranks a request that is still waiting', () => {
    // The opposite failure: without this, deleting the project mid-wait leaves
    // the user on "Waiting on approval." forever, polling something that is
    // gone. notFound is terminal — asking harder cannot bring it back.
    expect(resolveGateState('sent', 'notFound')).toBe('notFound');
    expect(resolveGateState('alreadyRequested', 'notFound')).toBe('notFound');
  });

  test('with no request in flight the error decides the screen', () => {
    expect(resolveGateState(null, 'request')).toBe('request');
    expect(resolveGateState(null, 'notFound')).toBe('notFound');
    expect(resolveGateState(null, 'unavailable')).toBe('unavailable');
  });

  test('falls back to the error screen rather than a form it cannot justify', () => {
    expect(resolveGateState(null, null)).toBe('unavailable');
  });
});

describe('polling lifecycle', () => {
  test('the poll stops as soon as the project becomes readable', () => {
    // This boundary wraps the project shell for the whole session, so a poll
    // that only checks `waiting` keeps calling getProject every 15s while the
    // user works. The guard must include the success case.
    expect(componentSource).toContain('const polling = !query.isSuccess && shouldPollForApproval');
    expect(componentSource).toMatch(/if \(!polling\) return;/);
  });

  test('the background poll never drives the user-facing pending state', () => {
    // `query.isFetching` is true for the automatic poll too, so binding the
    // button to it makes "Check now" disable itself every 15 seconds.
    expect(componentSource).not.toContain('rechecking={query.isFetching}');
    expect(componentSource).toContain('rechecking={manualRecheck}');
  });

  test('neither the note field nor the submit button is `disabled` while in flight', () => {
    // Disabling a focused element drops keyboard focus to <body>. The field
    // uses readOnly and the button uses aria-disabled + a guard in onSubmit.
    // The lookbehind matters: `aria-disabled={…}` contains `disabled={…}`.
    expect(componentSource).not.toMatch(/(?<!aria-)disabled=\{requestMutation\.isPending\}/);
    expect(componentSource).toContain('aria-disabled={requestMutation.isPending}');
    expect(componentSource).toContain('if (requestMutation.isPending) return;');
  });
});

describe('copy wiring', () => {
  test('every state resolves to real English copy', () => {
    for (const state of ALL_STATES) {
      const { heading, body } = englishCopy(state);
      expect(heading?.trim().length ?? 0).toBeGreaterThan(0);
      expect(body?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test('every locale carries every key this component renders', () => {
    // The component resolves keys at runtime, so a locale missing one renders
    // the raw key path to the user. next-intl's `raw()` does not throw on a
    // miss, so nothing else in the repo catches this.
    //
    // The key list is READ OUT OF THE COMPONENT, not hand-maintained here: a
    // literal `t.raw('projectAccessBoundary.x')` is scraped by regex, and the
    // template-literal call sites are covered by gateCopyKeys.
    const used = new Set<string>();
    for (const match of componentSource.matchAll(/projectAccessBoundary\.(\w+)/g)) {
      used.add(match[1]);
    }
    for (const state of ALL_STATES) {
      const keys = gateCopyKeys(state);
      used.add(keys.heading).add(keys.body);
    }
    // Sanity-check the scrape itself, so a refactor that stops matching the
    // regex fails loudly instead of silently testing an empty set.
    expect(used.size).toBeGreaterThanOrEqual(18);

    for (const locale of LOCALES) {
      const block = copyBlock(locale);
      const missing = [...used].filter((key) => !block[key]?.trim());
      expect({ locale, missing }).toEqual({ locale, missing: [] });
    }
  });

  test('non-English locales are actually translated, not English copies', () => {
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const block = copyBlock(locale);
      const untranslated = ALL_STATES.map((state) => gateCopyKeys(state).heading)
        .filter((key, i, all) => all.indexOf(key) === i)
        .filter((key) => block[key] === en[key]);
      expect({ locale, untranslated }).toEqual({ locale, untranslated: [] });
    }
  });
});

describe('copy quality', () => {
  test('the heading never restates the description', () => {
    // The old screen said the same thing three times over one form: an eyebrow,
    // a hero headline, and a panel title. This dialect has no eyebrow at all,
    // so the only way to regress is a description that repeats the heading.
    for (const state of ALL_STATES) {
      const { heading, body } = englishCopy(state);
      const stem = heading.replace(/[.!]$/, '').toLowerCase();
      expect(body.toLowerCase()).not.toContain(stem);
    }
  });

  test('every heading is one sentence that fits two lines of the column', () => {
    // StepHeader renders the title at text-2xl (24px) font-medium inside
    // AuthFrame's 380px column (the px-6 gutter sits outside it). At ~0.5em
    // average advance that is ~12px per glyph, so ~31 characters per line and
    // ~62 over two. Capped at 56 for margin. An estimate, but a reproducible
    // one, and the longest shipped translation has real headroom under it.
    //
    // ja/zh are excluded from the character cap, not the punctuation check: a
    // full-width glyph is roughly double the advance, so counting characters
    // says nothing useful about how wide the line renders.
    const headingKeys = [...new Set(ALL_STATES.map((state) => gateCopyKeys(state).heading))];
    for (const locale of LOCALES) {
      const block = copyBlock(locale);
      for (const key of headingKeys) {
        expect(block[key]).toMatch(/[.!。！]$/);
        if (locale === 'ja' || locale === 'zh') continue;
        expect({ locale, key, length: block[key].length }).toEqual({
          locale,
          key,
          length: Math.min(block[key].length, 56),
        });
      }
    }
  });

  test('no internal navigation paths or product jargon reach the user', () => {
    // "Customize → Members" and "dosco workspace" both shipped in the previous
    // copy. Neither means anything to someone who cannot open the project.
    const banned = [
      /customize/i,
      /workspace/i,
      /→/,
      /viewer/i,
      /endpoint/i,
      /\b403\b/,
      /boundary/i,
    ];
    for (const state of ALL_STATES) {
      const { heading, body } = englishCopy(state);
      const text = `${heading} ${body}`;
      for (const pattern of banned) {
        expect({ state, text: text.match(pattern)?.[0] ?? null }).toEqual({ state, text: null });
      }
    }
  });

  test('only the polling states claim the page opens by itself', () => {
    // Guard both ways, so rewording the promise out of the copy fails the test
    // rather than silently making it pass.
    const claims = ALL_STATES.filter((state) =>
      /on its own|automatically/.test(englishCopy(state).body),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const state of claims) expect(shouldPollForApproval(state)).toBe(true);
  });

  test('the two waiting states share a heading but not a reason', () => {
    // Sharing the heading key keeps the header still when a duplicate request
    // resolves to `pending` instead of `created`; the description carries the
    // difference between "we just sent it" and "you already asked".
    expect(gateCopyKeys('sent').heading).toBe(gateCopyKeys('alreadyRequested').heading);
    expect(gateCopyKeys('sent').body).not.toBe(gateCopyKeys('alreadyRequested').body);
    expect(englishCopy('sent').body).not.toBe(englishCopy('alreadyRequested').body);
  });
});

describe('house dialect', () => {
  // This screen sits beside /auth, /cli/authorize and /oauth/authorize. It must
  // be composed from their shared vocabulary, not from a bespoke frame — that
  // is the whole reason the previous split-hero version looked foreign.
  test('is built from the shared auth consent primitives', () => {
    expect(componentSource).toContain("from '@/features/auth/auth-card-shell'");
    expect(componentSource).toContain("from '@/features/auth/auth-consent'");
    expect(componentSource).toContain("from '@/features/auth/auth-primitives'");
    for (const primitive of [
      '<AuthFrame>',
      '<StepHeader',
      '<DetailPanel>',
      '<ErrorStrip ',
      '<Rise',
    ]) {
      expect({ primitive, present: componentSource.includes(primitive) }).toEqual({
        primitive,
        present: true,
      });
    }
    // The quiet spinner every other auth sub-surface shows while it resolves.
    expect(componentSource).toContain('<AuthPendingScreen ');
  });

  test('does not re-introduce a bespoke frame, card or wallpaper', () => {
    // The auth dialect is flat on the plain background. A card, a wallpaper or
    // a backdrop-blur here is the exact drift this screen was rebuilt to undo.
    for (const banned of [
      'WallpaperBackground',
      'backdrop-blur',
      'rounded-2xl',
      'fixed inset-0',
      'KortixHyperLogo',
      'InfoBanner',
    ]) {
      expect({ banned, present: componentSource.includes(banned) }).toEqual({
        banned,
        present: false,
      });
    }
  });

  test('uses no raw Tailwind palette colours', () => {
    // kortix-* tokens and semantic tokens only.
    const palette =
      /(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;
    expect(componentSource.match(palette)?.[0] ?? null).toBeNull();
  });

  test('never uses an icon as a spinner', () => {
    // `Loading` is the codebase's only spinner.
    expect(componentSource).toContain("import Loading from '@/components/ui/loading'");
    expect(componentSource.match(/CircleNotch|SpinnerIcon|animate-spin/)?.[0] ?? null).toBeNull();
  });
});
