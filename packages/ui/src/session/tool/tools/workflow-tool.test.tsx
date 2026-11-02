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
import {
  agentMatches,
  countAgents,
  elapsedMs,
  formatElapsed,
  groupAgents,
  parseWorkflowResult,
  parseWorkflowRun,
  structuredSummary,
} from './workflow-run';
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
  test('a live run shows its title, progress, phases and one row per agent, open', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('1 of 3 done');
    expect(text).toContain('Research');
    expect(text).toContain('Write');
    expect(text).toContain('Research pricing');
    expect(text).toContain('researcher');
    expect(text).toContain('Found 4 price changes');
    expect(text).toContain('Draft the summary');
    expect(text).toContain('writer');
    // A running run opens itself: its rows are the thing to watch.
    expect(html).toContain('aria-expanded="true"');
    // An agent with a session opens it; one still starting has nothing to open yet.
    expect(html).toContain('aria-label="Open Research pricing"');
    expect(html).toContain('aria-label="Open Research features"');
    expect(html).not.toContain('aria-label="Open Draft the summary"');
  });

  test('before the first update it says the workflow is starting', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: {} })} />, { running: true });
    expect(textOf(html)).toContain('Starting the workflow…');
  });

  test('a call that returned while the run goes on says it runs in the background', () => {
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'Started run-1', metadata: run() })} />);
    expect(textOf(html)).toContain('Running in the background · 1 of 3 done');
  });
});

