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
    projectId?: string;
    connectAppsOpen?: boolean;
    onToggleConnectApps?: () => void;
  } = {},
): ReactNode {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail,
    onOpenFile,
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
    projectId: emptyStateProps.projectId,
    connectAppsOpen: emptyStateProps.connectAppsOpen ?? false,
    onToggleConnectApps: emptyStateProps.onToggleConnectApps ?? (() => {}),
  });
  return (card as ReactElement<{ children?: ReactNode }>).props.children;
}

/**
 * The `emptyActions` prop `ContextCard` hands `PanelCard` — the "Add
 * context" / "Connect apps" block (Task 5). `PanelCard` only renders this
 * inside its own collapsed-by-default `DisclosureContent` (see `cardBody`'s
 * comment for why a whole-card render shows none of it), so — same move as
 * `cardBody` reaching for `children` — this reaches for the prop directly
 * instead of mounting anything.
 */
function emptyActionsOf(
  items: { files: ContextItem[]; web: ContextItem[]; tools: ContextItem[] },
  emptyStateProps: {
    onAddContext?: () => void;
    projectId?: string;
    connectAppsOpen?: boolean;
    onToggleConnectApps?: () => void;
  } = {},
): ReactNode {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail: () => {},
    onOpenFile: () => {},
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
    projectId: emptyStateProps.projectId,
    connectAppsOpen: emptyStateProps.connectAppsOpen ?? false,
    onToggleConnectApps: emptyStateProps.onToggleConnectApps ?? (() => {}),
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
    projectId?: string;
    connectAppsOpen?: boolean;
    onToggleConnectApps?: () => void;
  } = {},
): string {
  const card = ContextCard({
    ...items,
    sessionId: 's1',
    onOpenDetail: () => {},
    onOpenFile: () => {},
    onAddContext: emptyStateProps.onAddContext ?? (() => {}),
    projectId: emptyStateProps.projectId,
    connectAppsOpen: emptyStateProps.connectAppsOpen ?? false,
    onToggleConnectApps: emptyStateProps.onToggleConnectApps ?? (() => {}),
  }) as ReactElement<PanelCardProps>;
  return renderToStaticMarkup(<PanelCard {...card.props} defaultExpanded />);
}

/** The opening tag of every `<button>` in the rendered body, in document order. */
function buttonTags(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
}

/**
 * `buttonTags`, minus the Task 7 "Connect apps" footer toggle.
 *
 * The footer row is the only group-list `<button>` carrying `aria-controls`
 * — every group row opens the detail layer and has no such attribute — so
 * that's the marker used to separate "one button per group" assertions from
 * the footer, which exists once regardless of how many groups there are.
 */
function groupRowTags(html: string): string[] {
  return buttonTags(html).filter((tag) => !tag.includes('aria-controls'));
}

/** How many times `needle` occurs in `haystack` — used to prove text renders
 *  exactly once rather than merely "at least once" (catches an accidental
 *  double-render the empty state and the footer would otherwise both pass). */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

/** `buttonsIn`, minus the Task 7 footer toggle — see `groupRowTags` for why
 *  `aria-controls` is what separates it from a group row's own button. */
function groupRowsIn(node: ReactNode): ReactElement[] {
  return buttonsIn(node).filter(
    (el) => !('aria-controls' in (el.props as Record<string, unknown>)),
  );
}

