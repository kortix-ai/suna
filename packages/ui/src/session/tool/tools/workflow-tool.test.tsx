import { toolCallBlock } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import './register';
import { TooltipProvider } from '../../../primitives/tooltip';
import { ToolRunningContext } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolPartRenderer } from '../tool-part-renderer';
import type { ToolPart } from '../../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { runFromChildren, WorkflowTool } from './workflow-tool';
import { WorkflowRunRows } from './workflow-run-card';
import { SessionIdsProvider } from '../../../providers/session-ids';

// Synthetic values only: every title, id and session id below is invented.

let intlErrors: unknown[] = [];

function render(
  node: ReactNode,
  opts: { running?: boolean; projectId?: string; sessionId?: string; client?: QueryClient } = {},
) {
  intlErrors = [];
  const running = opts.running ? <ToolRunningContext.Provider value>{node}</ToolRunningContext.Provider> : node;
  const tree = opts.projectId ? (
    <SessionIdsProvider projectId={opts.projectId} sessionId={opts.sessionId}>
      {running}
    </SessionIdsProvider>
  ) : (
    running
  );
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={(error) => intlErrors.push(error)}>
      <QueryClientProvider client={opts.client ?? new QueryClient()}>
        <TooltipProvider>{tree}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
  expect(intlErrors).toEqual([]);
  return html;
}

function textOf(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    title: 'Weekly competitor review',
    status: 'running',
    phases: [
      { title: 'Research', status: 'done' },
      { title: 'Write', status: 'running' },
    ],
    agents: [
      { id: 'a1', label: 'Research pricing', agent: 'researcher', phase: 'Research', status: 'done', sessionId: 'ses_a1', summary: 'Found 4 price changes' },
      { id: 'a2', label: 'Research features', agent: 'researcher', phase: 'Research', status: 'running', sessionId: 'ses_a2' },
      { id: 'a3', label: 'Draft the summary', agent: 'writer', phase: 'Write', status: 'starting' },
    ],
    startedAt: 1_790_000_000_000,
    ...overrides,
  };
}

function call(state: Record<string, unknown>, name = 'workflow', input: Record<string, unknown> = { script: 'const a = await agent("go")' }) {
  return toolCallBlock({ type: 'tool', tool: name, callID: 'call-1', state: { input, ...state } } as unknown as ToolPart);
}

describe('WorkflowTool registration', () => {
  test('`workflow` has its own renderer', () => {
    expect(ToolRegistry.get('workflow')).toBe(WorkflowTool);
  });
});

describe('WorkflowTool — running', () => {
  test('a live run shows its title, progress and one closed row per phase', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    // The second line names the phase at work; the ring says the whole run.
    expect(text).toContain('Write 0 of 1 done');
    // Each phase is one row with its progress; its agents wait behind it, so the card stays short.
    expect(text).toContain('Research1 of 2 done');
    expect(html.match(/data-workflow-phase=/g)).toHaveLength(2);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(text).not.toContain('Research pricing');
    expect(text).not.toContain('Found 4 price changes');
  });

  test('the card leads with a progress ring of done and failed agents; before agents, the workflow glyph', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true });
    expect(html).toContain('data-tone="run-progress"');
    expect(html).toContain('data-done="1"');
    expect(html).toContain('data-failed="0"');
    expect(html).toContain('data-total="3"');
    // Each phase leads with its own ring of its agents.
    expect(html).toContain('data-total="2"');
    const empty = render(<WorkflowTool call={call({ status: 'running', metadata: run({ agents: [] }) })} />, { running: true });
    expect(empty.split('</header>')[0]).not.toContain('data-tone="run-progress"');
  });

  test('before the first update it says the workflow is starting', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: {} })} />, { running: true });
    expect(textOf(html)).toContain('Starting the workflow…');
  });

  test('a call that returned while the run goes on says it runs in the background', () => {
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'Started run-1', metadata: run() })} />);
    expect(textOf(html)).toContain('Running in the background · Write 0 of 1 done');
  });
});

