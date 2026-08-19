import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { Agent } from '@kortix/sdk/react';
import { COMPOSER_SHELL_CLASS } from './composer';
import { ComposerUnderbar } from './composer-underbar';

/**
 * Matrix row 18 — `TokenProgress` must render at EVERY viewport.
 *
 * A `hidden sm:flex` wrapper around it removed the ring below 640px, and with
 * it the only route to `SessionContextModal` (`session-chat.tsx`'s
 * `handleContextClick` has exactly one reference), so context usage and
 * compaction were unreachable on a phone.
 *
 * The ring, the attach button, and the agent picker moved OUT of
 * `ComposerToolbar` and into this row below the card, so the assertions moved
 * with them (this file was `composer-toolbar.test.tsx`). `Composer` itself
 * cannot be the mount point: it needs an `AuthProvider` for
 * `useRuntimeSessions`, which is why the row is its own component.
 *
 * These assert on the RENDERED MARKUP, never on this file's own source text —
 * a test that greps its own component for a class name would pass on a comment
 * and prove nothing. `renderToStaticMarkup` needs no jsdom and commits no
 * effects, which is the same shell `attachment-tiles.test.tsx` and
 * `projects/project-card.test.tsx` already use.
 */

const noop = () => {};

function render(props?: { noAccessibleAgents?: boolean; agents?: Agent[] }): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={noop}>
      {/* Both providers live higher up the tree in the app than this
          component: the row's own tooltips need one, and a descendant
          selector reads through TanStack Query. Neither needs a DOM. Retries
          off so nothing is scheduled by a render that is thrown away. */}
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TooltipProvider>
          <ComposerUnderbar
            onAttachClick={noop}
            agents={props?.agents ?? []}
            selectedAgent={props?.agents?.[0]?.name ?? null}
            agentSelectorLocked={false}
            noAccessibleAgents={props?.noAccessibleAgents}
            messages={[]}
            models={[]}
            selectedModel={null}
            onContextClick={noop}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/**
 * The `class` attribute of every element that is an ANCESTOR of the first
 * `<svg>` carrying the token-progress ring's marker class.
 *
 * Walks the raw markup with a tag depth counter rather than a DOM: push each
 * open tag's class onto a stack, pop on close, and snapshot the stack the
 * moment the marker element appears. Self-closing and void tags never nest, so
 * they are pushed and popped in one step.
 */
function ancestorClassesOf(html: string, marker: string): string[] {
  const stack: string[] = [];
  const tagRe = /<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/)?>/g;
  const voids = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'path', 'circle', 'source']);

  for (const m of html.matchAll(tagRe)) {
    const [, closing, tag, attrs, selfClosed] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const cls = /class="([^"]*)"/.exec(attrs ?? '')?.[1] ?? '';
    if (attrs?.includes(marker)) return [...stack];
    if (selfClosed || voids.has(tag.toLowerCase())) continue;
    stack.push(cls);
  }
  throw new Error(`marker ${marker} not found in rendered markup`);
}

describe('ComposerUnderbar — TokenProgress is visible at every viewport (matrix row 18)', () => {
  test('the token-progress ring is actually rendered', () => {
    // Guards the two assertions below: if the ring stopped rendering
    // altogether they would vacuously "find no hidden ancestor".
    expect(render()).toContain('data-slot="token-progress"');
  });

  test('no ancestor of the ring hides it below the sm breakpoint', () => {
    const ancestors = ancestorClassesOf(render(), 'data-slot="token-progress"');

    // The exact regression: a wrapper with `hidden sm:flex`. `hidden` is
    // display:none until the 640px breakpoint, so ANY unprefixed `hidden` on
    // an ancestor removes the control on a phone.
    const hiding = ancestors.filter((cls) => /(^|\s)hidden(\s|$)/.test(cls));
    expect(hiding).toEqual([]);
  });

  test('no ancestor of the ring carries a breakpoint-gated display class', () => {
    const ancestors = ancestorClassesOf(render(), 'data-slot="token-progress"');

    // Broader than the `hidden` check above: catches `sm:flex`, `md:block`,
    // `max-sm:hidden` and friends — any attempt to make this control's
    // presence depend on viewport width.
    const responsive = ancestors.filter((cls) =>
      /(^|\s)(max-)?(sm|md|lg|xl|2xl):(flex|block|inline|inline-flex|grid|hidden)(\s|$)/.test(cls),
    );
    expect(responsive).toEqual([]);
  });
});

