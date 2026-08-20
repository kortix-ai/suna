import { TooltipProvider } from '@/components/ui/tooltip';
import {
  BoundActivateContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import type { MessageWithParts, ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The contract this file pins (spec W7, replacing the previous one).
 *
 * A task call is a DISCLOSURE row whose body is the sub-agent's live activity.
 * It used to be a plain clickable row: clicking anywhere on it opened
 * `SubSessionModal`, so the one thing the reader wants while a sub-agent runs —
 * what it is doing — was reachable only by leaving the transcript for a modal,
 * and the `SubAgentActivity` the component already built was dead code on that
 * path. Now the row expands in place and the modal is an explicit action inside
 * the body.
 *
 * `role="button"` is on BOTH shapes and so proves nothing: `ClickableToolRow`
 * and `DisclosureTrigger` each set it. `aria-expanded` is the discriminator —
 * only the disclosure has an open state to report.
 *
 * The harness renders to static markup (this app has no DOM in tests — no
 * jsdom, no happy-dom, no react-test-renderer), so a click cannot be dispatched
 * here and a `useState` flip cannot be observed. What IS asserted is everything
 * the click depends on: the action is rendered, it sits in the disclosure body,
 * and the modal it opens is mounted and wired to this call's child session and
 * title. `SubSessionModal` is stubbed so those props are visible in the markup —
 * the real one renders nothing while closed.
 *
 * `mock.module` is process-wide in this workspace, so both mocks spread the real
 * module and the `useRuntimeMessages` stub answers only for THIS file's child
 * session id; every other session id falls through to `{ data: undefined }`.
 */

const CHILD_SESSION_ID = 'ses_child1';

let childMessages: MessageWithParts[] | undefined;

const realSdkReact = await import('@kortix/sdk/react');
await mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useRuntimeMessages: (sessionId: string) =>
    sessionId === CHILD_SESSION_ID ? { data: childMessages } : { data: undefined },
}));

const realSubSessionModal = await import('@/features/session/sub-session-modal');
await mock.module('@/features/session/sub-session-modal', () => ({
  ...realSubSessionModal,
  SubSessionModal: ({
    open,
    sessionId,
    title,
  }: {
    open: boolean;
    sessionId: string;
    title?: string;
  }) => (
    <div
      data-sub-session-modal
      data-open={String(open)}
      data-session-id={sessionId}
      data-title={title}
    />
  ),
}));

const { TaskTool } = await import('./task-tool');

function childToolPart(tool: string, input: Record<string, unknown>, callID: string) {
  return {
    type: 'tool',
    tool,
    callID,
    state: { status: 'completed', input, output: '', metadata: {}, time: { start: 1, end: 2 } },
  };
}

/** What the runtime sends back for a child session: assistant messages with tool parts. */
const CHILD_MESSAGES = [
  {
    info: { id: 'm1', role: 'assistant', sessionID: CHILD_SESSION_ID },
    parts: [
      childToolPart('grep', { pattern: 'TODO' }, 'child-1'),
      childToolPart('glob', { pattern: '**/*.ts' }, 'child-2'),
    ],
  },
] as unknown as MessageWithParts[];

function taskPart(overrides: {
  status?: string;
  childSessionId?: string | null;
  input?: Record<string, unknown>;
}): ToolPart {
  const { status = 'completed', childSessionId = CHILD_SESSION_ID, input } = overrides;
  return {
    type: 'tool',
    tool: 'task',
    callID: 'call-1',
    state: {
      status,
      input: input ?? { subagent_type: 'explorer', description: 'Find the bug' },
      output: '',
      metadata: childSessionId ? { sessionId: childSessionId } : {},
      time: { start: 1, end: 2 },
    },
  } as unknown as ToolPart;
}

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function render(
  part: ToolPart,
  opts: {
    open?: boolean;
    panel?: boolean;
    forceOpen?: boolean;
    locked?: boolean;
    /** Bind the chat's "open this tool in the side panel" context. */
    activatable?: boolean;
  } = {},
) {
  let tool = (
    <TaskTool part={part} defaultOpen={opts.open} forceOpen={opts.forceOpen} locked={opts.locked} />
  );
  if (opts.activatable) {
    tool = <BoundActivateContext.Provider value={() => {}}>{tool}</BoundActivateContext.Provider>;
  }
  return renderToStaticMarkup(
    withProviders(
      opts.panel ? (
        <ToolSurfaceContext.Provider value="panel">{tool}</ToolSurfaceContext.Provider>
      ) : (
        tool
      ),
    ),
  );
}

