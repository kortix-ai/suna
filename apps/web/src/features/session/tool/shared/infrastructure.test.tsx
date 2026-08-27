import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BasicTool,
  BoundActivateContext,
  RawOutputBlock,
  shouldShowToolPartInActionsPanel,
  ToolCodeCard,
  ToolOutcomeContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';

// ─── Task 16 (Phase 6, spec W11/D13) — the panel surface is disclosure rows ──
//
// REWRITTEN CONTRACT. What these tests used to pin — a sticky `px-4 pt-4 pb-3`
// header with an `<h3>` title and an always-rendered `p-4` body — is gone on
// purpose, not by accident. A detail routinely holds several tool calls, and
// that layout gave each one its own page header: N titles, N padded bodies,
// everything open, nothing skimmable.
//
// The contract now: the panel surface renders ONE `bg-popover rounded-md
// border` disclosure row per call —
//   • trigger row: `flex items-center gap-2.5 px-3 py-2.5 min-h-11`, leading
//     `size-4` icon (replaced by the outcome glyph when the call failed), title
//     `text-sm font-medium truncate`, mono `text-xs` subtitle, then the badge
//     and a `CaretRightIcon` that rotates 90° when open;
//   • body: `border-t px-3 py-3 text-sm`, inside a `DisclosureContent` that
//     animates `height: 0 → auto` — the payload is mounted only while open;
//   • open state: seeded by `defaultOpen`/`forceOpen`, held open by `locked`,
//     driven by the same `useState` the inline surface uses — the branch used
//     to compute that state and then ignore it entirely;
//   • a childless call is not a control: no chevron, no `role="button"`.
//
// `show`/`show_user` never reach this branch (they bypass `BasicTool` on the
// panel — see `show-tool.tsx`'s `if (fill) return body`), so their fill-the-pane
// rendering and its pinned tests are untouched by any of this.
function renderPanel(node: ReactNode) {
  return renderToStaticMarkup(
    <ToolSurfaceContext.Provider value="panel">{node}</ToolSurfaceContext.Provider>,
  );
}

describe('BasicTool panel surface — the disclosure row', () => {
  test('a closed row is one line: card, trigger, chevron — and no body', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Searched memory', subtitle: 'pricing notes' }}>
        <div>the payload</div>
      </BasicTool>,
    );

    // The design-system panel row, not a pane-wide sticky header.
    expect(html).toContain('bg-popover border-border overflow-hidden rounded-md border');
    expect(html).not.toContain('sticky');
    expect(html).not.toContain('pt-4');
    expect(html).not.toContain('pb-3');

    // Trigger anatomy.
    expect(html).toContain('flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left');
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('>Searched memory</span>');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('text-muted-foreground min-w-0 truncate font-mono text-xs');

    // Closed by default, and the body is genuinely absent — not merely hidden.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain('the payload');

    // The chevron is present and unrotated.
    expect(html).toContain('transition-transform');
    expect(html).not.toContain('rotate-90');
  });

  test('defaultOpen seeds the row open — body, rotated chevron, aria-expanded', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Searched memory' }} defaultOpen>
        <div>the payload</div>
      </BasicTool>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('rotate-90');
    expect(html).toContain('the payload');
    // Body chrome: a seam under the trigger, the row's own padding — never the
    // old `p-4` pane body.
    expect(html).toContain('border-border border-t px-3 py-3 text-sm');
  });

  test('forceOpen opens the row on its FIRST render, not a frame later', () => {
    // A permission/question prompt sets `forceOpen`, and the row it belongs to
    // is exactly the row the reader is being asked about. Seeded state, not
    // only the effect: `renderToStaticMarkup` runs no effects, so a row that
    // relied on the effect alone would render closed here — which is precisely
    // the frame of wrong answer a real browser used to paint too.
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Ran command' }} forceOpen>
        <div>awaiting approval</div>
      </BasicTool>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('awaiting approval');
  });

  test('a locked row still opens — locked refuses the CLOSE, it is not a lock-out', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Ran command' }} defaultOpen locked>
        <div>awaiting approval</div>
      </BasicTool>,
    );

    // The trigger is still a real control (keyboard + aria come from
    // DisclosureTrigger), but the pointer affordance is gone because the click
    // cannot close it.
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('cursor-pointer');
  });

  test('a childless call is a plain row, not a control that does nothing', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Workspace', subtitle: 'kortix-web' }} />,
    );

    expect(html).toContain('Workspace');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('cursor-pointer');
    // No chevron: the only thing that draws one is a body worth disclosing.
    expect(html).not.toContain('transition-transform');
  });

  test('a failed call leads with the verdict glyph instead of its own icon', () => {
    const html = renderPanel(
      <ToolOutcomeContext.Provider value="failed">
        <BasicTool icon={<span data-testid="tool-icon" />} trigger={{ title: 'Fetched page' }}>
          <div>body</div>
        </BasicTool>
      </ToolOutcomeContext.Provider>,
    );

    // The same substitution the inline header makes, from the same context —
    // the panel used to draw business-as-usual chrome for a failed call.
    expect(html).toContain('aria-label="This step failed"');
    expect(html).toContain('data-tone="failed"');
    expect(html).not.toContain('data-testid="tool-icon"');
  });

  test('an ok call keeps its own icon in the leading slot', () => {
    const html = renderPanel(
      <BasicTool icon={<span data-testid="tool-icon" />} trigger={{ title: 'Fetched page' }}>
        <div>body</div>
      </BasicTool>,
    );

    expect(html).toContain('data-testid="tool-icon"');
    expect(html).not.toContain('aria-label="This step failed"');
  });

  test('a JSX-node trigger occupies the row title slot, badge and chevron beside it', () => {
    const html = renderPanel(
      <BasicTool trigger={<span>Generating slides</span>} badge="4 slides">
        <div>body</div>
      </BasicTool>,
    );

    expect(html).toContain('Generating slides');
    expect(html).toContain('min-w-0 flex-1 truncate text-sm font-medium');
    expect(html).toContain('text-muted-foreground/60 shrink-0 font-mono text-xs');
    expect(html).toContain('4 slides');
    // Still a row, not the old sticky header.
    expect(html).not.toContain('sticky');
    expect(html).not.toContain('items-start justify-between gap-3');
  });
});