describe('ComposerUnderbar — the attach control lives here, not in the card', () => {
  test('the attach button renders with its accessible name', () => {
    // `handleAttachClick` in composer.tsx opens the hidden <input type=file>;
    // this button is now its ONLY trigger outside drag-and-drop and paste.
    expect(render()).toContain('aria-label="Attach files"');
  });

  test('the row splits its two ends — brought-to-the-message left, cost right', () => {
    // `justify-between` is the whole layout contract: the ring is pinned to
    // the far right rather than trailing the attach button.
    const row = /<div class="([^"]*justify-between[^"]*)"/.exec(render())?.[1];
    expect(row).toBeDefined();
    expect(row).toContain('items-center');
  });
});

/**
 * Deny-by-default project agents: the roster can be legitimately EMPTY for a
 * `member` with no `iam_resource_grant`. Hiding the picker in that case (the
 * old `agents.length > 0` gate) left the composer looking entirely normal up
 * to the server's 403, so the empty roster now RENDERS — disabled, and saying
 * both what is wrong and what the user can do about it.
 */
describe('ComposerUnderbar — the agent picker is unconditional', () => {
  // The regression this replaces: the picker rendered only when the roster was
  // non-empty AND the host accepted a change. A member with no agent grant got
  // an empty roster, the control disappeared, and the composer looked entirely
  // normal while the prompt ran under the server's manifest `default_agent`.
  // Nothing may send until the agent that will run is on screen, so the control
  // that shows it cannot be conditional.

  function agentTrigger(html: string): string | undefined {
    // The picker's trigger is the only <button> in this row carrying the
    // rounded-lg pill chrome and no aria-label of its own (attach has one).
    return /<button(?![^>]*aria-label="Attach files")[^>]*rounded-lg[^>]*>/.exec(html)?.[0];
  }

  test('renders with a populated roster', () => {
    const html = render({ agents: [{ name: 'kortix', mode: 'primary' } as unknown as Agent] });
    expect(agentTrigger(html)).toBeDefined();
    expect(html).toContain('Kortix');
  });

  test('renders with an empty roster too', () => {
    // No hint: an empty list with nothing to say is the roster still loading.
    const html = render();
    expect(agentTrigger(html)).toBeDefined();
    expect(html).not.toContain('ask a manager for access');
  });

  test('renders with a DENIED roster', () => {
    expect(agentTrigger(render({ noAccessibleAgents: true }))).toBeDefined();
  });
});

/**
 * Deny-by-default project agents: the roster can be legitimately EMPTY for a
 * `member` with no `iam_resource_grant`. The state is carried by the control
 * looking inert — not by a banner, a wide pill, or an icon of its own. It must
 * be indistinguishable in SHAPE from the picker it replaces and from the model
 * picker beside it; only the words in the tooltip differ.
 */
describe('ComposerUnderbar — the denied roster looks like an ordinary picker', () => {
  function triggerClasses(html: string): string {
    const button = /<button(?![^>]*aria-label="Attach files")[^>]*rounded-lg[^>]*>/.exec(html)?.[0];
    return /class="([^"]*)"/.exec(button ?? '')?.[1] ?? '';
  }

  test('same chrome as the populated trigger, bar the muted text token', () => {
    // Everything Button contributes (variant ghost, size sm, radius, hit area)
    // must match; a bespoke shape here is the thing that read as "too much".
    const populated = triggerClasses(
      render({ agents: [{ name: 'kortix', mode: 'primary' } as unknown as Agent] }),
    );
    const denied = triggerClasses(render({ noAccessibleAgents: true }));

    expect(populated).not.toBe('');
    expect(denied.replace('text-muted-foreground', 'text-foreground/70')).toBe(populated);
  });

  test('keeps the caret, so it reads as a picker and not a notice', () => {
    // Two <svg> in this row when denied: the paperclip and the caret. The
    // populated state has the same two.
    const denied = render({ noAccessibleAgents: true });
    expect((denied.match(/<svg/g) ?? []).length).toBe(
      (
        render({ agents: [{ name: 'kortix', mode: 'primary' } as unknown as Agent] }).match(
          /<svg/g,
        ) ?? []
      ).length,
    );
  });

  test('says why in the tooltip, in one line', () => {
    const html = render({ noAccessibleAgents: true });
    expect(html).toContain('No agents available to you — ask a manager for access');
  });

  test('the trigger is actually disabled', () => {
    const html = render({ noAccessibleAgents: true });
    const button = /<button[^>]*aria-label="No agents available to you[^"]*"[^>]*>/.exec(html)?.[0];

    expect(button).toBeDefined();
    // The attribute, not the substring: every Button's class list carries
    // `disabled:pointer-events-none` whether it is disabled or not.
    expect(button).toMatch(/\sdisabled=""/);
  });

  test("the label is the picker's ordinary fallback, not a sentence", () => {
    // "Agent" — the same word the trigger shows before a roster resolves. The
    // rejected version put the whole refusal in the trigger, which spanned the
    // rail and read as a banner.
    const html = render({ noAccessibleAgents: true });
    expect(html).toContain('>Agent</span>');
    expect(html).not.toContain('>No agents available to you');
  });
});