describe('WorkflowTool — settled', () => {
  test('a finished run counts its agents and stays closed', () => {
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
    expect(html).toContain('aria-expanded="false"');
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
    expect(text).toContain('Research features failed: the model refused');
    expect(text).toContain('The model refused');
    expect(text).toContain('Failed');
  });

  test('sixteen agents are sixteen dense rows in one list, never a card each', () => {
    const agents = Array.from({ length: 16 }, (_, i) => ({ id: `a${i + 1}`, label: `Check market ${i + 1}`, agent: 'researcher', status: i < 10 ? 'done' : 'running', sessionId: `ses_m${i + 1}` }));
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ phases: [], agents }) })} />, { running: true });
    expect(textOf(html)).toContain('10 of 16 done');
    expect(html.match(/aria-label="Open Check market \d+"/g)).toHaveLength(16);
    // One scroll container holds every row.
    expect(html.match(/data-scrollable/g)).toHaveLength(1);
  });

  test('a call that threw keeps its agent rows instead of the generic error row', () => {
    const html = render(<ToolPartRenderer call={call({ status: 'error', error: 'Workflow stopped: aborted', metadata: run({ status: 'stopped' }) })} />);
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('Stopped');
    expect(html).toContain('aria-label="Open Research pricing"');
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
    expect(text).toContain('1 of 4 done · 1 failed');
  });

  test('a saved workflow without a title is named by its saved name', () => {
    const text = textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run({ title: '', name: 'audit-routes' }) })} />, { running: true }));
    expect(text).toContain('audit-routes');
    expect(text).not.toContain('Saved workflow');
  });

  test('a saved workflow with its own title names the saved workflow in the body, with the approved agent cap', () => {
    const text = textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run({ name: 'audit-routes', maxAgents: 12 }) })} />, { running: true }));
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('Saved workflow audit-routes · Up to 12 agents');
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

  test('a background run is one row that says it runs in the background and opens the run', () => {
    const html = render(<WorkflowTool call={call({ status: 'completed', output: 'Started in the background', metadata: background })} />);
    const text = textOf(html);
    expect(text).toContain('Weekly competitor review');
    expect(text).toContain('Running in the background');
    expect(html).toContain('aria-label="Open the run&#x27;s session"');
    expect(text).toContain('Open run');
    // No disclosure: the row itself leads to the run's session.
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
    expect(text).toContain('Running in the background · 1 of 3 done');
    expect(text).toContain('Research pricing');
    expect(text).toContain('Draft the summary');
    // Not folded: the run is still the thing to watch.
    expect(html).toContain('aria-expanded="true"');
    // The controls go to the runner: pause, stop, and a restart on a running agent row.
    expect(html).toContain('aria-label="Pause the run"');
    expect(html).toContain('aria-label="Stop the run"');
    expect(html).toContain('aria-label="Restart Research features"');
    expect(html).toContain('aria-label="Open the run&#x27;s session"');
  });

  test('the next poll of the runner updates the same card', () => {
    const later = run({
      agents: run().agents.map((agent) => ({ ...agent, status: 'done', sessionId: agent.sessionId ?? 'ses_a3' })),
    });
    const text = textOf(render(<WorkflowTool call={settledCall} />, { projectId: 'proj_1', sessionId: 'ses_lead', client: runnerHolds(later) }));
    expect(text).toContain('Running in the background · 3 of 3 done');
  });

  test('a paused run says so and offers Resume', () => {
    const html = render(<WorkflowTool call={settledCall} />, {
      projectId: 'proj_1',
      sessionId: 'ses_lead',
      client: runnerHolds(run({ paused: true })),
    });
    expect(textOf(html)).toContain('Paused · 1 of 3 done');
    expect(html).toContain('aria-label="Resume the run"');
  });

  test('a run that finished in its runner reads as finished, with no pause or stop', () => {
    const done = run({ status: 'done', endedAt: 1_790_000_060_000, agents: run().agents.map((agent) => ({ ...agent, status: 'done' })) });
    const html = render(<WorkflowTool call={settledCall} />, { projectId: 'proj_1', sessionId: 'ses_lead', client: runnerHolds(done) });
    expect(textOf(html)).toContain('3 agents');
    expect(html).not.toContain('aria-label="Pause the run"');
    // A finished run folds away, as every finished run card does.
    expect(html).toContain('aria-expanded="false"');
  });

  test('a started call names its runner as runnerSessionId or runner_session_id', () => {
    expect(parseWorkflowRun({ ...run(), background: undefined, runnerSessionId: 'ses_r' })?.background).toEqual({ sessionId: 'ses_r' });
    expect(parseWorkflowRun({ ...run(), background: undefined, runner_session_id: 'ses_r' })?.background).toEqual({ sessionId: 'ses_r' });
    expect(parseWorkflowRun({ ...run(), status: 'started', agents: undefined })?.status).toBe('running');
    expect(parseWorkflowRun(run({ paused: true }))?.paused).toBe(true);
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

  test('each phase is a group with its agent count, its agents under it, and a pending phase listed greyed', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: phased })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('Research2 agents');
    expect(text).toContain('Write0 of 1 done');
    expect(text).toContain('ReviewNot started');
    // Agents sit under their phase, in phase order.
    const at = (needle: string) => text.indexOf(needle);
    expect(at('Research pricing')).toBeLessThan(at('Write0 of 1 done'));
    expect(at('Write0 of 1 done')).toBeLessThan(at('Draft the summary'));
    expect(at('Draft the summary')).toBeLessThan(at('ReviewNot started'));
    // A phase with agents folds; a pending phase has nothing to fold.
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(3); // the card + Research + Write
  });

  test('groupAgents: loose agents first, then declared phases, then a phase the list does not name', () => {
    const groups = groupAgents({
      phases: [{ title: 'Plan', status: 'done' }, { title: 'Ship', status: 'pending' }],
      agents: [
        { id: 'a1', label: 'Scout', status: 'done' },
        { id: 'a2', label: 'Plan it', phase: 'Plan', status: 'done' },
        { id: 'a3', label: 'Extra', phase: 'Unlisted', status: 'running' },
      ],
    });
    expect(groups.map((g) => [g.phase?.title ?? null, g.phase?.status ?? null, g.agents.map((a) => a.id)])).toEqual([
      [null, null, ['a1']],
      ['Plan', 'done', ['a2']],
      ['Ship', 'pending', []],
      ['Unlisted', 'running', ['a3']],
    ]);
  });
});