/**
 * Every unrendered element of a given `type` (e.g. the `Button` component
 * itself) in a React tree, in document order.
 *
 * "Add context" / "Connect apps" (Task 5) are `<Button>` components, not raw
 * `<button>` elements — `buttonsIn`'s `element.type === 'button'` check can
 * never match a component reference, only the host-element string. Matching
 * on the imported `Button` reference directly reaches the exact element the
 * card constructed — same idea as `buttonsIn`, generalized past host tags.
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
    // `groupRowTags` excludes the Task 7 "Connect apps" footer toggle, which
    // also renders here (the card is non-empty) but isn't a group row.
    const tags = groupRowTags(html);
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
    // `groupRowsIn` excludes the Task 7 footer toggle — see its comment.
    const rows = groupRowsIn(cardBody((detail) => opened.push(detail)));
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

    // `groupRowsIn` excludes the Task 7 footer toggle, which also renders
    // here (the card is non-empty) but isn't a group row.
    const rows = groupRowsIn(
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

describe('Empty-state actions: Add context / Connect apps (Task 5)', () => {
  const empty = { files: [], web: [], tools: [] };

  // Every case below passes `projectId` because "Connect apps" now renders
  // only with one — see the "no projectId" describe block for that gate.
  test('"Add context" renders only in the empty state — the non-empty card shows neither empty-state button', () => {
    const emptyHtml = renderExpanded(empty, { projectId: 'p1' });
    expect(emptyHtml).toContain('Add context');
    expect(emptyHtml).toContain('Connect apps');

    // Task 7 gives the non-empty card its OWN "Connect apps" footer row, so
    // that text alone no longer proves the empty-state button is gone — see
    // the "Non-empty footer row" describe block below for the directional
    // pin between the empty-state button and the footer row.
    const fullHtml = renderExpanded({ files, web, tools }, { projectId: 'p1' });
    expect(fullHtml).not.toContain('Add context');
  });

  test('"Add context" calls onAddContext and nothing else', () => {
    let addContextCalls = 0;
    let toggleCalls = 0;
    const buttons = elementsOfType<{ onClick?: () => void }>(
      emptyActionsOf(empty, {
        projectId: 'p1',
        onAddContext: () => addContextCalls++,
        onToggleConnectApps: () => toggleCalls++,
      }),
      Button,
    );
    expect(buttons).toHaveLength(2); // Add context, Connect apps

    (buttons[0].props as { onClick?: () => void }).onClick?.();

    expect(addContextCalls).toBe(1);
    expect(toggleCalls).toBe(0);
  });

  test('"Connect apps" calls onToggleConnectApps and nothing else', () => {
    let addContextCalls = 0;
    let toggleCalls = 0;
    const buttons = elementsOfType<{ onClick?: () => void }>(
      emptyActionsOf(empty, {
        projectId: 'p1',
        onAddContext: () => addContextCalls++,
        onToggleConnectApps: () => toggleCalls++,
      }),
      Button,
    );

    (buttons[1].props as { onClick?: () => void }).onClick?.();

    expect(toggleCalls).toBe(1);
    expect(addContextCalls).toBe(0);
  });

  test('connectAppsOpen reveals ConnectAppsStrip under the buttons; closed hides it', () => {
    const closedHtml = renderToStaticMarkup(
      <>{emptyActionsOf(empty, { connectAppsOpen: false, projectId: 'p1' })}</>,
    );
    // 'Gmail' is a `ConnectAppsStrip` row label (`DEFAULT_CONNECTORS`) — absent
    // whenever the strip itself is absent.
    expect(closedHtml).not.toContain('Gmail');

    const openHtml = renderToStaticMarkup(
      <>{emptyActionsOf(empty, { connectAppsOpen: true, projectId: 'p1' })}</>,
    );
    expect(openHtml).toContain('Gmail');
  });

  test('connectAppsOpen without a projectId renders no strip — ConnectAppsStrip needs one to declare a connector against', () => {
    const html = renderToStaticMarkup(
      <>{emptyActionsOf(empty, { connectAppsOpen: true, projectId: undefined })}</>,
    );
    expect(html).not.toContain('Gmail');
  });
});

describe('Non-empty footer row: + Connect apps (Task 7)', () => {
  const nonEmpty = { files, web, tools };
  const empty = { files: [], web: [], tools: [] };

  test('the footer row renders only when non-empty; the empty-state actions never render when non-empty (both directions pinned)', () => {
    // `projectId` is required for either "Connect apps" affordance to render
    // at all now — see the "no projectId" describe block below.
    const emptyHtml = renderExpanded(empty, { projectId: 'p1' });
    const fullHtml = renderExpanded(nonEmpty, { projectId: 'p1' });

    // `-mx-0.5 mt-0.5` sits only on the footer row's className — the
    // empty-state "Connect apps" button is a shadcn `outline`-variant
    // `Button`, whose classes never include it — so it's a clean marker for
    // "the footer row is on the page" independent of the shared label text.
    expect(emptyHtml).not.toContain('-mx-0.5 mt-0.5');
    expect(fullHtml).toContain('-mx-0.5 mt-0.5');

    // "Connect apps" renders exactly once per state — the empty-state button
    // in emptyHtml, the footer row in fullHtml — never both at once. A
    // regression that rendered the empty-state actions ALONGSIDE the footer
    // (or vice versa) would push either count to 2.
    expect(countOccurrences(emptyHtml, 'Connect apps')).toBe(1);
    expect(countOccurrences(fullHtml, 'Connect apps')).toBe(1);

    // The empty state's "Add context" button never renders once the card has
    // rows — the footer row has no equivalent of its own.
    expect(emptyHtml).toContain('Add context');
    expect(fullHtml).not.toContain('Add context');
  });

  test('the footer toggle reveals the SAME ConnectAppsStrip the empty-state toggle opens — no second state', () => {
    const closedHtml = renderExpanded(nonEmpty, { connectAppsOpen: false, projectId: 'p1' });
    // 'Gmail' is a `ConnectAppsStrip` row label (`DEFAULT_CONNECTORS`) —
    // absent whenever the strip itself is absent.
    expect(closedHtml).not.toContain('Gmail');

    const openHtml = renderExpanded(nonEmpty, { connectAppsOpen: true, projectId: 'p1' });
    expect(openHtml).toContain('Gmail');
  });

  test('the footer row calls onToggleConnectApps and nothing else', () => {
    let toggleCalls = 0;
    let openDetailCalls = 0;
    // All buttons in document order: 3 group rows, then the footer toggle —
    // `buttonsIn` (unfiltered) is what proves the footer sits AFTER the
    // group list, not `groupRowsIn`, which would exclude it entirely.
    const rows = buttonsIn(
      cardBody(
        () => openDetailCalls++,
        undefined,
        nonEmpty,
        { projectId: 'p1', onToggleConnectApps: () => toggleCalls++ },
      ),
    );
    expect(rows).toHaveLength(4); // 3 group rows + the footer toggle
    const footer = rows[3];

    (footer.props as { onClick?: () => void }).onClick?.();

    expect(toggleCalls).toBe(1);
    expect(openDetailCalls).toBe(0);
  });

  test('both toggles share one aria-controls target — the strip container id (Minor carried from Task 5 review)', () => {
    const stripId = 'context-card-connect-apps-s1'; // sessionId is 's1' in cardBody/renderExpanded
    const fullOpenHtml = renderExpanded(nonEmpty, { connectAppsOpen: true, projectId: 'p1' });
    expect(fullOpenHtml).toContain(`aria-controls="${stripId}"`);
    expect(fullOpenHtml).toContain(`id="${stripId}"`);

    const emptyOpenHtml = renderExpanded(empty, { connectAppsOpen: true, projectId: 'p1' });
    expect(emptyOpenHtml).toContain(`aria-controls="${stripId}"`);
    expect(emptyOpenHtml).toContain(`id="${stripId}"`);

    // Mutation check: a wrong id (stale/typo'd) would never appear in either
    // render — proving this assertion isn't vacuously true for any string.
    expect(fullOpenHtml).not.toContain('aria-controls="context-card-connect-apps-WRONG"');
  });
});

/**
 * `ConnectAppsStrip` returns null without a `projectId` (it has no project to
 * declare a connector against), so a toggle rendered anyway is a dead control:
 * pressing it flips `aria-expanded` over an empty container. Both affordances
 * — the empty state's button and the non-empty footer row — are gated on the
 * project, in both directions.
 */
