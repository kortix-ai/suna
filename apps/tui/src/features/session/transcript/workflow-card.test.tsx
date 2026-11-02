import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { ToolView, WorkflowRunMetadata } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { testRender } from '@opentui/react/test-utils';

import { type AgentNav, AgentNavProvider, type PeekTarget } from '../../agents/agent-nav.tsx';
import { TranscriptSessionProvider } from './session-context.tsx';
import { ToolCard } from './tool-card.tsx';

// Synthetic values only: every title, id and session id below is invented.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 80, height: 24 };
const STARTED = 1_790_000_000_000;

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    title: 'Weekly competitor review',
    status: 'running',
    startedAt: STARTED,
    phases: [
      { title: 'Research', status: 'running' },
      { title: 'Write', status: 'pending' },
    ],
    agents: [
      {
        id: 'a1',
        label: 'Research pricing',
        agent: 'researcher',
        phase: 'Research',
        status: 'done',
        sessionId: 'ses_a1',
        summary: 'Found 4 price changes',
        startedAt: STARTED,
        endedAt: STARTED + 12_000,
      },
      {
        id: 'a2',
        label: 'Research features',
        agent: 'researcher',
        phase: 'Research',
        status: 'failed',
        sessionId: 'ses_a2',
        summary: 'The site refused the request',
      },
      {
        id: 'a3',
        label: 'Research reviews',
        agent: 'researcher',
        phase: 'Research',
        status: 'running',
        sessionId: 'ses_a3',
        startedAt: STARTED,
      },
      {
        id: 'a4',
        label: 'Draft the summary',
        agent: 'writer',
        phase: 'Write',
        status: 'stopped',
        sessionId: 'ses_a4',
      },
    ],
    logs: ['one', 'two', 'three'],
    ...overrides,
  };
}

function workflowCall(
  metadata: Record<string, unknown> | undefined,
  status: ToolView['status'] = 'running',
): ToolView {
  return {
    name: 'workflow',
    kind: 'workflow',
    title: 'Run Workflow',
    status,
    input: { script: 'const a = await agent("go")' },
    ...(metadata ? { metadata } : {}),
    ...(status === 'done' ? { output: 'agents: 4', outputText: 'agents: 4' } : {}),
  };
}

function render(
  tool: ToolView,
  opts: {
    peeked?: PeekTarget[];
    session?: { projectId: string; sessionId: string };
    client?: QueryClient;
  } = {},
) {
  const nav: AgentNav = {
    currentSessionId: 'ses_parent',
    peeking: null,
    peek: (target) => opts.peeked?.push(target),
    closePeek: () => {},
    switchTo: () => {},
  };
  const card = <ToolCard tool={tool} width={SIZE.width} />;
  const tree = opts.session ? (
    <QueryClientProvider client={opts.client ?? new QueryClient()}>
      <TranscriptSessionProvider
        projectId={opts.session.projectId}
        sessionId={opts.session.sessionId}
      >
        {card}
      </TranscriptSessionProvider>
    </QueryClientProvider>
  ) : (
    card
  );
  return testRender(<AgentNavProvider value={nav}>{tree}</AgentNavProvider>, SIZE);
}

