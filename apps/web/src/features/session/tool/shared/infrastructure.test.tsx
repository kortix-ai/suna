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
//   • body: rendered only while open, `border-t px-3 py-3 text-sm`;
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
    const html = renderPanel(<BasicTool trigger={{ title: 'Workspace', subtitle: 'kortix-web' }} />);

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

// ─── Task 19 (Phase 6, spec W11/D16) — ONE block rhythm ─────────────────────
//
// Three bordered cards can sit under the SAME expanded row, and each one used
// to answer the geometry questions differently: `ToolOutputCard` indented 28px
// and capped at 288px, `ToolResultCard` indented 28px and capped at 304px,
// `ToolCodeCard` indented 22px and capped at 384px — so a `read` and a `memory`
// row in one turn drew their cards on two different left edges. The law now:
//
//   • frame  — `bg-popover border-border rounded-md border`, `mt-1.5` seam;
//   • indent — the shared `--tool-indent` variable (22px), inline only;
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

  test('the panel drops the indent on all three — it has no icon gutter', () => {
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
