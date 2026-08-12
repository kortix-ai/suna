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

describe('UserMessage timestamp', () => {
  test('shows when the message was sent', () => {
    const markup = render(false, stamped);
    expect(markup).toContain('<time');
    // Machine-readable value is UTC, so it is identical on both render passes.
    expect(markup).toContain('2026-08-12T09:34:00.000Z');
  });

  test('server-renders the timezone-stable form, never a guess at the viewer’s day', () => {
    // `renderToStaticMarkup` never runs effects, so this IS the markup the
    // server emits and the client must hydrate against. It carries the full
    // UTC date because the server cannot know the viewer's zone or their
    // "today" — resolving both is the effect's job. A relative word here would
    // mean the server had guessed, which is the hydration bug this avoids.
    const markup = render(false, stamped);
    expect(markup).toContain('>Aug 12, 2026, 9:34 AM</time>');
    expect(markup).not.toContain('Yesterday');
  });

  test('spells the instant out on hover', () => {
    expect(render(false, stamped)).toContain('title="Wednesday, August 12, 2026 at');
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

  test('the meta row keeps the actions, so hovering never reflows the turn', () => {
    // Timestamp and actions share ONE row; the actions fade via opacity rather
    // than mounting, so the row's height is the same hovered or not.
    const markup = render(false, stamped);
    const row = markup.slice(markup.indexOf('<time'));
    expect(row).toContain('aria-label="Copy code"');
    expect(row).toContain('opacity-0');
    expect(row).toContain('group-hover/turn:opacity-100');
  });
});