// ─── Phase 6 gate, finding 1 (BLOCKER) — the title is not the part that loses ─
//
// Title and subtitle are flex siblings. Both used to be plain `min-w-0
// truncate`, which gives flexbox no shrink priority at all: it takes the
// overflow out of both IN PROPORTION TO THEIR CONTENT, so the longer one wins.
// A 420px panel row therefore rendered the `testing` skill as `t…` next to 28
// characters of its own description, and `mcp__linear__create_issue` as `C..`.
// The name is the only thing a CLOSED row exists to say.
//
// Anchored to the emitted span, not to `toContain` on the whole document: a
// bare class-name search passes on any element in the tree, including the
// subtitle's.
function spanAround(html: string, text: string): string {
  const close = html.indexOf(`>${text}</span>`);
  if (close < 0) return '';
  return html.slice(html.lastIndexOf('<span', close), close + 1);
}

describe('the panel row title has shrink priority (gate finding 1)', () => {
  const LONG_SUBTITLE =
    'Use for every Kortix test task, behavior change, bug fix, refactor, or API route change';

  test('a SHORT title beside a long subtitle keeps its own width', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'testing', subtitle: LONG_SUBTITLE }}>
        <div>body</div>
      </BasicTool>,
    );

    const title = spanAround(html, 'testing');
    expect(title).not.toBe('');
    // `shrink-0` is the fix: the title is no longer in the proportional
    // shrink pool the subtitle dominates.
    expect(title).toContain('shrink-0');
    // …and `max-w-[60%]` is the other half — see below.
    expect(title).toContain('max-w-[60%]');
    // It still ellipsises rather than clipping mid-word.
    expect(title).toContain('truncate');
  });

  test('the subtitle is the one that yields — it keeps shrinking, the title does not', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'testing', subtitle: LONG_SUBTITLE }}>
        <div>body</div>
      </BasicTool>,
    );

    const subtitle = spanAround(html, LONG_SUBTITLE);
    expect(subtitle).not.toBe('');
    expect(subtitle).toContain('min-w-0');
    expect(subtitle).toContain('truncate');
    // The one class that would make the subtitle rigid and re-open the bug
    // from the other side.
    expect(subtitle).not.toContain('shrink-0');
  });

  test('a genuinely long title is capped, not rigid — it cannot push the subtitle off', () => {
    // `shrink-0` ALONE would be the same failure mirrored: a sentence-length
    // title would take the whole row and leave the subtitle nothing. The cap
    // is what stops it, so it is asserted as its own case.
    const html = renderPanel(
      <BasicTool
        trigger={{
          title: 'Run the whole session test suite against the deployed staging API',
          subtitle: 'apps/web',
        }}
      >
        <div>body</div>
      </BasicTool>,
    );

    const title = spanAround(
      html,
      'Run the whole session test suite against the deployed staging API',
    );
    expect(title).toContain('max-w-[60%]');
    expect(title).toContain('truncate');
    // The subtitle is still in the markup — the row did not lose it.
    expect(html).toContain('>apps/web</span>');
  });
});