describe('TaskTool — the row expands in place', () => {
  test('a task with a child session is a disclosure, not a row that opens a modal on click', () => {
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}));

    // The discriminator: only the disclosure reports an open state.
    expect(markup).toContain('aria-expanded="false"');
    // Collapsed: the sub-agent's steps are off screen.
    // (`Searched` / `pattern=TODO` is how the child grep step draws itself —
    // see the expanded test below, which asserts the same strings present.)
    expect(markup).not.toContain('Searched');
    expect(markup).not.toContain('pattern=TODO');
    // The full-view action is NOT off screen: it lives on the trigger now, so a
    // collapsed row still offers it. See the trigger-action test below.
    expect(markup).toContain('aria-label="Open full view"');
    // The modal is mounted but closed — nothing opens itself.
    expect(markup).toContain('data-open="false"');
  });

  test('the trigger keeps its title, live subtitle and step badge', () => {
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}));
    // Anchored to the trigger's own elements, never to bare text: the modal
    // stub carries `data-title="Agent · explorer: Find the bug"` in this same
    // markup, so a loose `toContain('Agent · explorer')` passes with the whole
    // trigger deleted.
    expect(markup).toContain('>Agent · explorer</span>');
    expect(markup).toContain('title="Find the bug">Find the bug</span>');
    // A settled call counts its steps; the badge is inline-suppressed by the
    // shell, so the panel surface is where it is visible. Task 16 REWRITE: the
    // panel title is the disclosure row's own `span`, not the old page
    // header's `h3` — the panel stopped being a page for one call.
    const panelMarkup = render(taskPart({}), { panel: true });
    expect(panelMarkup).toContain('>Agent · explorer</span>');
    expect(panelMarkup).not.toContain('<h3');
    expect(panelMarkup).toContain('>2 steps</span>');
  });

  test('while it runs the subtitle is the sub-agent last step, not the description', () => {
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({ status: 'running' }));
    // Asserted on the trigger's own subtitle attribute, not on the whole
    // markup: the description also travels to the modal's title.
    expect(markup).toContain('title="Glob · **/*.ts"');
    expect(markup).not.toContain('title="Find the bug"');
  });

  test('expanding shows the sub-agent activity in place', () => {
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}), { open: true });
    // Both child steps render through the real sub-agent activity list — each
    // one drawn by its own registered renderer, not by a summary line.
    expect(markup).toContain('Searched');
    expect(markup).toContain('pattern=TODO');
    expect(markup).toContain('pattern: **/*.ts');
  });

  test('the sub-agent list clears the chain rail by taking the tool indent', () => {
    // The break this pins: the list rendered flush at the body's left margin,
    // so its child rows sat in the SAME 16px icon gutter the parent row uses —
    // and `ChainOfThoughtStep` draws its hairline down the centre of that
    // gutter (`left-2`). The rail struck through every child glyph, and a
    // child row landed at the exact x of the `Agent · …` row that owns it.
    //
    // `useToolIndent()` is the repo-wide answer for "a payload under a tool
    // row", and this list is the one payload that never took it. Asserted as
    // the class, not as a pixel: the value travels in `--tool-indent`, which
    // the chain overrides to 1.75rem (`turn/activity-step.tsx`).
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}), { open: true });
    expect(markup).toContain('ml-[var(--tool-indent,1.375rem)]');

    // Panel surface has no icon gutter and no rail, so it takes no indent —
    // `useToolIndent` returns nothing there and the row body's own inset is the
    // only offset.
    const panelMarkup = render(taskPart({}), { panel: true, open: true });
    expect(panelMarkup).not.toContain('ml-[var(--tool-indent,1.375rem)]');
  });

  test('the full view is an action on the trigger, not a row at the foot of the body', () => {
    // It used to be a ghost button at the BOTTOM of the disclosure body, which
    // put it in the chain's icon gutter (so it read as one more sub-agent step)
    // and behind a click (so a just-started agent's only view was hidden).
    // Now it is pinned to the right edge of the trigger and is present whether
    // or not the row is open — the collapsed assertion lives in the first test.
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}), { open: true });

    // A span with a button role, never a real <button>: this node is cloned
    // into `DisclosureTrigger`'s own role="button" element, and nesting one
    // button inside another is invalid HTML.
    expect(markup).toContain('aria-label="Open full view"');
    expect(markup).not.toContain('<button aria-label="Open full view"');
    // Visible label is the short form; the accessible name contains it, so
    // WCAG 2.5.3 (Label in Name) holds.
    expect(markup).toContain('>View</span>');

    // What the action opens: the modal is wired to THIS call's child session
    // and carries the row's own title, and it starts closed.
    expect(markup).toContain(`data-session-id="${CHILD_SESSION_ID}"`);
    expect(markup).toContain('data-title="Agent · explorer: Find the bug"');
    expect(markup).toContain('data-open="false"');
  });

  test('the sub-agent list draws NO rail of its own — the chain owns the line', () => {
    // A rail's lane is the icon column of the row it hangs from; that is what
    // `left-2` means in `ChainOfThoughtStep`. A hairline down the left of this
    // list would sit in the CONTENT lane, anchored to nothing — and with a
    // single sub-agent it drew a second bar 20px inside a chain rail that
    // already said the same thing.
    //
    // The line that binds these steps to their agent is drawn by the chain, in
    // the agent row's own icon lane. See `a group draws one rail per member` in
    // `turn/activity-burst.test.tsx` for the several-agents half.
    childMessages = CHILD_MESSAGES;
    const markup = render(taskPart({}), { open: true });
    expect(markup).not.toContain('bg-muted-foreground/15');
    // The indent stays: it is what keeps the rows out of the rail's lane.
    expect(markup).toContain('space-y-1 ml-[var(--tool-indent,1.375rem)]');
  });

  test('a child session with no steps is a plain button onto the full view, not a dead disclosure', () => {
    // The reported bug: clicking `Agent · general` did nothing. A child
    // session's transcript is only resident while the parent streamed it, and
    // `pruneDetachedSessions` evicts the older ones — so in a turn with three
    // agents the first two rows had no body, yet still rendered as a
    // disclosure that answered a click by toggling nothing.
    childMessages = [];
    const markup = render(taskPart({ status: 'running' }), { open: true });

    // No open state to report: this is `ClickableToolRow`, not a disclosure.
    expect(markup).not.toContain('aria-expanded');
    // But the ROW itself is still activatable. Anchored to the row element,
    // never to a bare `role="button"` — the `View` action is a
    // `span role="button"` in this same markup, so the loose form passes with
    // the row's own handler deleted.
    expect(markup).toContain('<div data-component="tool-trigger" role="button"');
    expect(markup).toContain('aria-label="Open full view"');
    // Nothing inline to show, so no list and no rail.
    expect(markup).not.toContain('ml-[var(--tool-indent,1.375rem)]');
  });

  test('no child session — no body, no action, no modal, and no button role at all', () => {
    childMessages = undefined;
    const markup = render(taskPart({ childSessionId: null }), { open: true });
    expect(markup).toContain('Agent · explorer');
    expect(markup).not.toContain('Open full view');
    expect(markup).not.toContain('>View</span>');
    expect(markup).not.toContain('data-sub-session-modal');
    // Nothing to open and nowhere to go, so the row makes no promise: no
    // trigger, no `role="button"`, no `aria-expanded`, no tab stop. It used to
    // carry all four and do nothing with them.
    expect(markup).toContain('<div data-component="tool-trigger" class=');
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).not.toContain('tabindex');
  });

  test('forceOpen and locked reach the shell — a pending prompt keeps the row open', () => {
    // `BasicTool` hands a row to `ActivatableToolRow` (click leaves for the side
    // panel) when an activate context is bound and the row is neither locked nor
    // forced open. `ToolPartRenderer` sets both flags for a call that is waiting
    // on a permission or a question, and this component used to accept only
    // `forceOpen` — so `locked` was dropped and a prompted row could be routed
    // away from its own prompt. Each flag alone must hold the disclosure.
    childMessages = CHILD_MESSAGES;

    // Control: neither flag → the shell routes the click to the side panel, and
    // there is no open state to report.
    expect(render(taskPart({}), { activatable: true })).not.toContain('aria-expanded');

    expect(render(taskPart({}), { activatable: true, forceOpen: true })).toContain('aria-expanded');
    expect(render(taskPart({}), { activatable: true, locked: true })).toContain('aria-expanded');
  });

  test('the panel surface is a disclosure row too — closed, then the same activity and action', () => {
    // Task 16 REWRITE: the panel branch used to render the body outright, so
    // this test only had to check the body survived the surface. Now the panel
    // is a row that obeys `defaultOpen` like the inline one, so BOTH states are
    // pinned: closed hides the sub-agent's steps, open shows exactly what the
    // old always-expanded panel showed.
    childMessages = CHILD_MESSAGES;

    const closed = render(taskPart({}), { panel: true });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('pattern=TODO');
    // The full-view action rides the trigger on BOTH surfaces, so a closed
    // panel row keeps it — same as the closed inline row.
    expect(closed).toContain('aria-label="Open full view"');

    const open = render(taskPart({}), { panel: true, open: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Searched');
    expect(open).toContain('pattern=TODO');
    expect(open).toContain('aria-label="Open full view"');
  });
});

