import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OutcomeCard } from './outcome-card';
import type { Outcome } from './outcome-types';

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    id: 'cr:1',
    kind: 'change_request',
    // The real shape `changeRequestOutcomes` now produces: the agent's own
    // words as the title, the reference in `meta`, nothing repeated.
    title: 'Add rate limiting',
    description: 'Adds a token bucket to the public API.',
    status: { label: 'Waiting for you', tone: 'warning' },
    at: 1_700_000_000_000,
    meta: ['Change request #12'],
    action: { label: 'Review', intent: 'open' },
    resourceHref: '?cr=cr_1',
    ...over,
  };
}

const html = (o: Outcome, index = 0) =>
  renderToStaticMarkup(<OutcomeCard outcome={o} index={index} onOpen={() => {}} />);

describe('content', () => {
  test('renders the title alone, then the reference and status in one quiet line', () => {
    const out = html(outcome());
    expect(out).toContain('Change request #12 · Waiting for you');
    // The description is NOT on the card. It restated the title, and the detail
    // belongs in the modal, which has room for it.
    expect(out).not.toContain('Adds a token bucket to the public API.');
  });

  test('the status is plain text, never a chip', () => {
    // A boxed uppercase mono badge was the loudest thing in a row meant to be
    // scanned. The tinted ring already carries urgency in colour.
    const out = html(outcome());
    expect(out).not.toContain('data-slot="badge"');
    expect(out).not.toContain('WAITING FOR YOU');
  });

  test('meta and status join with a middot', () => {
    expect(html(outcome())).toContain('Change request #12 · Waiting for you');
  });

  test('an empty meta list renders the status alone, with no leading separator', () => {
    // No title override needed any more: the title no longer carries its own
    // middot now that the reference moved to `meta`. That confound was itself a
    // symptom of the duplication this redesign removed.
    const out = html(outcome({ meta: [] }));
    expect(out).toContain('Waiting for you');
    expect(out).not.toContain('·');
  });

  test('a long title is truncated rather than wrapping the row', () => {
    expect(html(outcome({ title: 'x'.repeat(200) }))).toContain('…');
  });

  test('a card carries a stable testid keyed by kind, for the browser journey', () => {
    expect(html(outcome())).toContain('data-testid="outcome-card-change_request"');
  });
});

describe('Kortix visual contract', () => {
  // Each of these is a rule from changes-view.tsx. A regression here is a
  // brand regression, which is why they are pinned rather than eyeballed.
  test('the status colour lives in the tinted tile', () => {
    expect(html(outcome())).toContain('bg-kortix-orange/15');
    expect(html(outcome({ status: { label: 'Applied', tone: 'success' } }))).toContain(
      'bg-kortix-green/15',
    );
  });

  test('the status chip stays neutral — no raw palette badge variant', () => {
    const out = html(outcome());
    expect(out).not.toContain('emerald-');
    expect(out).not.toContain('amber-');
  });

  test('the tile is size-9 rounded-sm inside a rounded-md row — concentric', () => {
    const out = html(outcome());
    expect(out).toContain('size-9');
    expect(out).toContain('rounded-sm');
    expect(out).toContain('rounded-md');
  });

  test('the action button carries press feedback', () => {
    expect(html(outcome())).toContain('active:scale-[0.96]');
  });

  test('rows stagger their enter, capped so a long footer never crawls', () => {
    expect(html(outcome(), 0)).toContain('animation-delay:0ms');
    expect(html(outcome(), 3)).toContain('animation-delay:120ms');
    expect(html(outcome(), 40)).toContain('animation-delay:320ms'); // capped at index 8
  });

  test('the tile carries a ring in its tone, not just a fill', () => {
    // Jay's design revision: the tinted tile gained `ring-1` plus a per-tone
    // ring colour, so it reads as an object rather than a colour wash. The
    // ring is part of the tone contract now — `outcomeTint` returns it.
    const out = html(outcome());
    expect(out).toContain('ring-1');
    expect(out).toContain('ring-kortix-orange');
    expect(html(outcome({ status: { label: 'Applied', tone: 'success' } }))).toContain(
      'ring-kortix-green',
    );
  });
});

describe('actions', () => {
  test('an `open` action is a button — it mounts a modal, it does not navigate', () => {
    const out = html(outcome());
    expect(out).toContain('<button');
    expect(out).not.toContain('href="?cr=cr_1"');
  });

  test('a `link` action is an anchor that opens in a new tab, safely', () => {
    const out = html(
      outcome({
        kind: 'external',
        action: { label: 'Open in GitHub', intent: 'link', href: 'https://github.com/a/b/pull/1' },
      }),
    );
    expect(out).toContain('href="https://github.com/a/b/pull/1"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });
});