/*
 * There is deliberately NO test pinning this row's horizontal padding to a
 * value. It is an optical figure tuned against the card above it, and a test
 * asserting `px-3` does not catch a bug — it just fails the next time someone
 * looks at the screen and nudges it, which trains people to edit the test
 * instead of reading it. The assertions worth having are the ones below and
 * above: the ring must exist, and nothing may hide it or zero the gutter.
 */

/**
 * The gutter bug this file was extended for. `px-2 sm:px-0` made the composer's
 * horizontal padding a function of the WINDOW width, while its actual width is
 * a function of the session layout — sidebar, action-panel column, and the
 * browser/terminal/files detail panel. With a panel open on a wide screen the
 * viewport was still `sm`, so the gutter went to zero and the card sat flush
 * against the panel divider; with everything closed `mx-auto` had slack to
 * donate and the same class looked fine. That is the "sometimes it pads,
 * sometimes it doesn't" report.
 *
 * Asserted on the exported constant rather than on this file's source text: a
 * regex over `composer.tsx` would pass on a comment mentioning `sm:px-0` and
 * fail on a reformat, and `Composer` itself cannot be rendered here (it needs
 * an `AuthProvider` for `useRuntimeSessions`). The constant is the single thing
 * the shell `<div>` reads, so editing it is the only way to reintroduce this.
 *
 * The line these draw is ZERO, not "responsive". A breakpoint that TRIMS the
 * gutter is a legitimate optical call — `md:pr-1` compensates for the
 * action-panel chevron rail on desktop, see `COMPOSER_SHELL_CLASS`'s comment —
 * and a test that banned every breakpoint would simply be deleted the next time
 * someone needs one. A breakpoint that zeroes it is the bug, every time.
 */
describe('COMPOSER_SHELL_CLASS — no viewport width can zero the gutter', () => {
  const classes = COMPOSER_SHELL_CLASS.split(/\s+/).filter(Boolean);

  test('carries an unconditional horizontal gutter', () => {
    // Unprefixed: it must hold at EVERY width, since the breakpoint cannot see
    // whether a panel has taken the column's width away.
    expect(classes.some((c) => /^px-[1-9]/.test(c))).toBe(true);
  });

  test('the base gutter matches the transcript so the card aligns with the messages', () => {
    // `session-chat.tsx` renders the message column as
    // `mx-auto w-full max-w-3xl min-w-0 px-4 py-6 pb-32`. Whenever the chat
    // column is narrower than either max-width — every panel-open case — both
    // are column-width, so equal gutters put them on the same rails.
    expect(classes).toContain('px-4');
  });

  test('no breakpoint sets any horizontal padding to 0', () => {
    // The original bug, in every spelling it could come back as: `sm:px-0`,
    // `md:pl-0`, `max-sm:pe-0`, `lg:pr-0`. Each one lets the card touch the
    // panel divider at exactly the widths where a panel is open.
    const zeroed = classes.filter((c) => /^(max-)?(sm|md|lg|xl|2xl):p([xlrse])?-0$/.test(c));
    expect(zeroed).toEqual([]);
  });

  test('a breakpoint may trim a side, never both sides at once', () => {
    // `md:pr-1` trims one edge against a known asymmetry in the layout (the
    // chevron rail). A breakpoint-scoped `px-*` overrides BOTH edges, which is
    // the shape that hid the whole gutter last time — if a future change needs
    // that, it needs a container query, not a media query.
    const bothSides = classes.filter((c) => /^(max-)?(sm|md|lg|xl|2xl):px-/.test(c));
    expect(bothSides).toEqual([]);
  });
});