describe('WorkflowTool — agent rows', () => {
  test('a row shows its agent, model, retry count, reuse from the last run and elapsed time', () => {
    const rows = run({
      phases: [],
      agents: [
        { id: 'a1', label: 'Research pricing', agent: 'researcher', model: 'kortix/claude-sonnet-4.6', status: 'running', sessionId: 'ses_a1', attempt: 2, startedAt: T0 },
        { id: 'a2', label: 'Research features', status: 'done', cached: true, summary: 'Found 2 features', startedAt: T0, endedAt: T0 + 64_000 },
      ],
    });
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: rows })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('researcher · claude-sonnet-4.6 · retry 1');
    expect(text).toContain('from last run');
    expect(text).toContain('1m 04s');
    // The reused agent ran no session: nothing to open.
    expect(html).toContain('aria-label="Open Research pricing"');
    expect(html).not.toContain('aria-label="Open Research features"');
  });

  test('a running row in a project has a Stop button; a finished row keeps an empty slot', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true, projectId: 'proj_1' });
    expect(html).toContain('aria-label="Stop Research features"');
    expect(html).not.toContain('aria-label="Stop Research pricing"');
    // A starting agent has no session to stop yet.
    expect(html).not.toContain('aria-label="Stop Draft the summary"');
  });

  test('no Stop without a project to stop it in, and none once the call settled', () => {
    expect(render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true })).not.toContain('aria-label="Stop');
    const done = run({ status: 'done', agents: run().agents.map((a) => ({ ...a, status: 'done' })) });
    expect(render(<WorkflowTool call={call({ status: 'completed', output: '', metadata: done })} />, { projectId: 'proj_1' })).not.toContain('aria-label="Stop');
  });

  test('a structured answer reads as JSON and its key count, folded', () => {
    const rows = run({
      phases: [],
      agents: [
        { id: 'a1', label: 'List files', status: 'done', sessionId: 'ses_a1', structured: true, summary: '{"files":["a.ts","b.ts"],"total":2,"truncated":false}' },
        { id: 'a2', label: 'Count tags', status: 'done', sessionId: 'ses_a2', structured: true, summary: '["x","y"]' },
        { id: 'a3', label: 'Cut answer', status: 'done', sessionId: 'ses_a3', structured: true, summary: '{"files":["a.ts",' },
      ],
    });
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: rows })} />, { running: true });
    const text = textOf(html);
    expect(text).toContain('JSON · 3 keys');
    expect(text).toContain('JSON · 2 items');
    expect(text).toContain('JSON');
    expect(text).not.toContain('"truncated"');
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(3);
  });

  test('more than 8 agents get the status filter, with a count per status', () => {
    const agents = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i + 1}`,
      label: `Check market ${i + 1}`,
      status: i < 6 ? 'done' : i < 9 ? 'running' : 'failed',
      sessionId: `ses_m${i + 1}`,
    }));
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ phases: [], agents }) })} />, { running: true });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Show agents"');
    const text = textOf(html);
    expect(text).toContain('All10');
    expect(text).toContain('Running3');
    expect(text).toContain('Failed1');
    expect(text).toContain('Done6');
    expect(textOf(render(<WorkflowTool call={call({ status: 'running', metadata: run() })} />, { running: true }))).not.toContain('All3');
  });

  test('a phase of more than 25 agents shows 20 rows and a "Show all" button', () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `a${i + 1}`, label: `Check file ${i + 1}`, status: 'done', sessionId: `ses_f${i + 1}` }));
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ phases: [], agents }) })} />, { running: true });
    expect(html.match(/aria-label="Open Check file \d+"/g)).toHaveLength(20);
    expect(textOf(html)).toContain('Show all 30');
  });
});

describe('WorkflowTool — logs and result', () => {
  test('the newest log lines sit above the phases', () => {
    const html = render(<WorkflowTool call={call({ status: 'running', metadata: run({ logs: ['Found 12 files', 'Reviewing in 3 batches'] }) })} />, { running: true });
    const text = textOf(html);
    expect(html).toContain('aria-label="Workflow log"');
    expect(text.indexOf('Reviewing in 3 batches')).toBeLessThan(text.indexOf('Research pricing'));
  });

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
    expect(text).toContain('Write failed: every writer timed out');
    expect(text).not.toContain('Show details');
    expect(text).not.toContain('workflow_error');
  });

  test('parseWorkflowResult: JSON is pretty-printed, prose stays Markdown, no block is null', () => {
    expect(parseWorkflowResult('<workflow_result>\n{"a":1,"b":[2]}\n</workflow_result>\nagents: 1 (1 done)')).toEqual({
      kind: 'json',
      text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    });
    expect(parseWorkflowResult('<workflow_result>\n**Done.** 3 files\n</workflow_result>')).toEqual({ kind: 'markdown', text: '**Done.** 3 files' });
    expect(parseWorkflowResult('<workflow_result>\n{"cut": \n</workflow_result>')).toEqual({ kind: 'markdown', text: '{"cut":' });
    expect(parseWorkflowResult('<workflow_error>\nboom\n</workflow_error>')).toBeNull();
    expect(parseWorkflowResult('plain text')).toBeNull();
  });
});

describe('workflow-run helpers', () => {
  test('formatElapsed keeps a ticking label the same width', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(64_000)).toBe('1m 04s');
    expect(formatElapsed(3_900_000)).toBe('1h 05m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  test('elapsedMs: finished from its end, live from now, unknown without a start', () => {
    expect(elapsedMs({ startedAt: 10, endedAt: 70 }, false, 999)).toBe(60);
    expect(elapsedMs({ startedAt: 10 }, true, 110)).toBe(100);
    expect(elapsedMs({ startedAt: 10 }, false, 110)).toBeUndefined();
    expect(elapsedMs({}, true, 110)).toBeUndefined();
  });

  test('structuredSummary reads an object, a list, a value, and a cut answer', () => {
    expect(structuredSummary('{"a":1,"b":2}')).toMatchObject({ kind: 'object', keys: 2 });
    expect(structuredSummary('[1,2,3]')).toMatchObject({ kind: 'array', items: 3 });
    expect(structuredSummary('true')).toMatchObject({ kind: 'value', pretty: 'true' });
    expect(structuredSummary('{"a":')).toEqual({ kind: 'text', pretty: '{"a":' });
  });

  test('the filter buckets: running holds starting agents, a stopped agent is under "all" only', () => {
    const agents = (['starting', 'running', 'done', 'failed', 'stopped'] as const).map((status, i) => ({ id: `a${i}`, label: status, status }));
    expect(countAgents(agents)).toEqual({ total: 5, running: 2, failed: 1, done: 1 });
    expect(agents.filter((a) => agentMatches(a, 'running')).map((a) => a.status)).toEqual(['starting', 'running']);
    expect(agents.filter((a) => agentMatches(a, 'all'))).toHaveLength(5);
    expect(['failed', 'done', 'running'].some((f) => agentMatches(agents[4]!, f as never))).toBe(false);
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

describe('parseWorkflowRun', () => {
  test('drops agents and phases it cannot read, keeps the rest', () => {
    const parsed = parseWorkflowRun(
      run({
        phases: [{ title: 'Research', status: 'done' }, { title: '', status: 'done' }, { title: 'X', status: 'weird' }],
        agents: [
          { id: 'a1', label: 'Good', status: 'done' },
          { id: 'a2', label: 'Bad status', status: 'paused' },
          { id: 'a3', status: 'running' },
          'not an agent',
        ],
      }),
    );
    expect(parsed?.phases).toEqual([{ title: 'Research', status: 'done' }]);
    expect(parsed?.agents).toEqual([{ id: 'a1', label: 'Good', status: 'done' }]);
  });

  test('reads every field of the contract', () => {
    const parsed = parseWorkflowRun(
      run({
        maxAgents: 12,
        name: 'audit-routes',
        logs: ['one', 'two', 'three', 'four', 'five', 'six'],
        large: true,
        resumedFrom: 'run-0',
        background: { sessionId: 'ses_runner' },
        phases: [{ title: 'Review', status: 'pending' }],
        agents: [
          { id: 'a1', label: 'Go', status: 'done', cached: true, model: 'kortix/m', structured: true, attempt: 3, startedAt: 1, endedAt: 2 },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      maxAgents: 12,
      name: 'audit-routes',
      logs: ['two', 'three', 'four', 'five', 'six'],
      large: true,
      resumedFrom: 'run-0',
      background: { sessionId: 'ses_runner' },
      phases: [{ title: 'Review', status: 'pending' }],
    });
    expect(parsed?.agents[0]).toEqual({ id: 'a1', label: 'Go', status: 'done', cached: true, model: 'kortix/m', structured: true, attempt: 3, startedAt: 1, endedAt: 2 });
  });

  test('drops new fields of the wrong shape and keeps the run', () => {
    const parsed = parseWorkflowRun(
      run({
        maxAgents: 'twelve',
        name: 42,
        logs: 'not a list',
        large: 'yes',
        resumedFrom: '',
        background: { sessionId: 7 },
        agents: [{ id: 'a1', label: 'Go', status: 'done', cached: 'yes', model: 3, structured: 1, attempt: 0, startedAt: 'now' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.logs).toEqual([]);
    for (const key of ['maxAgents', 'name', 'large', 'resumedFrom', 'background'] as const) expect(parsed?.[key]).toBeUndefined();
    expect(parsed?.agents[0]).toEqual({ id: 'a1', label: 'Go', status: 'done' });
  });

  test('null without a run status or an agents list', () => {
    expect(parseWorkflowRun(undefined)).toBeNull();
    expect(parseWorkflowRun({})).toBeNull();
    expect(parseWorkflowRun({ status: 'running' })).toBeNull();
    expect(parseWorkflowRun({ status: 'queued', agents: [] })).toBeNull();
    expect(parseWorkflowRun({ status: 'running', agents: [] })).toMatchObject({ status: 'running', agents: [], phases: [] });
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