describe('WorkflowTool — settled', () => {
  test('a finished run counts its agents and keeps its rows in view', () => {
    const finished = run({
      status: 'done',
      endedAt: 1_790_000_060_000,
      phases: [{ title: 'Research', status: 'done' }, { title: 'Write', status: 'done' }],
      agents: run().agents.map((agent) => ({ ...agent, status: 'done', sessionId: agent.sessionId ?? 'ses_a3' })),
    });
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'Review done', metadata: finished })} />);
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('3 agents');
    expect(text).toContain('Research2 of 2 done');
    expect(text).not.toContain('Research pricing');
  });

  test('a failed run leads with its error and marks the failed agent', () => {
    const failed = run({
      status: 'failed',
      error: 'Research features failed: the model refused\nstack line',
      agents: [
        run().agents[0],
        { ...run().agents[1], status: 'failed', summary: 'The model refused' },
      ],
    });
    const html = render(<WorkflowTool call={call({ status: 'completed', output: '', metadata: failed })} defaultOpen />);
    const text = textOf(html);
    // One sentence; the raw error folds behind Details, never shown as the message.
    expect(text).toContain('The workflow stopped before it finished.');
    expect(text).not.toContain('Research features failed: the model refused');
    expect(html).toContain('aria-expanded="false"');
    // The phase row counts the failure; the agent's reason waits behind it.
    expect(text).toContain('Didn’t finish');
    expect(text).toContain('1 failed');
  });

  test('sixteen agents are sixteen dense rows in one list, never a card each', () => {
    const agents = Array.from({ length: 16 }, (_, i) => ({ id: `a${i + 1}`, label: `Check market ${i + 1}`, agent: 'researcher', status: i < 10 ? 'done' : 'running', sessionId: `ses_m${i + 1}` }));
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ phases: [], agents }) })} />, { running: true });
    expect(textOf(html)).toContain('10 of 16 done');
    expect(html.match(/aria-label="Open Check market \d+,/g)).toHaveLength(16);
    // One card holds every row.
    expect(html.match(/data-testid="workflow-card"/g)).toHaveLength(1);
  });

  test('a call that threw keeps its agent rows instead of the generic error row', () => {
    const html = render(<ToolPartRenderer call={call({ status: 'error', error: 'Workflow stopped: aborted', metadata: run({ status: 'stopped' }) })} />);
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('Stopped');
    expect(html).toContain('data-workflow-phase="Research"');
  });
});

const T0 = 1_790_000_000_000;

describe('WorkflowTool — header', () => {
  test('a finished run says how many agents ran and how long it took', () => {
    const finished = run({
      status: 'done',
      endedAt: T0 + 125_000,
      phases: [],
      agents: [{ id: 'a1', label: 'Research pricing', status: 'done', sessionId: 'ses_a1' }],
    });
    const text = textOf(render(<WorkflowTool call={call({ status: 'completed', output: '', metadata: finished })} />));
    expect(text).toContain('1 agent · 2m 05s');
  });

  test('a live run counts its failures beside its progress', () => {
    const live = run({ agents: [...run().agents, { id: 'a4', label: 'Check reviews', status: 'failed', summary: 'Rate limited' }] });
    const text = textOf(render(<WorkflowTool call={call({ status: 'running', metadata: live })} />, { running: true }));
    expect(text).toContain('Write 0 of 1 done · 1 failed');
  });

  test('a saved workflow without a title is named by its saved name', () => {
    const text = textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run({ title: '', name: 'audit-routes' }) })} />, { running: true }));
    expect(text).toContain('audit-routes');
    expect(text).not.toContain('Saved workflow');
  });

  test('a large run carries the "Large workflow" warning chip; a relaunch carries "Resumed"', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ large: true, resumedFrom: 'run-0' }) })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('Large workflow');
    expect(text).toContain('Resumed');
    expect(html).toContain('data-slot="badge"');
    const plain = textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true }));
    expect(plain).not.toContain('Large workflow');
    expect(plain).not.toContain('Resumed');
  });
});

describe('WorkflowTool — background run', () => {
  const background = run({ agents: [], phases: [], background: { sessionId: 'ses_runner' } });

  test('a background run is one card line: its title and Open run, nothing about where it runs', () => {
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'Started in the background', metadata: background })} />);
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).not.toContain('Running in the background');
    expect(text).not.toContain('In its own session');
    expect(html).toContain('aria-label="Open the run&#x27;s session"');
    expect(text).toContain('Open run');
    // No disclosure: one bordered card that leads to the run's session.
    expect(html).toContain('data-testid="workflow-run-link"');
    expect(html).toContain('rounded-lg border');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('aria-label="Open Research');
  });
});