// ─── Task 19 (Phase 6, spec W11/D16) — ONE block rhythm ─────────────────────
//
// Three bordered cards can sit under the SAME expanded row, and each one used
// to answer the geometry questions differently: `ToolOutputCard` indented 28px
// and capped at 288px, `ToolResultCard` indented 28px and capped at 304px,
// `ToolCodeCard` indented 22px and capped at 384px — so a `read` and a `memory`
// row in one turn drew their cards on two different left edges. The law now:
//
//   • frame  — `bg-popover border-border rounded-md border`;
//   • seam + indent — `mt-1.5` and the shared `--tool-indent` variable (22px),
//              gated TOGETHER on the inline surface. On the panel the card is
//              the disclosure body, which already brings `px-3 py-3`; a seam
//              there is double-spacing (18px top over 12px bottom);
//   • cap    — `max-h-96`, one value (bash's 64/80 panes are the stated
//              exception and are pinned in `bash-tool.test.tsx`);
//   • reserve — `pr-11` wherever a copy button floats over the body.
//
// Class strings are the contract because geometry is all there is to assert.
const INDENT = 'ml-[var(--tool-indent,1.375rem)]';

describe('the bordered tool cards share one rhythm', () => {
  const inline = (node: ReactNode) => renderToStaticMarkup(node);

  test('ToolOutputCard: 22px indent, max-h-96, pr-11 reserve', () => {
    const html = inline(<RawOutputBlock output={'plain log line\n'.repeat(4)} />);

    expect(html).toContain('max-h-96 overflow-auto p-3 pr-11');
    expect(html).toContain(INDENT);
    expect(html).toContain('mt-1.5');
    // The three values it used to carry alone.
    expect(html).not.toContain('ml-7');
    expect(html).not.toContain('max-h-72');
    expect(html).not.toContain('pr-9');
  });

  test('ToolCodeCard: the same reserve — CopyOverlay pins its button at right-3', () => {
    const html = inline(<ToolCodeCard code="const a = 1;" language="ts" />);

    expect(html).toContain('max-h-96 overflow-auto p-3 pr-11');
    expect(html).toContain(INDENT);
  });

  test('ToolResultCard: the same indent and cap as the other two', () => {
    const html = inline(
      <ToolResultCard>
        <div>a row</div>
      </ToolResultCard>,
    );

    expect(html).toContain('max-h-96 overflow-auto');
    expect(html).toContain(INDENT);
    expect(html).toContain('mt-1.5');
    expect(html).not.toContain('ml-7');
    expect(html).not.toContain('max-h-[19rem]');
  });

  test('the panel drops BOTH the indent and the seam on all three', () => {
    // The panel row's body is `px-3 py-3`. A card that also brings `mt-1.5`
    // sits 18px from the trigger seam and 12px from the bottom — the body's
    // own inset, doubled at the top. The indent goes for the reason it always
    // did (no icon gutter to line up with); the seam goes with it, so the
    // gate is one condition and not two rules that can drift apart.
    const html = renderPanel(
      <>
        <RawOutputBlock output="plain log line" />
        <ToolCodeCard code="const a = 1;" language="ts" />
        <ToolResultCard>
          <div>a row</div>
        </ToolResultCard>
      </>,
    );

    expect(html).not.toContain('--tool-indent');
    expect(html).not.toContain('ml-7');
    expect(html).not.toContain('mt-1.5');
  });
});

