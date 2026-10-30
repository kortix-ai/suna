import { toolCallBlock } from '@kortix/sdk';
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
import { parseWorkflowRun } from './workflow-run';

// Synthetic values only: every title, id and session id below is invented.

let intlErrors: unknown[] = [];

function render(node: ReactNode, opts: { running?: boolean } = {}) {
  intlErrors = [];
  const tree = opts.running ? <ToolRunningContext.Provider value>{node}</ToolRunningContext.Provider> : node;
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={(error) => intlErrors.push(error)}>
      <QueryClientProvider client={new QueryClient()}>
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