describe('Connect apps needs a project — no projectId, no toggle', () => {
  const nonEmpty = { files, web, tools };
  const empty = { files: [], web: [], tools: [] };

  test('without a projectId neither affordance renders', () => {
    const emptyHtml = renderExpanded(empty);
    const fullHtml = renderExpanded(nonEmpty);

    expect(emptyHtml).not.toContain('Connect apps');
    expect(fullHtml).not.toContain('Connect apps');
    // Nothing claims to control the strip either — no `aria-expanded` over an
    // element that was never mounted.
    expect(emptyHtml).not.toContain('aria-controls="context-card-connect-apps-s1"');
    expect(fullHtml).not.toContain('aria-controls="context-card-connect-apps-s1"');
    // `-mx-0.5 mt-0.5` is the footer row's own marker (see the Task 7 block).
    expect(fullHtml).not.toContain('-mx-0.5 mt-0.5');

    // The rest of the card is untouched: only the connect affordance is gone.
    expect(emptyHtml).toContain('Add context');
    expect(fullHtml).toContain('Web sources');
  });

  test('with a projectId both affordances render', () => {
    const emptyHtml = renderExpanded(empty, { projectId: 'p1' });
    const fullHtml = renderExpanded(nonEmpty, { projectId: 'p1' });

    expect(emptyHtml).toContain('Connect apps');
    expect(fullHtml).toContain('Connect apps');
    expect(fullHtml).toContain('-mx-0.5 mt-0.5');
  });

  test('the empty-state toggle itself is absent, not merely inert, without a project', () => {
    // Reaches the constructed `Button` elements directly — a toggle that
    // rendered but did nothing would still show up here as a second button.
    const withProject = elementsOfType<{ onClick?: () => void }>(
      emptyActionsOf(empty, { projectId: 'p1' }),
      Button,
    );
    expect(withProject).toHaveLength(2); // Add context, Connect apps

    const withoutProject = elementsOfType<{ onClick?: () => void }>(
      emptyActionsOf(empty, { projectId: undefined }),
      Button,
    );
    expect(withoutProject).toHaveLength(1); // Add context only
  });

  test('the footer toggle itself is absent, not merely inert, without a project', () => {
    const withProject = buttonsIn(cardBody(undefined, undefined, nonEmpty, { projectId: 'p1' }));
    expect(withProject).toHaveLength(4); // 3 group rows + the footer toggle

    const withoutProject = buttonsIn(cardBody(undefined, undefined, nonEmpty, {}));
    expect(withoutProject).toHaveLength(3); // the 3 group rows, nothing else
  });
});
