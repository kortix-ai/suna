import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { MessageWithParts } from '@/ui';

import { UserMessage } from './user-message';

const message = {
  info: { id: 'message-1', role: 'user' },
  parts: [{ id: 'part-1', messageID: 'message-1', type: 'text', text: 'ship the thing' }],
} as MessageWithParts;

/** The same message, stamped. Wednesday 12 August 2026, 09:34 UTC. */
const stamped = {
  ...message,
  info: { ...message.info, time: { created: Date.UTC(2026, 7, 12, 9, 34) } },
} as MessageWithParts;

/** `TooltipProvider` because an enabled rewind renders `Hint`, and Radix's
 *  tooltip throws without a provider above it — the app root supplies one. */
const render = (rewindDisabled: boolean, msg: MessageWithParts = message) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <UserMessage
            message={msg}
            sessionId="session-1"
            ownsPlan={false}
            onRewind={() => {}}
            rewindDisabled={rewindDisabled}
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('UserMessage actions', () => {
  test('keeps copy available while rewind is disabled', () => {
    const markup = render(true);
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).not.toContain('aria-label="Edit message and rewind session"');
  });
});

/** The text inside the `<time>` element — not its `dateTime` attribute, which
 *  carries an ISO string full of digits and colons. */
const timeText = (markup: string) => markup.match(/<time[^>]*>([^<]*)<\/time>/)?.[1] ?? '';

describe('UserMessage timestamp', () => {
  test('shows when the message was sent', () => {
    const markup = render(false, stamped);
    expect(markup).toContain('<time');
    // Machine-readable value is UTC, so it is identical on both render passes.
    expect(markup).toContain('2026-08-12T09:34:00.000Z');
  });

  test('the visible label never carries a clock reading', () => {
    // "Yesterday 9:19 PM" is the shape this replaced: a phrase you have to
    // parse before it says anything. Time of day belongs in the hover label.
    const text = timeText(render(false, stamped));
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/AM|PM/);
  });

  test('server-renders the timezone-stable form, never a guess at the viewer’s clock', () => {
    // `renderToStaticMarkup` never runs effects and `useSyncExternalStore`
    // takes its SERVER snapshot, so this IS the markup the server emits and
    // the client must hydrate against. It is the dated form because the server
    // has no clock to measure distance from — a relative word here would mean
    // it had guessed, which is the hydration bug this avoids.
    const markup = render(false, stamped);
    expect(timeText(markup)).toBe('August 12, 2026');
    expect(timeText(markup)).not.toContain('ago');
  });

  test('the time is a tooltip on the label, not text beside it', () => {
    // Radix renders tooltip *content* only while open, so the clock string
    // cannot appear in static markup — `message-time.test.ts` covers what it
    // says. What is observable here is that the `<time>` element is wired as
    // the trigger, which is what puts the time one hover away.
    expect(render(false, stamped)).toMatch(/<time[^>]*data-state="closed"/);
  });

  test('renders no time element when the backend never stamped one', () => {
    // The unstamped fixture above is the shape real messages had before
    // `time.created` was populated — it must render, not throw or print NaN.
    const markup = render(false);
    expect(markup).not.toContain('<time');
    expect(markup).not.toContain('Invalid Date');
    expect(markup).not.toContain('NaN');
    // The rest of the turn is unaffected.
    expect(markup).toContain('ship the thing');
    expect(markup).toContain('aria-label="Copy code"');
  });

  test('the timestamp reveals with the actions, inside the same hover row', () => {
    const markup = render(false, stamped);
    const fade =
      'opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100';
    const fadeAt = markup.indexOf(fade);

    // The fading row OPENS before both, so both are inside it and reveal
    // together. If the fade slipped back onto an inner element, the timestamp
    // would sit outside it and these positions would invert.
    expect(fadeAt).toBeGreaterThan(-1);
    expect(markup.indexOf('<time')).toBeGreaterThan(fadeAt);
    expect(markup.indexOf('aria-label="Copy code"')).toBeGreaterThan(fadeAt);

    // Exactly one reveal — the row's. Nothing nested fades on its own.
    expect(markup.split('group-hover/turn:opacity-100').length - 1).toBe(1);
  });
});