describe('WorkflowTool — background run read live from its runner', () => {
  const background = run({ agents: [], phases: [], background: { sessionId: 'ses_runner' } });
  const settledCall = call({ status: 'completed', output: 'Started in the background', metadata: background });

  function runnerHolds(runnerRun: Record<string, unknown>) {
    const client = new QueryClient();
    client.setQueryData(qk.project.sessionWorkflows('proj_1', 'ses_runner'), [runnerRun]);
    return client;
  }

  test("after the parent's turn ended, the card shows the runner's live progress and keeps it open", () => {
    const html = render(<WorkflowTool call={settledCall} />, { projectId: 'proj_1', sessionId: 'ses_lead', client: runnerHolds(run()) });
    const text = textOf(html);
    expect(text).toContain('Running in the background · Write 0 of 1 done');
    expect(text).toContain('Research1 of 2 done');
    // Its phases are closed rows: the card stays short while the run works on.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    // The controls go to the runner: Pause and Stop as words; a running agent keeps its own Restart and Stop.
    expect(html).toContain('aria-label="Pause the run"');
    expect(html).toContain('aria-label="Stop the run"');
    expect(html).toContain('aria-label="Open the run&#x27;s session"');
  });

  test('the next poll of the runner updates the same card', () => {
    const later = run({
      agents: run().agents.map((agent) => ({ ...agent, status: 'done', sessionId: agent.sessionId ?? 'ses_a3' })),
    });
    const text = textOf(render(<WorkflowTool call={settledCall} />, { projectId: 'proj_1', sessionId: 'ses_lead', client: runnerHolds(later) }));
    expect(text).toContain('Running in the background · Write 1 of 1 done');
  });

  test('a paused run says so and offers Resume', () => {
    const html = render(<WorkflowTool call={settledCall} />, {
      projectId: 'proj_1',
      sessionId: 'ses_lead',
      client: runnerHolds(run({ paused: true })),
    });
    expect(textOf(html)).toContain('Paused · Write 0 of 1 done');
    expect(html).toContain('aria-label="Resume the run"');
  });

  test('a run that finished in its runner reads as finished, with no pause or stop', () => {
    const done = run({ status: 'done', endedAt: 1_790_000_060_000, agents: run().agents.map((agent) => ({ ...agent, status: 'done' })) });
    const html = render(<WorkflowTool call={settledCall} />, { projectId: 'proj_1', sessionId: 'ses_lead', client: runnerHolds(done) });
    expect(textOf(html)).toContain('3 agents');
    expect(html).not.toContain('aria-label="Pause the run"');
    // Ended, the card says how it ended and keeps its phase rows.
    expect(textOf(html)).toContain('Done · 3 agents');
    expect(textOf(html)).toContain('Research2 of 2 done');
    expect(html).toContain('aria-label="Open the run&#x27;s session"');
  });

  test('more than 25 agents carry the Large workflow chip', () => {
    const agents = Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, label: `Agent ${i}`, status: 'running', sessionId: `ses_${i}` }));
    expect(textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run({ agents }) })} />, { running: true }))).toContain('Large workflow');
  });
});

describe('WorkflowTool — phases', () => {
  const phased = run({
    phases: [
      { title: 'Research', status: 'done' },
      { title: 'Write', status: 'running' },
      { title: 'Review', status: 'pending' },
    ],
    agents: [
      { id: 'a1', label: 'Research pricing', phase: 'Research', status: 'done', sessionId: 'ses_a1', summary: 'Found 4 price changes' },
      { id: 'a2', label: 'Research features', phase: 'Research', status: 'done', sessionId: 'ses_a2', summary: 'Found 2 features' },
      { id: 'a3', label: 'Draft the summary', phase: 'Write', status: 'running', sessionId: 'ses_a3' },
    ],
  });

  test('phases are rows in order, with no rules between them; a phase not started has no caret and says what it waits for', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: phased })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('Research2 of 2 done');
    expect(text).toContain('Write0 of 1 done');
    const at = (needle: string) => text.indexOf(needle);
    expect(at('Research2 of 2')).toBeLessThan(at('Write0 of 1'));
    expect(at('Write0 of 1')).toBeLessThan(at('Review'));
    expect(text).not.toContain('Starts after');
    expect(text).toContain('Waits for 1 more');
    expect(html).not.toContain('border-dashed');
    // Two phases with agents open; the one not started is a plain row.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });
});

describe('WorkflowTool — agent rows', () => {
  test('no Stop without a project to stop it in, and none once the call settled', () => {
    expect(render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true })).not.toContain('aria-label="Stop');
    const done = run({ status: 'done', agents: run().agents.map((a) => ({ ...a, status: 'done' })) });
    expect(render(<WorkflowTool call={call({ status: 'completed', output: '', metadata: done })} />, { projectId: 'proj_1' })).not.toContain('aria-label="Stop');
  });

  test('a phase of more than 25 agents shows 20 rows and a "Show all" button', () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `a${i + 1}`, label: `Check file ${i + 1}`, status: 'done', sessionId: `ses_f${i + 1}` }));
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ phases: [], agents }) })} />, { running: true });
    expect(html.match(/aria-label="Open Check file \d+,/g)).toHaveLength(20);
    expect(textOf(html)).toContain('Show all 30');
  });
});

