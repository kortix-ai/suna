import { Button } from '@/components/ui/button';
import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextItem } from '../shared/derive-panels';
import { ContextCard } from './context-card';
import type { Detail } from './detail-view';
import { PanelCard, type PanelCardProps } from './panel-card';

const web: ContextItem[] = [
  { callID: 'w1', label: 'Kortix docs', kind: 'web', url: 'https://kortix.com/docs' },
];
const files: ContextItem[] = [
  { callID: 'f1', label: 'report.md', kind: 'file', path: 'report.md' },
];
// `Terminal` is the label production genuinely derives for the `run` family —
// `deriveContext` routes the generic branch through `contextLabelForTool`
// (narration.ts), which maps `run` → "Terminal" and `memory` → "Memory".
const tools: ContextItem[] = [
  {
    callID: 't1',
    label: 'Terminal',
    kind: 'tool',
    parts: [
      { type: 'tool', tool: 'bash', callID: 't1', state: { status: 'completed' } },
    ] as unknown as ToolPart[],
  },
];

/** One tool row whose calls are a mix of success and failure — the failed-call
 *  aggregation case:
 *  `deriveContext` only DROPS a fully-errored call, so a tool that succeeded
 *  nine times and failed once still reaches this row with `state.status ===
 *  'error'` sitting among its `parts`. */
const toolsWithAFailedCall: ContextItem[] = [
  {
    callID: 't1',
    label: 'Terminal',
    kind: 'tool',
    parts: [
      { type: 'tool', tool: 'bash', callID: 't1a', state: { status: 'completed' } },
      { type: 'tool', tool: 'bash', callID: 't1b', state: { status: 'error' } },
    ] as unknown as ToolPart[],
  },
];

/**
 * The card's body, straight out of the element tree.
 *
 * A whole-card render shows the header and an empty box: the rows sit inside a
 * `PanelCard` that starts collapsed, and a collapsed `DisclosureContent`
 * renders none of its children. Reaching for `PanelCard`'s `children` gets the
 * same elements with the same classes, minus the disclosure that swallows them.
 *
 * This calls `ContextCard` directly as a plain function rather than mounting
 * it — safe only because `ContextCard` holds no hooks of its own. If it ever
 * gains one (local state, an effect), this harness stops being valid and has
 * to switch to real rendering (e.g. `@testing-library/react`) instead.
 */
function cardBody(
  onOpenDetail: (detail: Detail) => void = () => {},
  onOpenFile: (path: string, allPaths: string[]) => void = () => {},
  items: { files: ContextItem[]; web: ContextItem[]; tools: ContextItem[] } = { files, web, tools },
  emptyStateProps: {
    onAddContext?: () => void;
  } = {},
): ReactNode {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail,
    onOpenFile,
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
  });
  return (card as ReactElement<{ children?: ReactNode }>).props.children;
}

/**
 * The `emptyActions` prop `ContextCard` hands `PanelCard` — the "Add
 * context" button (Task 5). `PanelCard` only renders this inside its own
 * collapsed-by-default `DisclosureContent` (see `cardBody`'s comment for why
 * a whole-card render shows none of it), so — same move as `cardBody`
 * reaching for `children` — this reaches for the prop directly instead of
 * mounting anything.
 */
function emptyActionsOf(
  items: { files: ContextItem[]; web: ContextItem[]; tools: ContextItem[] },
  emptyStateProps: {
    onAddContext?: () => void;
  } = {},
): ReactNode {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail: () => {},
    onOpenFile: () => {},
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
  }) as ReactElement<PanelCardProps>;
  return card.props.emptyActions;
}

/**
 * The card's FULL markup, `PanelCard` and all, forced open via
 * `defaultExpanded` — the one place in this file that actually mounts
 * `PanelCard` rather than reaching into an unrendered element's props. Needed
 * here specifically to prove the acceptance rule "both actions render ONLY in
 * the empty state": that gate lives inside `PanelCard`'s own `isEmpty`
 * ternary (`panel-card.tsx`), not in `ContextCard`, so nothing short of a
 * real render of that ternary can catch a regression that flips it.
 *
 * `defaultExpanded` is safe to force here without a DOM: `PanelCard` seeds
 * its `expanded` state from that prop via plain `useState(defaultExpanded)`,
 * which resolves on the FIRST render `renderToStaticMarkup` performs — no
 * `useEffect` (which SSR never runs) required.
 */
