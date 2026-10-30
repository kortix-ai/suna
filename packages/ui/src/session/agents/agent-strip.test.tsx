import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PeerMessage, SessionTask } from '@kortix/sdk';
import { IntlTestProvider } from '../../test-utils/intl';

// Synthetic values only: every id, name and text below is invented.

const windowObject = new Window();
const originals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
Object.defineProperty(globalThis, 'window', { value: windowObject, configurable: true });
Object.defineProperty(globalThis, 'document', { value: windowObject.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
// Radix (the popover, its focus and dismiss layers) reads these by bare global name, and
// happy-dom dispatches only its own event classes (the floating-panel-motion.test.tsx setup).
const radixGlobals = [
  'navigator',
  'customElements',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  // The DOM classes the focus scope and floating-ui test against.
  ...Object.getOwnPropertyNames(windowObject).filter((key) => /^[A-Z]/.test(key) && !(key in globalThis)),
];
const radixOriginals = radixGlobals.map((key) => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }));
const shims: Record<string, unknown> = {
  getComputedStyle: windowObject.getComputedStyle.bind(windowObject),
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
for (const key of radixGlobals) {
  const value = key in shims ? shims[key] : Reflect.get(windowObject, key);
  if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const { key, descriptor } of radixOriginals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  for (const { key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  windowObject.happyDOM.abort();
});

// The workflow reads go through `useSessionWorkflows`: the runs per session id, and the controls it sends.
let runsBySession: Record<string, unknown[]> = {};
let controls: unknown[] = [];
const real = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...real,
  useSessionWorkflows: (_projectId: string | undefined, sessionId: string | undefined) => ({
    data: sessionId ? runsBySession[sessionId] : undefined,
    control: {
      mutate: (variables: unknown) => controls.push(variables),
      isPending: false,
      variables: undefined,
    },
  }),
}));

// Imported after the globals above: Radix picks its layout effect when its module loads,
// and a module loaded before `document` exists never mounts a portal.
const { TooltipProvider } = await import('../../primitives/tooltip');
const { resolveEffectiveBusy } = await import('../status/session-chat-busy');
const { AgentsLineView, AgentsPanel, stripRuns, runSessionIds } = await import('./agent-strip');
const { agentRowOf } = await import('./agent-model');
const { TasksPanel, groupTasks } = await import('./tasks-panel');
const { HeldMessageList, heldPreview } = await import('./held-messages');
const { WorkflowRunControls, workflowFileName, isLargeRun } = await import('./workflow-run-controls');
const { SessionPromptContext } = await import('./session-prompt');
const { parseWorkflowRun } = await import('../tool/tools/workflow-run');

let renderer: ReactTestRenderer | undefined;
const roots: Root[] = [];
beforeEach(() => {
  runsBySession = {};
  controls = [];
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  windowObject.document.body.innerHTML = '';
});

/** Render into the happy-dom page (portals land in its body), as a person's browser would. */
async function mountDom(node: ReactNode) {
  const host = windowObject.document.createElement('div');
  windowObject.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => root.render(wrap(node)));
  const body = windowObject.document.body;
  return {
    line: () => body.querySelector('[data-testid="agents-line"]') as unknown as HTMLButtonElement | null,
    popover: () => body.querySelector('[data-testid="agents-line-popover"]'),
    rows: () => [...body.querySelectorAll('[data-testid="agents-line-row"]')] as unknown as HTMLElement[],
    byLabel: (label: string) => body.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement | null,
  };
}