describe('WorkflowTool — logs and result', () => {
  test('a finished run folds its result away under "Result", without the raw tags', () => {
    const finished = run({ status: 'done', endedAt: T0 + 60_000, agents: run().agents.map((a) => ({ ...a, status: 'done' })) });
    const output = '<workflow_result>\n## Summary\nThree competitors cut prices.\n</workflow_result>\nagents: 3 (3 done)';
    const html = render(<WorkflowTool call={call({ status: 'completed', output, metadata: finished })} defaultOpen />);
    const text = textOf(html);
    expect(text).toContain('Result');
    expect(text).not.toContain('Show details');
    expect(text).not.toContain('workflow_result');
    expect(text).not.toContain('agents: 3');
  });

  test('a failed run shows its error once: no raw fold that repeats the error block', () => {
    const failed = run({ status: 'failed', error: 'Write failed: every writer timed out' });
    const output = '<workflow_error>\nWrite failed: every writer timed out\n</workflow_error>\nagents: 3 (1 done, 2 failed)';
    const text = textOf(render(<WorkflowTool call={call({ status: 'completed', output, metadata: failed })} defaultOpen />));
    expect(text.match(/The workflow stopped before it finished\./g)).toHaveLength(1);
    expect(text).not.toContain('Write failed: every writer timed out');
    expect(text).not.toContain('Show details');
    expect(text).not.toContain('workflow_error');
  });
});

describe('WorkflowTool — falls back to the generic card', () => {
  test('a settled call whose metadata is not a run', () => {
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'ok', metadata: { foo: 1 } }, 'workflow', { name: 'nightly-review' })} />);
    expect(textOf(html)).toContain('nightly-review');
  });

  test('another tool whose name ends in workflow never draws as a run', () => {
    // The registry matches a registered name as a suffix, so `n8n_workflow` reaches this renderer.
    expect(ToolRegistry.get('n8n_workflow')).toBe(WorkflowTool);
    const html = render(<ToolPartRenderer call={call({ status: 'running', metadata: run() }, 'n8n_workflow', { name: 'sync-crm' })} />);
    const text = textOf(html);
    expect(text).toContain('sync-crm');
    expect(text).not.toContain('Starting the workflow');
    expect(text).not.toContain('Research pricing');
  });
});

describe('runFromChildren (a live run read from the session list)', () => {
  const child = (id: string, created: string, name: string, status: string) =>
    ({ session_id: id, created_at: created, name, agent_name: 'worker', status }) as never;

  test('lists the children started since the call, oldest first, with the workflow title stripped from their names', () => {
    const started = Date.parse('2026-10-30T18:00:00Z');
    const run = runFromChildren(
      [
        child('s-old', '2026-10-30T17:00:00Z', 'An earlier hand-off', 'completed'),
        child('s-b', '2026-10-30T18:00:03Z', 'Research ClickUp (Notion research)', 'running'),
        child('s-a', '2026-10-30T18:00:02Z', 'Research Coda (Notion research)', 'completed'),
      ],
      started,
      { description: 'Notion research' },
    );
    expect(run?.title).toBe('Notion research');
    expect(run?.agents.map((a) => [a.label, a.status, a.sessionId])).toEqual([
      ['Research Coda', 'done', 's-a'],
      ['Research ClickUp', 'running', 's-b'],
    ]);
  });

  test('is null until the first child exists', () => {
    expect(runFromChildren([], Date.now(), {})).toBeNull();
  });
});

describe('WorkflowRunRows — an open phase', () => {
  test('nests its agents on the trunk, and a running agent keeps Restart and Stop beside its row', () => {
    const stop = { enabled: true, pending: new Set<string>(), stop: () => {}, restart: { run: () => {} } };
    const html = render(
      <WorkflowRunRows run={run() as never} live now={1_790_000_100_000} onOpen={() => {}} stop={stop} openPhases={['Research']} />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('rounded-bl-md');
    expect(html).toContain('aria-label="Open Research pricing,');
    expect(html).toContain('aria-label="Restart Research features"');
    expect(html).toContain('aria-label="Stop Research features"');
    // The phase that stays closed shows none of its agents.
    expect(textOf(html)).not.toContain('Draft the summary');
  });
});

describe('WorkflowRunRows — the phase ring', () => {
  test('a done phase draws the done check only when every agent finished', () => {
    const stop = { enabled: false, pending: new Set<string>(), stop: () => {} };
    const doc = (status: string) =>
      run({ status: 'done', phases: [{ title: 'Plan', status: 'done' }], agents: [{ id: 'a', label: 'Draft', phase: 'Plan', status, sessionId: 'ses_a' }] });
    const check = 'data-ended="done"';
    expect(render(<WorkflowRunRows run={doc('done') as never} live={false} now={0} onOpen={() => {}} stop={stop} />)).toContain(check);
    expect(render(<WorkflowRunRows run={doc('stopped') as never} live={false} now={0} onOpen={() => {}} stop={stop} />)).not.toContain(check);
  });
});