// ─── Phase 6 gate, finding 5 — one payload, one frame ───────────────────────
//
// An opened panel row drew THREE frames around one payload: the row card's
// `bg-popover rounded-md border`, the disclosure body's `border-t px-3 py-3`,
// and then the payload card's own `bg-popover rounded-md border` with its own
// `p-3` inside that. Three edges and 24px of gutter on a 420px pane to say one
// thing.
//
// The de-nest: on the panel the payload card drops BOTH its frame and its own
// inset, because the row card is already the frame and the body is already the
// inset. Inline it keeps both — there it hangs under a trigger row on the page
// background with nothing else to bound it, which is why the frame exists at
// all. Both halves are asserted, on both surfaces, because dropping only one
// of them leaves the payload either edgeless-but-double-inset or framed-but-
// flush.
describe('a payload card de-nests on the panel and is unchanged inline (gate finding 5)', () => {
  const cards = (
    <>
      <RawOutputBlock output="plain log line" />
      <ToolCodeCard code="const a = 1;" language="ts" />
      <ToolResultCard>
        <div>a row</div>
      </ToolResultCard>
    </>
  );

  test('panel: no second frame and no second inset', () => {
    const html = renderPanel(cards);

    // The row card's own frame is not in this fragment — `BasicTool` is not
    // rendered here — so ANY `bg-popover … border` is a payload drawing a
    // frame the row already drew.
    expect(html).not.toContain('bg-popover');
    expect(html).not.toContain('rounded-md border');
    // The card's own 12px gutter is gone; the body's `px-3 py-3` is the inset.
    expect(html).not.toContain('overflow-auto p-3');
    // The copy-button reserve survives the merge — it is not padding, it is
    // room for a control that really is there.
    expect(html).toContain('pr-11');
  });

  test('inline: frame and inset both intact — the de-nest is panel-only', () => {
    const html = renderToStaticMarkup(cards);

    expect(html).toContain('border-border bg-popover rounded-md border');
    expect(html).toContain('max-h-96 overflow-auto p-3 pr-11');
    expect(html).toContain(INDENT);
    expect(html).toContain('mt-1.5');
  });

  test('a FAILURE keeps its edge on the panel — a tint is not a frame', () => {
    // The neutral frame is redundant on the panel; the destructive one is the
    // signal itself, and the row card has no way to carry it.
    const html = renderPanel(
      <ToolResultCard tone="destructive">
        <div>it broke</div>
      </ToolResultCard>,
    );

    expect(html).toContain('border-destructive/40 bg-destructive/10');
    expect(html).toContain('rounded-md border');
  });
});

describe('a subtitle the open body repeats is dropped from the trigger', () => {
  /**
   * `hideSubtitleWhenOpen` — the same rule the `bash` row follows in its own
   * component: a closed row is the only place the text appears, so it stays
   * there; open, it is the same string twice, and the trigger's copy is the
   * truncated one.
   *
   * Opt-IN. Most subtitles are not repeated by the body — a `pty` row's
   * terminal id appears nowhere in the buffer it opens — so the default must
   * leave them alone.
   */
  const SUBTITLE = 'ls -la /workspace';

  test('inline: closed keeps it, open drops it', () => {
    const trigger = { title: 'Started terminal', subtitle: SUBTITLE, hideSubtitleWhenOpen: true };

    const closed = renderToStaticMarkup(
      <BasicTool trigger={trigger}>
        <div>the card</div>
      </BasicTool>,
    );
    expect(closed).toContain(SUBTITLE);

    const open = renderToStaticMarkup(
      <BasicTool trigger={trigger} defaultOpen>
        <div>the card</div>
      </BasicTool>,
    );
    expect(open).not.toContain(SUBTITLE);
    // The row still says what it is, and the body it opened is still there.
    expect(open).toContain('Started terminal');
    expect(open).toContain('the card');
  });

  test('panel: the same, on the surface that shares the behaviour', () => {
    const trigger = { title: 'Started terminal', subtitle: SUBTITLE, hideSubtitleWhenOpen: true };

    expect(
      renderPanel(
        <BasicTool trigger={trigger}>
          <div>the card</div>
        </BasicTool>,
      ),
    ).toContain(SUBTITLE);
    expect(
      renderPanel(
        <BasicTool trigger={trigger} defaultOpen>
          <div>the card</div>
        </BasicTool>,
      ),
    ).not.toContain(SUBTITLE);
  });

  test('without the flag an open row keeps its subtitle — this is opt-in', () => {
    const html = renderToStaticMarkup(
      <BasicTool trigger={{ title: 'Terminal output', subtitle: 'pty_a1b2c3' }} defaultOpen>
        <div>the buffer</div>
      </BasicTool>,
    );

    expect(html).toContain('pty_a1b2c3');
  });
});

