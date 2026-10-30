import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PeerMessage, SessionTask } from '@kortix/sdk';
import { IntlTestProvider } from '../../test-utils/intl';
import { TooltipProvider } from '../../primitives/tooltip';
import { resolveEffectiveBusy } from '../status/session-chat-busy';

// Synthetic values only: every id, name and text below is invented.

const windowObject = new Window();
const originals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
Object.defineProperty(globalThis, 'window', { value: windowObject, configurable: true });
Object.defineProperty(globalThis, 'document', { value: windowObject.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
afterAll(() => {
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

const { AgentStripView, stripRuns, runSessionIds } = await import('./agent-strip');
const { agentRowOf } = await import('./agent-model');
const { TasksPanel, groupTasks } = await import('./tasks-panel');
const { HeldMessageList, heldPreview } = await import('./held-messages');
const { WorkflowRunControls, workflowFileName, isLargeRun } = await import('./workflow-run-controls');
const { SessionPromptContext } = await import('./session-prompt');
const { parseWorkflowRun } = await import('../tool/tools/workflow-run');

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  runsBySession = {};
  controls = [];
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

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

describe('AgentStripView — rows and groups', () => {
  test('renders nothing when the session started no agent', () => {
    expect(renderToStaticMarkup(wrap(<AgentStripView {...baseProps} />))).toBe('');
  });

  test('the header counts agents and working ones; teammates sit under Team', () => {
    const html = renderToStaticMarkup(
      wrap(
        <AgentStripView
          {...baseProps}
          agents={[row('helper', 'working', { result_excerpt: 'Reading the pricing page' })]}
          team={[row('writer', 'needs_input', { attention: 'question' }), row('editor', 'idle')]}
        />,
      ),
    );
    const text = textOf(html);
    expect(text).toContain('3 agents · 1 working · 1 needs you');
    expect(text).toContain('Team');
    expect(text).toContain('helper');
    expect(text).toContain('Reading the pricing page');
    expect(text).toContain('writer');
    // A working or waiting agent can be stopped; an idle one cannot.
    expect(html).toContain('aria-label="Stop helper"');
    expect(html).toContain('aria-label="Stop writer"');
    expect(html).not.toContain('aria-label="Stop editor"');
    expect(html).toContain('aria-label="Open helper"');
  });

  test('more than three idle agents fold into one "N idle agents" row', () => {
    const idle = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => row(id, 'idle'));
    const text = textOf(renderToStaticMarkup(wrap(<AgentStripView {...baseProps} agents={[row('w', 'working'), ...idle]} />)));
    expect(text).toContain('2 idle agents');
    expect(text).toContain('i3');
    expect(text).not.toContain('i4');
  });

  test('a background workflow run sits under Workflows with its live progress', () => {
    const background = parseWorkflowRun(run({ background: { sessionId: 'ses_runner' }, agents: [] }))!;
    runsBySession = { ses_runner: [run()] };
    const text = textOf(renderToStaticMarkup(wrap(<AgentStripView {...baseProps} runs={[background]} />)));
    expect(text).toContain('Workflows');
    expect(text).toContain('Weekly competitor review');
    // Read from the runner: 2 of its 5 agents are done, and it runs after this turn ended.
    expect(text).toContain('Running in the background · 2 of 5 done');
    expect(text).toContain('Open run');
  });
});

describe('AgentStripView — keyboard', () => {
  test('↑ ↓ move, Enter opens, x stops, Esc clears', async () => {
    const opened: string[] = [];
    const stopped: string[] = [];
    await act(async () => {
      renderer = create(
        wrap(
          <AgentStripView
            {...baseProps}
            agents={[row('first', 'working'), row('second', 'idle')]}
            onOpen={(target) => opened.push(target.sessionId)}
            onStop={(target) => stopped.push(target.sessionId)}
          />,
        ),
      );
    });
    const strip = () => renderer!.root.findByProps({ 'data-agent-strip': true });
    const key = async (key: string, extra: Record<string, unknown> = {}) =>
      act(async () => {
        strip().props.onKeyDown({ key, target: windowObject.document.body, defaultPrevented: false, preventDefault: noop, stopPropagation: noop, ...extra });
      });
    const selected = () =>
      renderer!.root.findAll((node) => node.type === 'li' && node.props['data-agent-row'] && node.props['data-selected'] === true).map((node) => node.props['data-agent-row']);

    await key('ArrowDown');
    expect(selected()).toEqual(['first']);
    await key('x');
    expect(stopped).toEqual(['first']);
    await key('ArrowDown');
    expect(selected()).toEqual(['second']);
    await key('Enter');
    expect(opened).toEqual(['second']);
    // An idle agent has nothing to stop.
    await key('x');
    expect(stopped).toEqual(['first']);
    await key('Escape');
    expect(selected()).toEqual([]);
  });

  test('Ctrl+T shows the task list of a team the session leads', async () => {
    await act(async () => {
      renderer = create(wrap(<AgentStripView {...baseProps} team={[row('writer', 'working')]} tasks={[task(1, 'pending')]} />));
    });
    const has = () => renderer!.root.findAll((node) => node.props['aria-label'] === 'Team tasks').length > 0;
    expect(has()).toBe(false);
    await act(async () => {
      renderer!.root
        .findByProps({ 'data-agent-strip': true })
        .props.onKeyDown({ key: 't', ctrlKey: true, target: windowObject.document.body, preventDefault: noop, stopPropagation: noop });
    });
    expect(has()).toBe(true);
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

describe('the strip never holds the composer', () => {
  test("busy is this session's own turn: working agents in the strip add nothing to it", () => {
    // `resolveEffectiveBusy` is the one busy value the composer reads; it takes no child state.
    expect(resolveEffectiveBusy({ isServerBusy: false, isOptimisticCompacting: false, hasRetryingAssistant: false })).toBe(false);
    const html = renderToStaticMarkup(
      wrap(<AgentStripView {...baseProps} agents={[row('a', 'working'), row('b', 'working')]} runs={[parseWorkflowRun(run())!]} />),
    );
    // No control in the strip is disabled while agents work, and nothing claims the page is busy.
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
