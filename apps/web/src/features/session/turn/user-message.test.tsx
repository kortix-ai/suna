import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import { MentionChip, chipClass } from '@/features/session/mention-chip';
import type { MessageWithParts } from '@/ui';
import { useSessionStateStore } from '@kortix/sdk/react';

import enMessages from '../../../../translations/en.json';
import { adoptSentAttachmentPreviews } from '../sent-attachment-previews';
import { buildOptimisticPromptTextWithUploads, sentAttachmentsOf } from '../uploaded-file-refs';
import {
  MessageAttachments,
  UserMessage,
  UserMessageBubble,
  editablePromptText,
  normalizeAttachments,
} from './user-message';

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
    // The row's classes are composed (`cn`) since the queue controls joined
    // it (`alwaysVisible` for a failed send); the fade tokens are what matter.
    const fade = 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100';
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

  test('the reveal is desktop-only: under 768px the row is always visible', () => {
    // A touch screen has no hover, so without this the timestamp, Copy and
    // Edit-from-here sit at zero opacity for the whole session — present,
    // sized, and unreachable. Touch browsers also leave an emulated `:hover`
    // stuck on the last-tapped element, so the failure mode was not "never
    // shows" but "one arbitrary turn stays lit".
    //
    // `max-md` is Tailwind's `width < 48rem` = 768px, the same breakpoint
    // `useIsMobile` uses, so the CSS and the JS agree on what mobile is.
    const markup = render(false, stamped);
    expect(markup).toContain('max-md:opacity-100');

    // On the SAME element as the fade it overrides, not a nested wrapper.
    const row = markup.match(/class="[^"]*group-hover\/turn:opacity-100[^"]*"/)?.[0] ?? '';
    expect(row).toContain('opacity-0');
    expect(row).toContain('max-md:opacity-100');
  });
});

