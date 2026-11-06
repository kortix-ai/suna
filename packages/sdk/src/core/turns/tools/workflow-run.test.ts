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

describe('parseWorkflowResult — a JSON result that carries a document', () => {
  // Synthetic values. A workflow script may return `{ report: '# …' }`: the person reads the
  // document, never the JSON that wraps it.
  const doc = '# Growth plan\n\nOne pack. Ten pilots.\n\n## Priorities\n\n1. **Prove it.** Ten paid pilots.';

  test('one prose field is the result itself, as Markdown', () => {
    expect(parseWorkflowResult(`<workflow_result>\n${JSON.stringify({ strategy: doc })}\n</workflow_result>`)).toEqual({
      kind: 'markdown',
      text: doc,
    });
  });

  test('several prose fields read as sections in their order', () => {
    const body = JSON.stringify({ summary: 'Two of nine blockers are real.\nThe rest are fixed.', risks: '- Safari 17 checkout\n- Export drops a row' });
    expect(parseWorkflowResult(`<workflow_result>${body}</workflow_result>`)).toEqual({
      kind: 'markdown',
      text: '## Summary\n\nTwo of nine blockers are real.\nThe rest are fixed.\n\n## Risks\n\n- Safari 17 checkout\n- Export drops a row',
    });
  });

  test('data stays JSON: short strings, numbers and arrays are not a document', () => {
    expect(parseWorkflowResult('<workflow_result>{"status":"ok","count":3}</workflow_result>')?.kind).toBe('json');
    expect(parseWorkflowResult('<workflow_result>{"status":"ok"}</workflow_result>')?.kind).toBe('json');
  });

  test('a cut block whose next field holds data is not a document: nothing is dropped silently', () => {
    const full = JSON.stringify({ report: doc, count: 3, details: 'more prose\nhere' });
    expect(parseWorkflowResult(`<workflow_result>${full.slice(0, -10)}`)?.text.startsWith('{')).toBe(true);
  });

  test('deeply nested JSON never throws and never blows up: it falls back to the raw body', () => {
    for (const depth of [10_000, 100_000]) {
      const body = '['.repeat(depth) + ']'.repeat(depth);
      const result = parseWorkflowResult(`<workflow_result>${body}</workflow_result>`);
      expect(result?.kind).toBe('json');
      expect(result!.text.length).toBeLessThanOrEqual(body.length * 4 + 10_000);
    }
  });

  test('a long token or URL is data, not prose', () => {
    expect(parseWorkflowResult(`<workflow_result>${JSON.stringify({ download_url: `https://example.com/${'a'.repeat(140)}` })}</workflow_result>`)?.kind).toBe('json');
  });

  test('a cut block of whitespace after a key reads in linear time (CodeQL js/polynomial-redos)', () => {
    // Before the fix, 40 000 spaces took ~2.5 s: the tail check backtracked `\s*:?\s*` quadratically.
    for (const body of [`{""${' '.repeat(40_000)}x`, `{${' '.repeat(40_000)}x`, `{"a":"b"${' '.repeat(40_000)}x`]) {
      const started = performance.now();
      expect(parseWorkflowResult(`<workflow_result>${body}`)).toEqual({ kind: 'markdown', text: body });
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test('a result cut inside its document still reads as the document, escapes decoded', () => {
    const full = JSON.stringify({ strategy: doc });
    const cut = full.slice(0, full.indexOf('Ten paid'));
    expect(parseWorkflowResult(`<workflow_result>\n${cut}`)).toEqual({
      kind: 'markdown',
      text: '# Growth plan\n\nOne pack. Ten pilots.\n\n## Priorities\n\n1. **Prove it.**',
    });
  });
});