function renderExpanded(
  items: { files: ContextItem[]; web: ContextItem[]; tools: ContextItem[] },
  emptyStateProps: {
    onAddContext?: () => void;
  } = {},
): string {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail: () => {},
    onOpenFile: () => {},
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
  }) as ReactElement<PanelCardProps>;
  return renderToStaticMarkup(<PanelCard {...card.props} defaultExpanded />);
}

/** The opening tag of every `<button>` in the rendered body, in document order. */
function buttonTags(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
}

/**
 * A group row's markup, minus its count `Badge`.
 *
 * The count badge is a legitimate `rounded-full` control (see `badge.tsx`'s
 * `badgeVariants`), so a check for "no pill in this row" has to look past it —
 * otherwise the only way to pass is to literally never render a badge. Every
 * row DOES currently have one, so scanning the row's own opening tag alone
 * (as this test used to) happened to dodge the badge without ever proving the
 * row overall was pill-free: a `rounded-full` reintroduced anywhere else in
 * the row — a wrapping `<li>`, an icon tile, the label span — would pass
 * silently as long as it never touched the `<button>` tag's own class.
 */
function withoutBadgeMarkup(html: string): string {
  return html.replace(/<span data-slot="badge"[^>]*>.*?<\/span>/g, '');
}

/**
 * Every host `<button>` element in an unrendered React tree, in document order.
 *
 * A row's click contract can't be reached through static markup — it has no
 * handlers, and this runner has no DOM to dispatch into. Calling the row
 * element's own `onClick` exercises the exact prop the real button carries,
 * which is all a tap ever reaches.
 */
function buttonsIn(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) buttonsIn(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === 'button') found.push(element);
  buttonsIn(element.props.children, found);
  return found;
}

/**
 * Every unrendered element of a given `type` (e.g. the `Button` component
 * itself) in a React tree, in document order.
 *
 * "Add context" (Task 5) is a `<Button>` component, not a raw `<button>`
 * element — `buttonsIn`'s `element.type === 'button'` check can never match a
 * component reference, only the host-element string. Matching on the
 * imported `Button` reference directly reaches the exact element the card
 * constructed — same idea as `buttonsIn`, generalized past host tags.
 */