describe('<ToolCard/> for a workflow run', () => {
  test('a running run: its title, progress, phases in order, and one row per agent with its status glyph', async () => {
    const { captureCharFrame, flush, renderer } = await render(workflowCall(run()));
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Weekly competitor review');
    expect(frame).toContain('1 of 4 done · 1 failed');
    expect(frame.indexOf('Research')).toBeLessThan(frame.indexOf('Write'));
    expect(frame).toContain('✓ Research pricing');
    expect(frame).toContain('⎿ Found 4 price changes');
    expect(frame).toContain('✗ Research features');
    expect(frame).toContain('Research reviews');
    expect(frame).toContain('– Draft the summary');
    expect(frame).toContain('12s');
    // The newest two log lines only.
    expect(frame).toContain('three');
    expect(frame).toContain('two');
    expect(frame).not.toMatch(/\bone\b/);
    expect(frame).toContain('/workflows to pause, stop or open an agent');
    expect(frame).not.toContain('"script"');
    renderer.destroy();
  });

  test('a finished run: a check mark, every agent counted, and how long it took', async () => {
    const agents = (run().agents as Record<string, unknown>[]).map((agent) => ({
      ...agent,
      status: 'done',
    }));
    const { captureCharFrame, flush, renderer } = await render(
      workflowCall(
        run({
          status: 'done',
          agents,
          endedAt: STARTED + 130_000,
          phases: [
            { title: 'Research', status: 'done' },
            { title: 'Write', status: 'done' },
          ],
        }),
        'done',
      ),
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('✓ Weekly competitor review');
    expect(frame).toContain('4 of 4 done · 2m 10s');
    expect(frame).not.toContain('failed');
    renderer.destroy();
  });

  test('a paused, resumed large run names each state as a word', async () => {
    const { captureCharFrame, flush, renderer } = await render(
      workflowCall(run({ paused: true, resumedFrom: 'run-0', large: true })),
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Paused');
    expect(frame).toContain('Resumed');
    expect(frame).toContain('Large run');
    renderer.destroy();
  });

  test('a run of 14 agents shows the running ones and the newest, then how many it left out', async () => {
    const agents = Array.from({ length: 14 }, (_, i) => ({
      id: `a${i + 1}`,
      label: `Agent ${i + 1}`,
      phase: 'Research',
      status: i === 1 ? 'running' : 'done',
      sessionId: `ses_${i + 1}`,
    }));
    const { captureCharFrame, flush, renderer } = await render(
      workflowCall(run({ agents, phases: [{ title: 'Research', status: 'running' }] })),
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Agent 2');
    expect(frame).toContain('Agent 14');
    expect(frame).not.toContain('Agent 3 ');
    expect(frame).toMatch(/… \d+ more/);
    renderer.destroy();
  });

  test('a click on an agent row opens the peek at its session', async () => {
    const peeked: PeekTarget[] = [];
    const { captureCharFrame, flush, mockMouse, renderer } = await render(workflowCall(run()), {
      peeked,
    });
    await flush();
    const row = captureCharFrame()
      .split('\n')
      .findIndex((line) => line.includes('Research pricing'));
    expect(row).toBeGreaterThan(0);
    await act(async () => mockMouse.click(8, row));
    expect(peeked).toEqual([{ sessionId: 'ses_a1', title: 'Research pricing' }]);
    renderer.destroy();
  });

  test("after the caller's turn ended, the live run on the session's box replaces the part's copy", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    });
    const agents = (run().agents as Record<string, unknown>[]).map((agent) => ({
      ...agent,
      status: 'done',
    }));
    const live = run({
      status: 'done',
      agents,
      endedAt: STARTED + 64_000,
    }) as unknown as WorkflowRunMetadata;
    client.setQueryData(qk.project.sessionWorkflows('proj_1', 'ses_parent'), [live]);
    const { captureCharFrame, flush, renderer } = await render(workflowCall(run(), 'done'), {
      session: { projectId: 'proj_1', sessionId: 'ses_parent' },
      client,
    });
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('4 of 4 done · 1m 04s');
    renderer.destroy();
  });

  test('a workflow call whose metadata is not a run renders the generic card', async () => {
    const { captureCharFrame, flush, renderer } = await render(workflowCall({ foo: 1 }, 'done'));
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('✓ Run Workflow');
    expect(frame).toContain('"script"');
    expect(frame).not.toContain('/workflows');
    renderer.destroy();
  });

  test('a call with no metadata renders the generic card', async () => {
    const { captureCharFrame, flush, renderer } = await render(workflowCall(undefined, 'done'));
    await flush();
    expect(captureCharFrame()).toContain('"script"');
    renderer.destroy();
  });
});