describe('BasicTool body opens with the same animation a thought does', () => {
  /**
   * The reported drift: an expanding tool row POPPED while a `Thinking` row in
   * the same chain unfurled. Both are disclosures, but only the thought went
   * through `DisclosureContent` — the tool rows rendered their body as a bare
   * `{open && <div>}`, which mounts at full height in one frame.
   *
   * `DisclosureContent` animates `height: 0 → auto` with opacity through
   * `AnimatePresence` (`ui/disclosure.tsx`). Static markup cannot watch an
   * animation, but it CAN prove the animated element is the one rendering the
   * body — `height:auto` in an inline style is written by motion, not by any
   * class in this tree.
   */
  const OPEN_STATE = 'style="height:auto';

  test('inline: the payload rides the animated element', () => {
    const html = renderToStaticMarkup(
      <BasicTool trigger={{ title: 'Ran command' }} defaultOpen>
        <div>the payload</div>
      </BasicTool>,
    );

    expect(html).toContain(OPEN_STATE);
    expect(html).toContain('the payload');
  });

  test('panel: the same, on the surface that shares the behaviour', () => {
    const html = renderPanel(
      <BasicTool trigger={{ title: 'Ran command' }} defaultOpen>
        <div>the payload</div>
      </BasicTool>,
    );

    expect(html).toContain(OPEN_STATE);
    expect(html).toContain('the payload');
  });

  test('closed, the wrapper is empty — a collapsed row is still zero-height', () => {
    // `DisclosureContent` keeps its clipping wrapper mounted while the body is
    // gone, so the wrapper must contribute nothing: no payload, and the 4px
    // seam is PADDING on a child of the animated element rather than a margin
    // on the wrapper, which would leave 8px of dead space under every closed
    // row in a transcript.
    const html = renderToStaticMarkup(
      <BasicTool trigger={{ title: 'Ran command' }}>
        <div>the payload</div>
      </BasicTool>,
    );

    expect(html).toContain('<div class="overflow-hidden text-xs"></div>');
    expect(html).not.toContain('the payload');
    expect(html).not.toContain(OPEN_STATE);
  });
});

describe('BasicTool inline surface — activate context vs defaultOpen', () => {
  const activate = () => {};

  test('defaultOpen renders the body inline even when an activate context is bound', () => {
    // The regression: chat binds BoundActivateContext for every tool row, and
    // the activate branch discarded `defaultOpen` — collapsing `show`'s
    // carousel to a bare "Show · N items" line with no content anywhere inline.
    const html = renderToStaticMarkup(
      <BoundActivateContext.Provider value={activate}>
        <BasicTool trigger={{ title: 'Show', subtitle: '4 items' }} defaultOpen>
          <div>carousel body</div>
        </BasicTool>
      </BoundActivateContext.Provider>,
    );
    expect(html).toContain('carousel body');
  });

  test('without defaultOpen the activate row still wins (no inline body)', () => {
    const html = renderToStaticMarkup(
      <BoundActivateContext.Provider value={activate}>
        <BasicTool trigger={{ title: 'Read', subtitle: 'file.ts' }}>
          <div>file contents</div>
        </BasicTool>
      </BoundActivateContext.Provider>,
    );
    expect(html).not.toContain('file contents');
  });
});

// ─── The Actions stepper opens one tool at a time, so a row that renders
// nothing is a dead click. A `show` carrying no path/url/content/items draws an
// empty card, and the chat transcript already drops it — the stepper must reach
// the same verdict or the two surfaces disagree about what exists. ───────────
describe('shouldShowToolPartInActionsPanel — empty show', () => {
  const showPart = (status: string, input: Record<string, unknown>) =>
    ({ tool: 'show', state: { status, input } }) as unknown as Parameters<
      typeof shouldShowToolPartInActionsPanel
    >[0];

  test('drops a settled show that handed nothing over', () => {
    expect(shouldShowToolPartInActionsPanel(showPart('completed', { type: 'markdown' }))).toBe(
      false,
    );
  });

  test('keeps a show with a real artifact', () => {
    expect(
      shouldShowToolPartInActionsPanel(showPart('completed', { path: '/workspace/q3.pdf' })),
    ).toBe(true);
  });

  test('keeps a still-running show — its input has not arrived yet', () => {
    expect(shouldShowToolPartInActionsPanel(showPart('running', {}))).toBe(true);
  });

  test('leaves every other tool alone', () => {
    expect(
      shouldShowToolPartInActionsPanel({
        tool: 'bash',
        state: { status: 'completed', input: {} },
      } as unknown as Parameters<typeof shouldShowToolPartInActionsPanel>[0]),
    ).toBe(true);
  });
});