function elementsOfType<P>(
  node: ReactNode,
  type: unknown,
  found: ReactElement<P>[] = [],
): ReactElement<P>[] {
  if (Array.isArray(node)) {
    for (const child of node) elementsOfType(child, type, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) found.push(element as ReactElement<P>);
  elementsOfType(element.props.children, type, found);
  return found;
}

describe('ContextCard groups are rows, not pills (W1)', () => {
  test('every group control is a full-width row button, never a pill', () => {
    const html = renderToStaticMarkup(<>{cardBody()}</>);
    const tags = buttonTags(html);
    expect(tags).toHaveLength(3); // one per group
    for (const tag of tags) {
      expect(tag).toContain('w-full');
    }
    // Over the FULL rendered markup of the group list (R8 #1) — not just each
    // button's own opening tag, which a stray pill elsewhere in the row could
    // dodge entirely. See `withoutBadgeMarkup` for why the count badge is
    // excluded first.
    expect(withoutBadgeMarkup(html)).not.toContain('rounded-full');
  });

  test('a tool row with one failed call among successes shows the error glyph (failed-call aggregation, R8 #2)', () => {
    const html = renderToStaticMarkup(
      <>{cardBody(undefined, undefined, { files: [], web: [], tools: toolsWithAFailedCall })}</>,
    );
    // `StepIcon` (step-icon.tsx) marks `status: 'error'` with `text-kortix-red`
    // and everything else with `text-muted-foreground` — the only glyph in
    // this render is the Terminal row's, so this pins the aggregation in
    // `context-card.tsx` (one failed call among several still reads as failed)
    // rather than the per-call status of whichever call happens to be first.
    expect(html).toContain('text-kortix-red');
  });

  test('the rows keep a stable order: web, then files, then tools', () => {
    const html = renderToStaticMarkup(<>{cardBody()}</>);
    expect(html).toContain('Web sources');
    expect(html.indexOf('Web sources')).toBeLessThan(html.indexOf('Files read'));
    expect(html.indexOf('Files read')).toBeLessThan(html.indexOf('Terminal'));
  });

  test('a row opens that group in the detail layer', () => {
    const opened: Detail[] = [];
    const rows = buttonsIn(cardBody((detail) => opened.push(detail)));
    expect(rows).toHaveLength(3);

    for (const row of rows) {
      (row.props as { onClick?: () => void }).onClick?.();
    }

    expect(opened.map((d) => d.key)).toEqual(['web', 'files', 't1']);
    expect(opened.map((d) => d.title)).toEqual(['Web sources', 'Files read', 'Terminal']);
  });
});

describe('"Files read" rows open the file viewer (Task 3)', () => {
  // A pathless item ('notes.txt') sits between two real files — real, per
  // `deriveContext`'s `label: getToolPrimaryArg(part) || path`, whenever a
  // `read` call's path is unresolvable; it must stay inert while the others
  // open, and it must not appear in the ordered path list either.
  const filesWithAGap: ContextItem[] = [
    { callID: 'f1', label: 'report.md', kind: 'file', path: 'report.md' },
    { callID: 'f2', label: 'notes.txt', kind: 'file' },
    { callID: 'f3', label: 'summary.pdf', kind: 'file', path: 'docs/summary.pdf' },
  ];

  test('a file row calls onOpenFile with its own path and the ordered path list; a pathless row stays inert', () => {
    const calls: Array<{ path: string; allPaths: string[] }> = [];
    const opened: Detail[] = [];
    const onOpenFile = (path: string, allPaths: string[]) => calls.push({ path, allPaths });

    const rows = buttonsIn(
      cardBody(
        (detail) => opened.push(detail),
        onOpenFile,
        { files: filesWithAGap, web: [], tools: [] },
      ),
    );
    expect(rows).toHaveLength(1); // one group row: "Files read"
    (rows[0].props as { onClick?: () => void }).onClick?.();

    const filesDetail = opened.find((d) => d.key === 'files');
    expect(filesDetail).toBeDefined();

    // `FileList`'s body is an unrendered `<FileList items={...} onOpenFile={...}
    // />` element — invoking its own `type` with its own `props` calls the
    // component the exact same way `cardBody` calls `ContextCard`: directly,
    // as a plain function. Same harness limitation applies (see `cardBody`).
    const bodyEl = filesDetail!.body as ReactElement<{
      items: ContextItem[];
      onOpenFile: (path: string, allPaths: string[]) => void;
    }>;
    const list = (bodyEl.type as (p: typeof bodyEl.props) => ReactNode)(bodyEl.props);

    const fileRowButtons = buttonsIn(list);
    // Only the two rows with a real path get button semantics — the
    // pathless 'notes.txt' row is skipped entirely.
    expect(fileRowButtons).toHaveLength(2);

    for (const btn of fileRowButtons) {
      (btn.props as { onClick?: () => void }).onClick?.();
    }

    expect(calls).toEqual([
      { path: 'report.md', allPaths: ['report.md', 'docs/summary.pdf'] },
      { path: 'docs/summary.pdf', allPaths: ['report.md', 'docs/summary.pdf'] },
    ]);

    // The pathless item still renders — just never as a button.
    const html = renderToStaticMarkup(<>{list}</>);
    expect(html).toContain('notes.txt');
    expect(buttonTags(html)).toHaveLength(2);
  });
});

describe('Empty-state actions: Add context (Task 5)', () => {
  const empty = { files: [], web: [], tools: [] };

  test('"Add context" renders only in the empty state — the non-empty card shows no empty-state button', () => {
    const emptyHtml = renderExpanded(empty);
    expect(emptyHtml).toContain('Add context');

    const fullHtml = renderExpanded({ files, web, tools });
    expect(fullHtml).not.toContain('Add context');
  });

  test('"Add context" calls onAddContext and nothing else', () => {
    let addContextCalls = 0;
    const buttons = elementsOfType<{ onClick?: () => void }>(
      emptyActionsOf(empty, { onAddContext: () => addContextCalls++ }),
      Button,
    );
    expect(buttons).toHaveLength(1); // Add context only

    (buttons[0].props as { onClick?: () => void }).onClick?.();

    expect(addContextCalls).toBe(1);
  });

  // Mutation-checked: temporarily restoring the removed "Connect apps" button
  // (empty state) or footer row (non-empty state) makes this fail — proving
  // it isn't vacuously true for a card that never had the text to begin with.
  test('"Connect apps" was removed by product decision — its text renders in neither state', () => {
    const emptyHtml = renderExpanded(empty);
    const fullHtml = renderExpanded({ files, web, tools });

    expect(emptyHtml).not.toContain('Connect apps');
    expect(fullHtml).not.toContain('Connect apps');
  });
});
