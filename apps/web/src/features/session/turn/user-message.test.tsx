import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { MentionChip, chipClass } from '@/features/session/mention-chip';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MessageWithParts } from '@/ui';

import { UserMessage, UserMessageBubble } from './user-message';

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

/** A user message carrying arbitrary text + the props under test. */
const renderText = (text: string, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <UserMessage
          message={
            {
              info: { id: 'message-1', role: 'user' },
              parts: [{ id: 'part-1', messageID: 'message-1', type: 'text', text }],
            } as MessageWithParts
          }
          sessionId="session-1"
          ownsPlan={false}
          {...props}
        />
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

describe('UserMessage renders the composer chip, not its own treatment', () => {
  // The whole point of `mention-chip.tsx`: whatever the composer draws, this
  // draws. Asserting against the live `chipClass()` (rather than a pasted class
  // string) is what makes these tests fail if the two ever diverge again.
  test('a file mention is a chip carrying the shared surface class', () => {
    const markup = renderText('open @src/index.ts now');
    expect(markup).toContain('aria-label="file mention: src/index.ts"');
    expect(markup).toContain(chipClass('file').split(' ')[0]);
    expect(markup).toContain('@src/index.ts');
    // The old treatment, gone: underlined text pretending to be a chip.
    expect(markup).not.toContain('decoration-foreground/30');
  });

  test('a known agent name renders as an agent chip, not bold text', () => {
    const markup = renderText('ask @build about it', { agentNames: ['build'] });
    expect(markup).toContain('aria-label="agent mention: build"');
  });

  test('an email address does not become a chip', () => {
    const markup = renderText('mail me at jay@kortix.com');
    expect(markup).not.toContain('aria-label="file mention: kortix.com"');
  });
});

describe('UserMessage renders a /command exactly as the composer does', () => {
  const commandProps = { commandInfo: { name: 'webapp', args: 'explain me this skill' } };

  test('the command is an inline chip with the command tint', () => {
    const markup = renderText('<expanded template body>', commandProps);
    expect(markup).toContain('aria-label="command: /webapp"');
    expect(markup).toContain('/webapp');
    // The command tint is the visual difference from a mention. Both halves
    // matter — see `chipClass`'s twMerge note.
    expect(markup).toContain('bg-primary/[0.08]');
  });

  test('the args are body text beside the chip, not a muted 12px sub-line', () => {
    const markup = renderText('<expanded template body>', commandProps);
    expect(markup).toContain('explain me this skill');
    // The old card's chrome, gone: bordered panel, terminal icon, mono name.
    expect(markup).not.toContain('bg-muted/40');
    expect(markup).not.toContain('font-mono text-sm');
  });

  test('the expanded template body is never shown — only the args are', () => {
    const markup = renderText('THE-WHOLE-TEMPLATE-FILE', commandProps);
    expect(markup).not.toContain('THE-WHOLE-TEMPLATE-FILE');
  });

  test('a command with no args renders the chip alone', () => {
    const markup = renderText('THE-WHOLE-TEMPLATE-FILE', {
      commandInfo: { name: 'webapp' },
    });
    expect(markup).toContain('aria-label="command: /webapp"');
    expect(markup).not.toContain('THE-WHOLE-TEMPLATE-FILE');
  });
});

/**
 * The deepest `<button>` nesting level reached anywhere in a markup string.
 * 1 is a normal control; 2 means one button lives inside another.
 */
function maxButtonDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const tag of html.match(/<button\b|<\/button>/g) ?? []) {
    if (tag === '</button>') depth -= 1;
    else max = Math.max(max, (depth += 1));
  }
  return max;
}

describe('UserMessageBubble — a clamped message is expandable without swallowing its chips', () => {
  // `canExpand` is a prop here for the reason stated on the component: it is
  // set by a ResizeObserver that never runs under `renderToStaticMarkup`, so
  // driving it through `UserMessage` would render the un-clamped branch and
  // these assertions could not fail.
  const renderBubble = (props: Partial<React.ComponentProps<typeof UserMessageBubble>> = {}) =>
    renderToStaticMarkup(
      <UserMessageBubble canExpand expanded={false} onToggle={() => {}} textId="m1-text" {...props}>
        <MentionChip kind="file" label="src/index.ts" onClick={() => {}} />
      </UserMessageBubble>,
    );

  test('the bubble itself is not a control, so the chips are not nested inside one', () => {
    // A `role="button"` + `tabIndex={0}` bubble wrapping `<button>` chips is
    // invalid: a button's subtree is flattened to its accessible name, so the
    // chips stop being reachable controls for assistive technology and the
    // bubble becomes a keyboard trap around them.
    const markup = renderBubble();
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('tabindex');
    expect(maxButtonDepth(markup)).toBe(1);
  });

  test('the expand affordance is a real button, named and stateful', () => {
    const collapsed = renderBubble();
    expect(collapsed).toContain('aria-label="Expand message"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-controls="m1-text"');

    const open = renderBubble({ expanded: true });
    expect(open).toContain('aria-label="Collapse message"');
    expect(open).toContain('aria-expanded="true"');
  });

  test('the toggle points at the region it actually expands', () => {
    // `aria-controls` is a promise that the id exists. Without the `id` on the
    // clamped text div it names nothing.
    const markup = renderBubble();
    expect(markup).toContain('id="m1-text"');
  });

  test('the chips stay independently focusable controls', () => {
    const markup = renderBubble();
    expect(markup).toContain('aria-label="file mention: src/index.ts"');
    // Two controls in the bubble: the chip and the expand toggle. Neither is
    // inside the other.
    expect(markup.match(/<button\b/g)?.length).toBe(2);
  });

  test('an unclamped bubble offers no expand control and no ARIA state at all', () => {
    const markup = renderBubble({ canExpand: false });
    expect(markup).not.toContain('aria-label="Expand message"');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).not.toContain('role="button"');
    // The chip is still the one and only control.
    expect(markup.match(/<button\b/g)?.length).toBe(1);
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