function wrap(node: ReactNode) {
  return (
    <IntlTestProvider locale="en">
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

function row(id: string, state: string, extra: Record<string, unknown> = {}) {
  return agentRowOf({
    session_id: id,
    agent_handle: id,
    agent_name: 'researcher',
    status: 'running',
    board_state: state,
    created_at: '2026-10-30T11:00:00.000Z',
    updated_at: '2026-10-30T11:59:00.000Z',
    ...extra,
  } as never);
}

const noop = () => {};
const baseProps = {
  projectId: 'proj_1',
  sessionId: 'ses_lead',
  agents: [] as ReturnType<typeof row>[],
  team: [] as ReturnType<typeof row>[],
  runs: [] as NonNullable<ReturnType<typeof parseWorkflowRun>>[],
  tasks: null as SessionTask[] | null,
  onOpen: noop,
  onStop: noop,
  stopping: new Set<string>(),
};

function task(seq: number, status: SessionTask['status'], extra: Partial<SessionTask> = {}): SessionTask {
  return {
    seq,
    lead_session_id: 'ses_lead',
    subject: `Task ${seq}`,
    description: '',
    status,
    owner_handle: null,
    owner_session_id: null,
    blocked_by: [],
    blocked: false,
    created_by_session_id: 'ses_lead',
    created_at: '2026-10-30T11:00:00.000Z',
    updated_at: '2026-10-30T11:00:00.000Z',
    ...extra,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    title: 'Weekly competitor review',
    status: 'running',
    phases: [],
    agents: [
      { id: 'a1', label: 'Research pricing', status: 'done', sessionId: 'ses_a1' },
      { id: 'a2', label: 'Research features', status: 'done', sessionId: 'ses_a2' },
      { id: 'a3', label: 'Draft the summary', status: 'running', sessionId: 'ses_a3' },
      { id: 'a4', label: 'Check sources', status: 'running', sessionId: 'ses_a4' },
      { id: 'a5', label: 'Review', status: 'starting' },
    ],
    startedAt: 1_790_000_000_000,
    ...overrides,
  };
}

describe('AgentsLineView — the line', () => {
  test('renders nothing when the session started no agent and no run', async () => {
    expect(renderToStaticMarkup(wrap(<AgentsLineView {...baseProps} />))).toBe('');
    // A team task list alone is not an agent: still nothing on the line.
    expect(renderToStaticMarkup(wrap(<AgentsLineView {...baseProps} tasks={[task(1, 'pending')]} />))).toBe('');
  });

  test('while an agent works: the count and how many work', () => {
    const html = renderToStaticMarkup(
      wrap(<AgentsLineView {...baseProps} agents={[row('namer', 'working')]} team={[row('editor', 'idle')]} />),
    );
    expect(textOf(html)).toContain('2 agents · 1 working');
    expect(html).toContain('data-testid="agents-line"');
    // One line, no box: the trigger is the ghost button of the under-row, with no border class.
    expect(html).not.toMatch(/class="[^"]*(?<![\w:-])border(?![\w-])/);
  });

  test('when every agent ended: the newest agent is named done', () => {
    const html = renderToStaticMarkup(
      wrap(
        <AgentsLineView
          {...baseProps}
          agents={[
            row('namer', 'completed', { last_activity_at: '2026-10-30T11:10:00.000Z' }),
            row('poet', 'idle', { last_activity_at: '2026-10-30T11:40:00.000Z' }),
          ]}
        />,
      ),
    );
    expect(textOf(html)).toContain('2 agents · poet done');
  });

  test('an agent that waits on the person says so; a running workflow counts in', () => {
    const waiting = textOf(
      renderToStaticMarkup(wrap(<AgentsLineView {...baseProps} agents={[row('a', 'working'), row('b', 'needs_input')]} />)),
    );
    expect(waiting).toContain('2 agents · needs you');
    const flow = textOf(renderToStaticMarkup(wrap(<AgentsLineView {...baseProps} runs={[parseWorkflowRun(run())!]} />)));
    expect(flow).toContain('1 workflow running');
    expect(flow).not.toContain('agents');
  });

  test('compact: the count only, the whole text in the label', () => {
    const html = renderToStaticMarkup(wrap(<AgentsLineView {...baseProps} compact agents={[row('a', 'working'), row('b', 'idle')]} />));
    // The visible text: the count alone (the mark's word is for screen readers).
    expect(html).toContain('truncate">2 agents</span>');
    expect(html).toContain('aria-label="Agents: 2 agents"');
  });

  test('keyboard: the line is a focusable button that opens the popover; Escape closes it', async () => {
    const dom = await mountDom(<AgentsLineView {...baseProps} agents={[row('namer', 'working')]} />);
    const line = dom.line()!;
    // A native button: Enter and Space activate it, as a click does.
    expect(line.tagName).toBe('BUTTON');
    expect(line.getAttribute('type')).toBe('button');
    expect(line.getAttribute('aria-haspopup')).toBe('dialog');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    line.focus();
    expect(windowObject.document.activeElement as unknown).toBe(line);
    expect(dom.popover()).toBeNull();

    await act(async () => line.click());
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(dom.popover()).not.toBeNull();
    expect(dom.rows()).toHaveLength(1);

    // Focus moves to the panel itself (no row tooltip opens); one Escape closes it.
    const focused = windowObject.document.activeElement!;
    expect(focused as unknown).toBe(dom.popover());
    await act(async () => {
      focused.dispatchEvent(new windowObject.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dom.popover()).toBeNull();
    expect(line.getAttribute('aria-expanded')).toBe('false');
  });

  test('a row opens its agent and closes the popover', async () => {
    const opened: string[] = [];
    const dom = await mountDom(
      <AgentsLineView {...baseProps} defaultOpen agents={[row('namer', 'working')]} onOpen={(target) => opened.push(target.sessionId)} />,
    );
    await act(async () => dom.byLabel('Open namer')!.click());
    expect(opened).toEqual(['namer']);
    expect(dom.popover()).toBeNull();
  });
});

describe('AgentsPanel — the popover rows', () => {
  const panel = (props: Partial<ComponentProps<typeof AgentsPanel>>) =>
    renderToStaticMarkup(wrap(<AgentsPanel {...baseProps} live={false} {...props} />));

  test('one row per agent: state mark, handle, short state, "runs as" the agent display name', () => {
    const html = panel({
      agents: [
        row('namer', 'working', { agent_name: 'mykortix' }),
        row('poet', 'idle', { agent_name: 'kortix', result_excerpt: 'A haiku about the release' }),
      ],
    });
    const text = textOf(html);
    expect(html.match(/data-testid="agents-line-row"/g)).toHaveLength(2);
    expect(text).toContain('namer');
    expect(text).toContain('runs as My Kortix');
    expect(text).toContain('runs as Kortix');
    // Never the raw slug as its own word.
    expect(text).not.toMatch(/\bmykortix\b/);
    expect(text).toContain('working');
    expect(text).toContain('done');
    // The result is a hover hint, never inline.
    expect(text).not.toContain('A haiku about the release');
    // Open on every row; Stop only while it works or waits.
    expect(html).toContain('aria-label="Open namer"');
    expect(html).toContain('aria-label="Open poet"');
    expect(html).toContain('aria-label="Stop namer"');
    expect(html).not.toContain('aria-label="Stop poet"');
  });

  test('a working row shows how long it works', () => {
    const since = new Date(Date.now() - 90_000).toISOString();
    const text = textOf(
      panel({ agents: [row('namer', 'working', { working: { state: 'working', since, turn_token: null, pending_delivery: false } })] }),
    );
    expect(text).toContain('working · 1m');
  });

  test('a row without a name of its own is called by the agent display name, with no "runs as"', () => {
    const text = textOf(panel({ agents: [row('x', 'idle', { agent_handle: null, agent_name: 'kortix' })] }));
    expect(text).toContain('Kortix');
    expect(text).not.toContain('runs as');
  });

  test('teammates sit under Team; the Agents header shows only beside another group', () => {
    const alone = textOf(panel({ agents: [row('helper', 'working')] }));
    expect(alone).not.toContain('Agents');
    expect(alone).not.toContain('Team');
    const both = textOf(panel({ agents: [row('helper', 'working')], team: [row('writer', 'needs_input', { attention: 'question' })] }));
    expect(both).toContain('Agents');
    expect(both).toContain('Team');
    expect(both).toContain('needs you');
  });

  test('the Tasks tab shows only when the session leads a team, with its open count', async () => {
    expect(textOf(panel({ team: [row('writer', 'working')] }))).not.toContain('Tasks');
    const dom = await mountDom(
      <AgentsPanel {...baseProps} live={false} team={[row('writer', 'working')]} tasks={[task(1, 'pending'), task(2, 'completed')]} />,
    );
    const body = windowObject.document.body;
    const tab = [...body.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.includes('Tasks'))!;
    expect(tab.textContent).toContain('1');
    expect(body.querySelector('[aria-label="Team tasks"]')).toBeNull();
    await act(async () => {
      // Radix tabs activate on mousedown.
      tab.dispatchEvent(new windowObject.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(body.querySelector('[aria-label="Team tasks"]')).not.toBeNull();
    expect(dom.rows()).toHaveLength(0);
  });

  test('a background workflow run sits under Workflows with its live progress', () => {
    const background = parseWorkflowRun(run({ background: { sessionId: 'ses_runner' }, agents: [] }))!;
    runsBySession = { ses_runner: [run()] };
    const html = panel({ runs: [background] });
    const text = textOf(html);
    expect(text).toContain('Workflows');
    expect(text).toContain('Weekly competitor review');
    // Read from the runner: 2 of its 5 agents are done, and it runs after this turn ended.
    expect(text).toContain('Running in the background · 2 of 5 done');
    expect(html).toContain('aria-label="Open run"');
    // Its controls: pause and stop go to the runner.
    expect(html).toContain('aria-label="Pause the run"');
    expect(html).toContain('data-testid="agents-line-row"');
  });
});

describe('TasksPanel', () => {
  test('groups pending, in progress and completed, with the owner and what a task waits for', () => {
    const tasks = [
      task(3, 'pending', { blocked: true, blocked_by: [1, 2] }),
      task(1, 'in_progress', { owner_handle: 'writer' }),
      task(2, 'completed', { owner_handle: 'editor' }),
    ];
    expect(Object.fromEntries(Object.entries(groupTasks(tasks)).map(([k, v]) => [k, v.map((t) => t.seq)]))).toEqual({
      pending: [3],
      in_progress: [1],
      completed: [2],
    });
    const text = textOf(renderToStaticMarkup(wrap(<TasksPanel tasks={tasks} />)));
    expect(text.indexOf('Pending')).toBeLessThan(text.indexOf('In progress'));
    expect(text.indexOf('In progress')).toBeLessThan(text.indexOf('Completed'));
    expect(text).toContain('#3');
    expect(text).toContain('Blocked by #1, #2');
    expect(text).toContain('@writer');
    expect(text).toContain('Open');
  });

  test('an empty list says tasks will show up', () => {
    expect(textOf(renderToStaticMarkup(wrap(<TasksPanel tasks={[]} />)))).toContain('Tasks the team plans will show up here.');
  });
});

describe('held messages', () => {
  const message = (id: string, status: PeerMessage['status'], extra: Partial<PeerMessage> = {}): PeerMessage => ({
    id,
    project_id: 'proj_1',
    from_session_id: 'ses_rev',
    from_handle: 'reviewer',
    to_session_id: 'ses_lead',
    to_handle: 'lead',
    type: 'message',
    message: 'The schema migration finished.\nRebase is safe now.',
    summary: null,
    status,
    notify_when_idle: false,
    created_at: '2026-10-30T11:00:00.000Z',
    decided_at: null,
    ...extra,
  });

  test('one card per held message; Approve and Deny decide that message', async () => {
    const approved: string[] = [];
    const denied: string[] = [];
    const approve = { mutate: (id: string) => approved.push(id), isPending: false, variables: undefined } as never;
    const deny = { mutate: (id: string) => denied.push(id), isPending: false, variables: undefined } as never;
    await act(async () => {
      renderer = create(
        wrap(<HeldMessageList messages={[message('m1', 'held'), message('m2', 'delivered'), message('m3', 'held', { summary: 'Migration done' })]} approve={approve} deny={deny} />),
      );
    });
    const cards = renderer!.root.findAll((node) => typeof node.props['data-held-message'] === 'string' && node.type === 'div');
    expect(cards.map((card) => card.props['data-held-message'])).toEqual(['m1', 'm3']);
    const button = (card: (typeof cards)[number], label: string) =>
      card.findAll((node) => node.type === 'button' && JSON.stringify(node.props.children).includes(label))[0]!;
    await act(async () => button(cards[0]!, 'Approve').props.onClick());
    await act(async () => button(cards[1]!, 'Deny').props.onClick());
    expect(approved).toEqual(['m1']);
    expect(denied).toEqual(['m3']);
  });

  test('the card names the sender and previews the summary, else the first line', () => {
    expect(heldPreview(message('m', 'held'))).toBe('The schema migration finished.');
    expect(heldPreview(message('m', 'held', { summary: 'Migration done' }))).toBe('Migration done');
    const approve = { mutate: noop, isPending: false } as never;
    const text = textOf(renderToStaticMarkup(wrap(<HeldMessageList messages={[message('m1', 'held')]} approve={approve} deny={approve} />)));
    expect(text).toContain('Message from @reviewer');
    expect(text).toContain('Waiting for your approval');
  });

  test('nothing renders when no message waits', () => {
    const approve = { mutate: noop, isPending: false } as never;
    expect(renderToStaticMarkup(wrap(<HeldMessageList messages={[message('m', 'delivered')]} approve={approve} deny={approve} />))).toBe('');
  });
});

describe('WorkflowRunControls', () => {
  const live = parseWorkflowRun(run())!;

  async function mount(node: ReactNode, send?: (text: string) => void) {
    await act(async () => {
      renderer = create(wrap(send ? <SessionPromptContext.Provider value={send}>{node}</SessionPromptContext.Provider> : node));
    });
    return (label: string) => renderer!.root.findByProps({ 'aria-label': label });
  }

  test('pause, stop and save send their controls to the box that runs the run', async () => {
    const sent: string[] = [];
    const button = await mount(
      <WorkflowRunControls projectId="proj_1" controlSessionId="ses_runner" ownerSessionId="ses_lead" run={live} />,
      (text) => void sent.push(text),
    );
    await act(async () => button('Pause the run').props.onClick({ stopPropagation: noop }));
    await act(async () => button('Stop the run').props.onClick({ stopPropagation: noop }));
    expect(controls).toEqual([
      { runId: 'run-1', body: { action: 'pause' } },
      { runId: 'run-1', body: { action: 'stop' } },
    ]);
    await act(async () => button('Save').props.onClick({ stopPropagation: noop }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('.kortix/workflows/weekly-competitor-review.js');
    expect(sent[0]).toContain('change request');
  });

  test('a paused run offers Resume', async () => {
    const button = await mount(
      <WorkflowRunControls projectId="proj_1" controlSessionId="ses_runner" ownerSessionId="ses_lead" run={{ ...live, paused: true }} />,
    );
    await act(async () => button('Resume the run').props.onClick({ stopPropagation: noop }));
    expect(controls).toEqual([{ runId: 'run-1', body: { action: 'resume' } }]);
  });

  test('a finished run has no pause or stop; a saved workflow has no save', () => {
    const done = { ...live, status: 'done' as const };
    const html = renderToStaticMarkup(wrap(<WorkflowRunControls projectId="proj_1" controlSessionId="ses_runner" ownerSessionId="ses_lead" run={done} />));
    expect(html).not.toContain('Pause the run');
    expect(html).not.toContain('Stop the run');
    expect(html).toContain('aria-label="Save"');
    expect(
      renderToStaticMarkup(wrap(<WorkflowRunControls projectId="proj_1" controlSessionId="ses_runner" ownerSessionId="ses_lead" run={{ ...done, name: 'weekly-review' }} />)),
    ).toBe('');
  });

  test('file names and the large-run threshold', () => {
    expect(workflowFileName({ title: 'Weekly competitor review!' })).toBe('weekly-competitor-review');
    expect(workflowFileName({ name: 'audit-routes', title: 'x' })).toBe('audit-routes');
    expect(workflowFileName({ title: '' })).toBe('workflow');
    const agents = Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, label: `a${i}`, status: 'running' as const }));
    expect(isLargeRun({ agents })).toBe(true);
    expect(isLargeRun({ agents: agents.slice(0, 25) })).toBe(false);
    expect(isLargeRun({ agents: [], large: true })).toBe(true);
  });
});

describe('the agents line never holds the composer', () => {
  test("busy is this session's own turn: working agents on the line add nothing to it", () => {
    // `resolveEffectiveBusy` is the one busy value the composer reads; it takes no child state.
    expect(resolveEffectiveBusy({ isServerBusy: false, isOptimisticCompacting: false, hasRetryingAssistant: false })).toBe(false);
    const html = renderToStaticMarkup(
      wrap(<AgentsPanel {...baseProps} live={false} agents={[row('a', 'working'), row('b', 'working')]} runs={[parseWorkflowRun(run())!]} />),
    );
    // No control in the popover is disabled while agents work, and nothing claims the page is busy.
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('aria-busy');
  });

  test('stripRuns lists running runs and runs that ended in the last hour; runSessionIds owns their sessions', () => {
    const now = 1_790_000_000_000 + 10 * 60_000;
    const runs = stripRuns(
      [
        run(),
        run({ runId: 'old', status: 'done', endedAt: now - 2 * 60 * 60_000 }),
        run({ runId: 'recent', status: 'done', endedAt: now - 60_000, background: { sessionId: 'ses_runner' } }),
      ] as never,
      now,
    );
    expect(runs.map((r) => r.runId)).toEqual(['run-1', 'recent']);
    expect([...runSessionIds(runs)].sort()).toEqual(['ses_a1', 'ses_a2', 'ses_a3', 'ses_a4', 'ses_runner']);
  });
});