describe('UserMessage persisted attachments', () => {
  test('renders every persisted file part in order without losing the timestamp', () => {
    const persisted = {
      info: {
        id: 'message-files',
        role: 'user',
        time: { created: Date.parse('2026-09-01T18:58:54.410Z') },
      },
      parts: [
        {
          id: 'part-text',
          messageID: 'message-files',
          type: 'text',
          text: 'Inspect these files.',
        },
        {
          id: 'part-zip',
          messageID: 'message-files',
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
        {
          id: 'part-markdown',
          messageID: 'message-files',
          type: 'file',
          mime: 'text/markdown',
          filename: 'README.md',
          url: 'data:text/markdown;base64,IyBSRUFETUU=',
        },
        {
          id: 'part-png',
          messageID: 'message-files',
          type: 'file',
          mime: 'image/png',
          filename: 'shot.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ],
    } as MessageWithParts;

    const html = render(false, persisted);
    expect(html).toContain('bundle.zip');
    expect(html).toContain('README.md');
    expect(html).toContain('shot.png');
    expect(html.match(/rounded-md border/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/datetime="2026-09-01T18:58:54.410Z"/i);
    expect(html.indexOf('bundle.zip')).toBeLessThan(html.indexOf('README.md'));
    expect(html.indexOf('README.md')).toBeLessThan(html.indexOf('shot.png'));
  });

  // The 2026-09-04 incident, rendered. Two SVG logos plus a PDF used to reach
  // OpenCode as inline image parts; the SVGs failed to decode, `prompt_async`
  // threw, and NO message was written — so the transcript showed a spinner and
  // nothing else, text included. The SVGs now arrive as materialized `<file>`
  // references beside the still-native PDF, and all three must be visible with
  // the prompt text intact.
  test('renders the undecodable-image batch that used to delete the message', () => {
    const persisted = {
      info: {
        id: 'message-svg-batch',
        role: 'user',
        time: { created: Date.parse('2026-09-04T13:27:55.967Z') },
      },
      parts: [
        { id: 'p-text', messageID: 'message-svg-batch', type: 'text', text: 'HII' },
        {
          id: 'p-svg-1',
          messageID: 'message-svg-batch',
          type: 'text',
          text: '<file path="/workspace/uploads/.kortix-inbox/cmd/1-Jay Suthar.svg" mime="image/svg+xml" filename="Jay Suthar.svg">uploaded</file>',
        },
        {
          id: 'p-svg-2',
          messageID: 'message-svg-batch',
          type: 'text',
          text: '<file path="/workspace/uploads/.kortix-inbox/cmd/2-Jay Suthar@2x.svg" mime="image/svg+xml" filename="Jay Suthar@2x.svg">uploaded</file>',
        },
        {
          id: 'p-pdf',
          messageID: 'message-svg-batch',
          type: 'file',
          mime: 'application/pdf',
          filename: 'Account Settings _ Kortix Slack.pdf',
          url: 'data:application/pdf;base64,JVBERi0=',
        },
      ],
    } as MessageWithParts;

    const html = render(false, persisted);
    expect(html).toContain('HII');
    expect(html).toContain('Jay Suthar.svg');
    expect(html).toContain('Jay Suthar@2x.svg');
    expect(html).toContain('Account Settings _ Kortix Slack.pdf');
    // Raw XML must never leak into the bubble as text.
    expect(html).not.toContain('&lt;file path=');
    // Attached order is send order.
    expect(html.indexOf('Jay Suthar.svg')).toBeLessThan(html.indexOf('Jay Suthar@2x.svg'));
    expect(html.indexOf('Jay Suthar@2x.svg')).toBeLessThan(
      html.indexOf('Account Settings _ Kortix Slack.pdf'),
    );
  });

  // The runtime streams the text part first and the file parts seconds later.
  // The names the preview promised fill the gap as stable tiles, and the
  // strip says so — instead of blinking out (review finding, 2026-09-05: the
  // earlier fix held a SECOND bubble over this one).
  test('draws promised-but-unarrived files without restarting upload progress', () => {
    const streaming = {
      info: { id: 'message-streaming', role: 'user', time: { created: Date.parse('2026-09-05T22:00:00.000Z') } },
      parts: [
        { id: 'p-text', messageID: 'message-streaming', type: 'text', text: 'REPRO' },
        { id: 'p-png', messageID: 'message-streaming', type: 'file', mime: 'image/png', filename: 'tiny.png', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    } as MessageWithParts;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <UserMessage
            message={streaming}
            sessionId="s"
            ownsPlan={false}
            pendingAttachments={[
              { filename: 'tiny.png', mime: 'image/png' },
              { filename: 'logo.svg', mime: 'image/svg+xml' },
              { filename: 'doc.pdf', mime: 'application/pdf' },
            ]}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('REPRO');
    expect(html).toContain('logo.svg');
    expect(html).toContain('doc.pdf');
    // tiny.png arrived as a real part — it is drawn ONCE, not doubled by its name.
    expect(html.split('tiny.png').length - 1).toBe(
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
            <UserMessage message={streaming} sessionId="s" ownsPlan={false} />
          </NextIntlClientProvider>
        </QueryClientProvider>,
      ).split('tiny.png').length - 1,
    );
    expect(html).not.toContain('Uploading');
    expect(html).not.toContain('animate-spinner-orbit');
  });

  // The store swaps the optimistic copy for the runtime's echo and the parts
  // stream back in over ~176 ms; for those frames this message has NO parts.
  // Once the boot stand-in has stepped aside (a latch — see
  // `resolveFirstPromptHandover`), this component is the only thing on screen
  // for the prompt, so it draws what the sender knew: the text and the files.
  // Left to its own parts it blanked, and the stand-in popped back in front
  // at full opacity — "the same message twice, then it vanishes" (2026-09-06).
  test('keeps the bubble and the promised tiles through a frame with no parts', () => {
    const swapping = {
      info: { id: 'message-swapping', role: 'user', time: { created: Date.parse('2026-09-06T00:00:00.000Z') } },
      parts: [],
    } as unknown as MessageWithParts;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <UserMessage
            message={swapping}
            sessionId="s"
            ownsPlan={false}
            pendingText="FLICKER"
            pendingAttachments={[
              { filename: 'tiny.png', mime: 'image/png' },
              { filename: 'doc.pdf', mime: 'application/pdf' },
            ]}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('FLICKER');
    expect(html).toContain('tiny.png');
    expect(html).toContain('doc.pdf');
    expect(html).not.toContain('Uploading');
    expect(html).not.toContain('animate-spinner-orbit');
  });

  test('keeps workspace references before a later native file after reload', () => {
    const persisted = {
      info: {
        id: 'message-mixed-files',
        role: 'user',
        time: { created: Date.parse('2026-09-02T10:15:30.000Z') },
      },
      parts: [
        {
          id: 'part-reference-one',
          messageID: 'message-mixed-files',
          type: 'text',
          text: 'Review these files.\n<file path="/workspace/README.md" mime="text/markdown" filename="README.md">README.md</file>',
        },
        {
          id: 'part-reference-two',
          messageID: 'message-mixed-files',
          type: 'text',
          text: '<file path="/workspace/report.pdf" mime="application/pdf" filename="report.pdf">report.pdf</file>',
        },
        {
          id: 'part-native-image',
          messageID: 'message-mixed-files',
          type: 'file',
          mime: 'image/png',
          filename: 'shot.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ],
    } as MessageWithParts;

    const html = render(false, persisted);
    expect(html).toContain('Review these files.');
    expect(html).not.toContain('&lt;file path=');
    expect(html.indexOf('README.md')).toBeLessThan(html.indexOf('report.pdf'));
    expect(html.indexOf('report.pdf')).toBeLessThan(html.indexOf('shot.png'));
  });
});

describe('UserMessage renders the plan it owns', () => {
  /**
   * The plan card is the only surface left for session todos ON MOBILE:
   * `session-chat` drops every `todowrite` part before segmentation, and above
   * 768px it also nulls the anchor so the Easy panel's card draws instead
   * (`chatPlanAnchorId`, plan-anchor.test.ts). These tests pass `ownsPlan`
   * directly, so they pin the mobile path: if this component stops mounting
   * `PlanCard` when it owns the plan, a phone user's plan renders NOWHERE and
   * reads as "the agent never made a plan".
   *
   * Seeded through the query cache on the exact key the `todo.updated` SSE
   * handler writes (`['opencode','session-todo',<sessionID>]`), so the test
   * exercises the real data path rather than a prop.
   */
  const SESSION = 'ses_plan';

  const renderWithPlan = (ownsPlan: boolean, todos: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(['opencode', 'session-todo', SESSION], todos);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <TooltipProvider>
            <UserMessage message={message} sessionId={SESSION} ownsPlan={ownsPlan} />
          </TooltipProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  };

  const todos = [
    { content: 'Audit the worker registration', status: 'completed' },
    { content: 'Wire the retry budget', status: 'in_progress' },
    { content: 'Backfill the ledger', status: 'pending' },
  ];

  test('the owning turn shows the plan the agent wrote', () => {
    const markup = renderWithPlan(true, todos);
    // The closed disclosure renders no content children by design, so the full
    // list is not in static markup. What the collapsed card must say is where
    // the plan is: the step running right now, and the count.
    //
    // It used to say a literal ">Plan<" beside the count. That title is gone —
    // the trigger's subject IS the running step now, and the list below drops
    // that row so the sentence is not printed twice.
    expect(markup).toContain('Wire the retry budget');
    expect(markup).toContain('1 of 3');
    expect(markup.match(/Wire the retry budget/g)).toHaveLength(1);
    expect(markup).toContain('role="img"');
  });

  test('the whole checklist is one keyboard-reachable expand away', () => {
    const markup = renderWithPlan(true, todos);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-state="closed"');
  });

  test('a plan lifts the column cap so the checklist reads as a panel', () => {
    // Anchored to `self-end` — the ROOT column's own cap. The bubble inside it
    // also carries `max-w-full`, so a bare substring match would pass in both
    // directions and could never fail.
    expect(renderWithPlan(true, todos)).toContain('self-end max-w-full');
    expect(renderWithPlan(false, todos)).toContain('self-end max-w-[80%]');
    expect(renderWithPlan(false, todos)).not.toContain('self-end max-w-full');
  });

  test('a turn that does not own the plan draws no card', () => {
    const markup = renderWithPlan(false, todos);
    // The card ITSELF, not its content: the checklist body is behind a closed
    // disclosure in either case, so asserting on todo text proves nothing.
    expect(markup).not.toContain('group/plan');
    expect(markup).not.toContain('>Plan<');
  });

  test('an empty plan draws nothing, even on the owning turn', () => {
    const markup = renderWithPlan(true, []);
    expect(markup).not.toContain('group/plan');
    expect(markup).not.toContain('>Plan<');
    // …and the column keeps its cap, so a one-word message never stretches.
    expect(markup).toContain('self-end max-w-[80%]');
  });
});

describe('UserMessage inline edit-from-here editor', () => {
  const editProps = {
    editingText: 'do it differently',
    onEditCancel: () => {},
    onEditSend: () => {},
  };

  test('editing replaces the bubble with a textarea prefilled with the prompt text', () => {
    const markup = renderText('ship the thing', editProps);
    expect(markup).toContain('<textarea');
    expect(markup).toContain('aria-label="Edit message"');
    // The editor carries the CAPTURED prompt text, and the read-only bubble —
    // including the message's own text — is gone.
    expect(markup).toContain('do it differently');
    expect(markup).not.toContain('ship the thing');
  });

  test('the editor is the full column, not the 80% bubble rail', () => {
    const markup = renderText('ship the thing', editProps);
    expect(markup).not.toContain('max-w-[80%]');
  });

  test('the editor carries Cancel and Send, both live while idle', () => {
    const markup = renderText('ship the thing', editProps);
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Send');
    // `disabled=""` is the rendered ATTRIBUTE — the Button base classes carry
    // `disabled:` variants either way, so the bare word proves nothing.
    expect(markup).not.toContain('disabled=""');
  });

  test('pending holds both buttons', () => {
    const markup = renderText('ship the thing', { ...editProps, editPending: true });
    expect((markup.match(/disabled=""/g) ?? []).length).toBe(2);
  });

  test('editingText without handlers changes nothing — the bubble stays', () => {
    const markup = renderText('ship the thing', { editingText: 'do it differently' });
    expect(markup).not.toContain('<textarea');
    expect(markup).toContain('ship the thing');
  });
});

describe('sent attachment tiles', () => {
  const tiles = (html: string) => (html.match(/<li class="contents"/g) ?? []).length;
  const blobImages = (html: string, src: string) =>
    (html.match(new RegExp(`<img [^>]*src="${src}"`, 'g')) ?? []).length;

  function sentImage(uploadId: string, name: string, localUrl: string) {
    return {
      kind: 'local' as const,
      uploadId,
      file: new File(['x'], name, { type: 'image/png' }),
      localUrl,
      isImage: true,
    };
  }

  const renderMessage = (
    msg: MessageWithParts,
    props: Record<string, unknown> = {},
    messages: Record<string, unknown> = {},
  ) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <UserMessage message={msg} sessionId="session-1" ownsPlan={false} {...props} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  function expectFinishedTile(html: string) {
    expect(html).not.toContain('animate-spinner-orbit');
    expect(html).not.toContain('Uploading');
    expect(html).not.toContain('Upload failed');
    expect(html).not.toContain('role="status"');
  }

  test('a follow-up sent with an unfinished upload draws its picture from the first frame', () => {
    const file = sentImage('upload-follow', 'shot.png', 'blob:follow-up');
    adoptSentAttachmentPreviews([file]);
    const html = renderText(buildOptimisticPromptTextWithUploads('look', [file]));

    expect(tiles(html)).toBe(1);
    expect(blobImages(html, 'blob:follow-up')).toBe(1);
    expectFinishedTile(html);
  });

  // The picture tile is a preview button wrapping the tile. Both used to carry
  // `title=<filename>`, so one tile answered `[title="shot.png"]` twice and
  // release gate 35744913604 failed spec 28:528 on a strict-mode violation.
  test('a picture tile names its file once, on the tile', () => {
    const file = sentImage('upload-title', 'shot.png', 'blob:title');
    adoptSentAttachmentPreviews([file]);
    const html = renderText(buildOptimisticPromptTextWithUploads('look', [file]));

    expect(blobImages(html, 'blob:title')).toBe(1);
    expect(html.split('title="shot.png"').length - 1).toBe(1);
  });

  test('the echo reference keeps the sent picture while the sandbox read is still loading', () => {
    const file = sentImage('upload-echo', 'a.png', 'blob:echo');
    adoptSentAttachmentPreviews([file]);
    const html = renderMessage(
      {
        info: { id: 'message-echo', role: 'user' },
        parts: [
          { id: 'p-text', messageID: 'message-echo', type: 'text', text: 'look' },
          {
            id: 'p-ref',
            messageID: 'message-echo',
            type: 'text',
            text: '<file path="/workspace/uploads/.kortix-inbox/0-a.png" mime="image/png" filename="a.png">\nuploaded\n</file>',
          },
        ],
      } as MessageWithParts,
      { pendingAttachments: sentAttachmentsOf([file]) },
    );

    expect(tiles(html)).toBe(1);
    expect(blobImages(html, 'blob:echo')).toBe(1);
    expectFinishedTile(html);
  });

  test('a reload has no local bytes: the delivered image loading is one named tile, no spinner', () => {
    const html = renderMessage({
      info: { id: 'message-reload', role: 'user' },
      parts: [
        {
          id: 'p-ref',
          messageID: 'message-reload',
          type: 'text',
          text: 'look\n\n<file path="/workspace/uploads/.kortix-inbox/k/0-reload.png" mime="image/png" filename="reload.png">\nuploaded\n</file>',
        },
      ],
    } as MessageWithParts);

    expect(tiles(html)).toBe(1);
    expect(html).toContain('title="reload.png"');
    expect(html).not.toContain('<img');
    expectFinishedTile(html);
  });

  test('a delivered inline image with no sent picture paints on the first frame, not after a name tile', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const html = renderMessage({
      info: { id: 'message-inline', role: 'user' },
      parts: [
        { id: 'p-text', messageID: 'message-inline', type: 'text', text: 'look' },
        {
          id: 'p-png',
          messageID: 'message-inline',
          type: 'file',
          mime: 'image/png',
          url: png,
          filename: 'inline.png',
        },
        {
          id: 'p-heic',
          messageID: 'message-inline',
          type: 'file',
          mime: 'image/heic',
          url: 'data:image/heic;base64,AAAA',
          filename: 'shot.heic',
        },
      ],
    } as MessageWithParts);

    expect(tiles(html)).toBe(2);
    // The browser already holds these bytes: the picture is the first frame (session open, remount).
    expect(html.match(/<img [^>]*src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(1);
    // A HEIC echo may not decode in this browser: it stays the named tile until it does.
    expect(html).not.toContain('src="data:image/heic');
    expect(html).toContain('title="shot.heic"');
    expectFinishedTile(html);
  });

  test('sync store: the echo text part lands before the file part; the tile count stays 1 at every step', () => {
    const store = useSessionStateStore.getState();
    store.reset();
    const file = sentImage('upload-d8', 'a.png', 'blob:d8');
    adoptSentAttachmentPreviews([file]);
    const sent = sentAttachmentsOf([file]);
    const session = 'ses_d8';
    const id = 'msg_d8';

    store.optimisticAdd(session, { id, sessionID: session, role: 'user', time: {} } as never, [
      {
        id: 'prt_client',
        sessionID: session,
        messageID: id,
        type: 'text',
        text: buildOptimisticPromptTextWithUploads('look', [file]),
      },
    ] as never);
    store.markOptimisticDispatched(session, id);

    const frames: string[] = [];
    const frame = () =>
      frames.push(
        renderMessage(
          {
            info: { id, role: 'user' },
            parts: useSessionStateStore.getState().parts[id] ?? [],
          } as MessageWithParts,
          { pendingAttachments: sent },
        ),
      );

    frame();
    store.applyEvent({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: session,
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude' },
        },
      },
    } as never);
    frame();
    store.upsertPart(
      id,
      { id: 'prt_server_text', sessionID: session, messageID: id, type: 'text', text: 'look' } as never,
      session,
    );
    // The echo text replaced the optimistic text, refs and all.
    expect(useSessionStateStore.getState().parts[id]?.map((p) => p.id)).toEqual(['prt_server_text']);
    frame();
    store.upsertPart(
      id,
      {
        id: 'prt_server_file',
        sessionID: session,
        messageID: id,
        type: 'file',
        mime: 'image/png',
        filename: 'a.png',
        url: 'data:image/png;base64,iVBORw0KGgo=',
      } as never,
      session,
    );
    frame();

    expect(frames.map(tiles)).toEqual([1, 1, 1, 1]);
    for (const html of frames) {
      expect(blobImages(html, 'blob:d8')).toBe(1);
      expectFinishedTile(html);
    }
    store.reset();
  });

  test('a failed send with no files still reads "Couldn\'t send" with Retry; a sent message with no files draws no strip', () => {
    const failed = { state: 'failed' as const, message: 'checkConnection', onRetry: () => {} };
    const strip = (status?: typeof failed) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={enMessages} onError={() => {}}>
            <MessageAttachments attachments={[]} status={status} />
          </NextIntlClientProvider>
        </QueryClientProvider>,
      );

    const kept = strip(failed);
    expect(tiles(kept)).toBe(0);
    expect(kept).not.toContain('<ul');
    expect(kept).toContain('Couldn&#x27;t send');
    expect(kept).toMatch(/<button[^>]*type="button"[^>]*>Retry<\/button>/);
    expect(strip()).toBe('');

    // The text-only follow-up SessionChat keeps on screen draws it too.
    const message = renderText('just text', { uploadStatus: failed });
    expect(message).toContain('role="alert"');
    expect(message).toContain('checkConnection');
    expect(renderText('just text')).not.toContain('role="alert"');
  });

  test('a failed send keeps its tile and reads "Couldn\'t send" with Retry, never "Upload failed"', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={enMessages} onError={() => {}}>
          <MessageAttachments
            attachments={[
              {
                key: 'attachment:upload-f',
                id: 'upload-f',
                filename: 'f.pdf',
                mime: 'application/pdf',
              },
            ]}
            status={{ state: 'failed', onRetry: () => {} }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(tiles(html)).toBe(1);
    expect(html).toContain('Couldn&#x27;t send');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Retry<\/button>/);
    expect(html).not.toContain('Upload failed');
  });
});

test('saved attachments resolve before a sandbox path exists', () => {
  const ref = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
  expect(normalizeAttachments([], [{ path: '', filename: 'a.png', mime: 'image/png', attachment: ref }])[0].src).toBe(ref);
});

// A message can carry many `<reply_context>` quotes, each written at
// its position in the text. The bubble draws each quote where it was written,
// as the same left-rule blockquote the single leading quote always used.
describe('UserMessage renders N inline reply quotes at their positions', () => {
  const threeInterleaved =
    '<reply_context>quoted alpha</reply_context>\nreply to alpha\n' +
    '<reply_context>quoted bravo</reply_context>\nreply to bravo\n' +
    '<reply_context>quoted charlie</reply_context>\nreply to charlie';

  /** Positions of `needles` in `markup`, in the order given. */
  const positions = (markup: string, needles: string[]) => needles.map((n) => markup.indexOf(n));
  const blockquotes = (markup: string) =>
    markup.match(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/g) ?? [];

  test('three quotes render as three blockquotes, in order, between the reply texts', () => {
    const markup = renderText(threeInterleaved);
    const quotes = blockquotes(markup);
    expect(quotes).toHaveLength(3);
    expect(quotes[0]).toContain('quoted alpha');
    expect(quotes[1]).toContain('quoted bravo');
    expect(quotes[2]).toContain('quoted charlie');
    const order = positions(markup, [
      'quoted alpha',
      'reply to alpha',
      'quoted bravo',
      'reply to bravo',
      'quoted charlie',
      'reply to charlie',
    ]);
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No reply text is drawn INSIDE a quote.
    for (const quote of quotes) expect(quote).not.toContain('reply to');
  });

  test('a later quote never falls through to a system-notification card', () => {
    const markup = renderText(threeInterleaved);
    // The card labels itself with the humanized tag name ("Reply context").
    expect(markup).not.toContain('reply_context');
    expect(markup).not.toContain('Reply context');
  });

  test('every quote keeps the existing rule-not-card treatment', () => {
    for (const quote of blockquotes(renderText(threeInterleaved))) {
      expect(quote).toContain('border-border border-l-2 pl-2.5');
      expect(quote).toContain('text-muted-foreground line-clamp-2 text-sm leading-5');
    }
  });

  test('a legacy single leading quote still renders one quote above the reply', () => {
    const markup = renderText('<reply_context>the earlier line</reply_context>\n\nfix it');
    const quotes = blockquotes(markup);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toContain('the earlier line');
    expect(markup.indexOf('the earlier line')).toBeLessThan(markup.indexOf('fix it'));
  });

  test('quotes spread over two text parts each render once, in part order', () => {
    // Each part is parsed on its own, so its markers start at 0. Unless they
    // are re-numbered into the combined list, part 2's marker names part 1's
    // quote and the second quote is never drawn.
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <UserMessage
            message={
              {
                info: { id: 'message-1', role: 'user' },
                parts: [
                  {
                    id: 'part-1',
                    messageID: 'message-1',
                    type: 'text',
                    text: '<reply_context>quote in part one</reply_context>\nanswer one',
                  },
                  {
                    id: 'part-2',
                    messageID: 'message-1',
                    type: 'text',
                    text: '<reply_context>quote in part two</reply_context>\nanswer two',
                  },
                ],
              } as MessageWithParts
            }
            sessionId="session-1"
            ownsPlan={false}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const quotes = blockquotes(markup);
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toContain('quote in part one');
    expect(quotes[1]).toContain('quote in part two');
    const order = positions(markup, [
      'quote in part one',
      'answer one',
      'quote in part two',
      'answer two',
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('a mention written after a quote is still a chip', () => {
    const markup = renderText(
      '<reply_context>some passage</reply_context>\nopen @src/index.ts now',
    );
    expect(markup).toContain('aria-label="file mention: src/index.ts"');
  });

  test('a message that is only quotes still draws its bubble', () => {
    const markup = renderText(
      '<reply_context>only alpha</reply_context>\n<reply_context>only bravo</reply_context>',
    );
    const quotes = blockquotes(markup);
    expect(quotes).toHaveLength(2);
    expect(markup).toContain('bg-sidebar');
  });

  test('the quote is not inside the bold body-text run', () => {
    // The body text is `font-medium` + `whitespace-pre-wrap`. A quote nested
    // inside that run would inherit both and stop looking like the quote the
    // composer drew.
    const markup = renderText(threeInterleaved);
    const beforeFirstQuote = markup.slice(0, markup.indexOf('<blockquote'));
    const openRuns = (beforeFirstQuote.match(/<div class="[^"]*font-medium[^"]*"/g) ?? []).length;
    expect(openRuns).toBe(0);
  });
});

describe('editablePromptText (the inline edit textarea is plain text)', () => {
  test('drops every quote block and keeps the reply text in order', () => {
    expect(
      editablePromptText(
        '<reply_context>quoted alpha</reply_context>\nreply to alpha\n' +
          '<reply_context>quoted bravo</reply_context>\nreply to bravo',
      ),
    ).toBe('reply to alpha\nreply to bravo');
  });

  test('a message without quotes is unchanged', () => {
    expect(editablePromptText('ship the thing')).toBe('ship the thing');
  });
});

// Review fix: since Task 2 the composer serializes a quote node inside the
// command's args, so a `/command` message can carry quotes of its own.
describe('UserMessage renders reply quotes inside /command args', () => {
  const blockquotes = (markup: string) =>
    markup.match(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/g) ?? [];
  const quotedArgs = '<reply_context>quoted alpha</reply_context>\nlook at this';

  test('a quote after the chip is a blockquote, never literal XML, and is drawn once', () => {
    // The part text is the expanded template, which carries the same args —
    // and so the same quote. It must not be drawn a second time.
    const markup = renderText(`Review template.\n${quotedArgs}`, {
      commandInfo: { name: 'review', args: quotedArgs, split: { before: '', after: quotedArgs } },
    });
    expect(markup).not.toContain('reply_context');
    const quotes = blockquotes(markup);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toContain('quoted alpha');
    const order = ['aria-label="command: /review"', 'quoted alpha', 'look at this'].map((n) =>
      markup.indexOf(n),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('an inferred command (args only, no split) renders its quote too', () => {
    const markup = renderText('TEMPLATE BODY', {
      commandInfo: { name: 'review', args: quotedArgs },
    });
    expect(markup).not.toContain('reply_context');
    expect(blockquotes(markup)).toHaveLength(1);
  });

  test('a quote before the chip renders before it, and the args after it', () => {
    const markup = renderText('TEMPLATE BODY', {
      commandInfo: {
        name: 'review',
        args: '<reply_context>quoted before</reply_context> run it',
        split: { before: '<reply_context>quoted before</reply_context>', after: 'run it' },
      },
    });
    expect(markup).not.toContain('reply_context');
    const order = ['quoted before', 'aria-label="command: /review"', 'run it'].map((n) =>
      markup.indexOf(n),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('a command without quotes renders byte-identical markup to a command before quote support', () => {
    // Captured from the renderer before this change.
    const region = (markup: string) => {
      const start = markup.indexOf('<div id="message-1-text"');
      return markup.slice(start, markup.indexOf('</div>', start) + '</div>'.length);
    };
    const cases = [
      { name: 'webapp', args: 'explain to me', split: { before: 'explain', after: 'to me' } },
      { name: 'webapp', args: 'explain me this skill' },
      { name: 'webapp' },
      {
        name: 'review',
        args: 'look at @src/a.ts',
        split: { before: '', after: 'look at @src/a.ts' },
      },
    ];
    const expected = [
      '<div id="message-1-text" class="max-w-full min-w-0 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-text max-h-[200px] overflow-hidden"><span>explain </span><span aria-label="command: /webapp" class="rounded-sm border-[0.5px] px-1.5 py-[0.08rem] [overflow-wrap:anywhere] font-medium whitespace-nowrap align-baseline text-[0.95em] bg-primary/[0.08] text-foreground">/webapp</span> <span>to me</span></div>',
      '<div id="message-1-text" class="max-w-full min-w-0 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-text max-h-[200px] overflow-hidden"><span aria-label="command: /webapp" class="rounded-sm border-[0.5px] px-1.5 py-[0.08rem] [overflow-wrap:anywhere] font-medium whitespace-nowrap align-baseline text-[0.95em] bg-primary/[0.08] text-foreground">/webapp</span> <span>explain me this skill</span></div>',
      '<div id="message-1-text" class="max-w-full min-w-0 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-text max-h-[200px] overflow-hidden"><span aria-label="command: /webapp" class="rounded-sm border-[0.5px] px-1.5 py-[0.08rem] [overflow-wrap:anywhere] font-medium whitespace-nowrap align-baseline text-[0.95em] bg-primary/[0.08] text-foreground">/webapp</span></div>',
      '<div id="message-1-text" class="max-w-full min-w-0 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-text max-h-[200px] overflow-hidden"><span aria-label="command: /review" class="rounded-sm border-[0.5px] px-1.5 py-[0.08rem] [overflow-wrap:anywhere] font-medium whitespace-nowrap align-baseline text-[0.95em] bg-primary/[0.08] text-foreground">/review</span> <span>look at </span><button type="button" aria-label="file mention: src/a.ts" class="rounded-sm border-[0.5px] px-1.5 py-[0.08rem] [overflow-wrap:anywhere] font-medium whitespace-nowrap align-baseline text-[0.95em] bg-primary/[0.08] text-foreground cursor-pointer transition-colors duration-150 hover:bg-foreground/10 dark:hover:bg-foreground/10 active:scale-[0.97] active:transition-transform focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none">@src/a.ts</button></div>',
    ];
    cases.forEach((commandInfo, i) => {
      expect(region(renderText('TEMPLATE BODY', { commandInfo }))).toBe(expected[i]);
    });
  });
});

describe('editablePromptText for a /command', () => {
  test('drops quote blocks from the args the textarea starts from', () => {
    expect(
      editablePromptText('TEMPLATE BODY', {
        name: 'review',
        args: '<reply_context>quoted alpha</reply_context>\nlook at this',
      }),
    ).toBe('/review look at this');
  });

  test('a command without quotes is unchanged', () => {
    expect(editablePromptText('TEMPLATE BODY', { name: 'webapp', args: 'explain me' })).toBe(
      '/webapp explain me',
    );
    expect(editablePromptText('TEMPLATE BODY', { name: 'webapp' })).toBe('/webapp');
  });
});
