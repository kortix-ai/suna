import { describe, expect, test } from 'bun:test';
import {
  agentMatches,
  AGENT_FILTERS,
  countAgents,
  elapsedMs,
  formatElapsed,
  groupAgents,
  isWorkflowTool,
  parseWorkflowResult,
  parseWorkflowRun,
  structuredSummary,
} from './workflow-run';

// Synthetic values only: every title, id and session id below is invented.

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

  test('a started call names its runner as runnerSessionId or runner_session_id', () => {
    expect(parseWorkflowRun({ ...run(), background: undefined, runnerSessionId: 'ses_r' })?.background).toEqual({ sessionId: 'ses_r' });
    expect(parseWorkflowRun({ ...run(), background: undefined, runner_session_id: 'ses_r' })?.background).toEqual({ sessionId: 'ses_r' });
    expect(parseWorkflowRun({ ...run(), status: 'started', agents: undefined })?.status).toBe('running');
    expect(parseWorkflowRun(run({ paused: true }))?.paused).toBe(true);
  });
});

describe('isWorkflowTool', () => {
  test('pi workflow under its spellings; no other name ending in workflow', () => {
    expect(isWorkflowTool('workflow')).toBe(true);
    expect(isWorkflowTool('oc-workflow')).toBe(true);
    expect(isWorkflowTool('oc_workflow')).toBe(true);
    expect(isWorkflowTool('n8n_workflow')).toBe(false);
  });
});

describe('groupAgents', () => {
  test('loose agents first, then declared phases, then a phase the list does not name', () => {
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
    expect(AGENT_FILTERS).toEqual(['all', 'running', 'failed', 'done']);
    expect(countAgents(agents)).toEqual({ total: 5, running: 2, failed: 1, done: 1 });
    expect(agents.filter((a) => agentMatches(a, 'running')).map((a) => a.status)).toEqual(['starting', 'running']);
    expect(agents.filter((a) => agentMatches(a, 'all'))).toHaveLength(5);
    expect(['failed', 'done', 'running'].some((f) => agentMatches(agents[4]!, f as never))).toBe(false);
  });
});

describe('parseWorkflowResult', () => {
  test('JSON is pretty-printed, prose stays Markdown, no block is null', () => {
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