describe('the never-rendered rightAccessory prop is gone, not merely unused', () => {
  // `ToolHeaderRow` never rendered `rightAccessory`, so all four call sites were
  // silent no-ops. The prop is deleted rather than implemented: none of the four
  // accessories carried a click handler, so rendering them would have added
  // undesigned chrome to three unrelated tools. A reintroduced prop fails here.
  const toolsDir = __dirname;
  const sharedDir = join(__dirname, '..', 'shared');

  // `scripts/split-tool-renderers.ts` carries a copy of `BasicToolProps` in the
  // string it writes `shared/types.ts` from, so it is the one file that can
  // mechanically regenerate the prop. It is swept with the rest.
  const generator = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'split-tool-renderers.ts',
  );

  const files = [
    ...readdirSync(toolsDir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .map((f) => join(toolsDir, f)),
    join(sharedDir, 'types.ts'),
    join(sharedDir, 'infrastructure.tsx'),
    generator,
  ];

  test('sanity: the sweep reads real files', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(readFileSync(join(sharedDir, 'types.ts'), 'utf8')).toContain('BasicToolProps');
    // The generator path resolves — otherwise its test would fail on ENOENT
    // rather than silently passing on an empty read.
    expect(readFileSync(generator, 'utf8')).toContain('export interface BasicToolProps');
  });

  for (const file of files) {
    test(`${file.split('/').slice(-2).join('/')} does not mention rightAccessory`, () => {
      expect(readFileSync(file, 'utf8')).not.toContain('rightAccessory');
    });
  }
});
