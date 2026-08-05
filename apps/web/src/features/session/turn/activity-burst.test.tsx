import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import type { Part, ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityGroupStep,
  burstFailureCount,
  burstIsRunning,
  showsClosingStep,
} from './activity-burst';
import { mergeBurstSteps } from './merge-steps';
import { stepLabel } from './step-label';

function tool(id: string, name: string, state: Record<string, unknown>): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state,
  } as unknown as ToolPart;
}

describe('burstIsRunning', () => {
  test('a completed non-trailing burst is not running even while the turn works', () => {
    // Burst already closed by later text/standalone — collapse it.
    const parts: Part[] = [tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } })];
    expect(burstIsRunning(parts, true, false)).toBe(false);
  });

  test('a completed trailing burst stays running while the turn works', () => {
    // Gap between SSE tool parts: every part settled, next call not arrived yet.
    // Without this the disclosure blinks shut between every pair of calls.
    const parts: Part[] = [
      tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } }),
      tool('2', 'bash', { status: 'completed', time: { start: 3, end: 4 } }),
    ];
    expect(burstIsRunning(parts, true, true)).toBe(true);
  });

  test('a trailing burst collapses once the turn stops working', () => {
    const parts: Part[] = [tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } })];
    expect(burstIsRunning(parts, false, true)).toBe(false);
  });

  test('a pending part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'pending' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a running part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('nothing is running once the turn has stopped working', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, false)).toBe(false);
  });

  test('a reasoning part with no end time counts as running', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'thinking', time: { start: 1 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a reasoning part with an end time does not when the burst is not trailing', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'done', time: { start: 1, end: 2 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true, false)).toBe(false);
  });
});

describe('showsClosingStep', () => {
  test('a settled chain with steps gets a cap', () => {
    expect(showsClosingStep(1, false)).toBe(true);
    expect(showsClosingStep(9, false)).toBe(true);
  });

  test('a running chain is never capped — the open end means work continues', () => {
    expect(showsClosingStep(3, true)).toBe(false);
  });

  test('an empty chain is never capped — a cap alone terminates nothing', () => {
    // Every part was plumbing, so mergeBurstSteps returned no rows.
    expect(showsClosingStep(0, false)).toBe(false);
    expect(showsClosingStep(0, true)).toBe(false);
  });
});

describe('ActivityGroupStep', () => {
  const parts: Part[] = [
    tool('1', 'read', { status: 'completed', input: { filePath: '/workspace/alpha.ts' } }),
    tool('2', 'read', { status: 'completed', input: { filePath: '/workspace/beta.ts' } }),
  ];

  /** The group as the burst builds it — no hand-made Step, so the render is
   *  asserted against the same grouping the component actually receives. */
  const groupOf = (input: Part[]) => {
    const steps = mergeBurstSteps(input, (p) => stepLabel(p).tier);
    if (steps[0].kind !== 'group') throw new Error('expected a group row');
    return steps[0].step;
  };

  const render = (open: boolean, input: Part[] = parts) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ChainOfThoughtStep open={open}>
            <ActivityGroupStep
              step={groupOf(input)}
              sessionId="session-1"
              running={false}
              disableNavigation
            />
          </ChainOfThoughtStep>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  test('closed, the two reads are ONE row that names the group', () => {
    const markup = render(false);
    expect(markup).toContain('Read 2 files');
    expect(markup).not.toContain('alpha.ts');
    expect(markup).not.toContain('beta.ts');
  });

  test('open, the group renders its members — the second level', () => {
    // `Disclosure` renders only children[0] and children[1], and the step's
    // rail already takes slot 0. If trigger + content were passed as siblings
    // rather than one component, this content would silently never render.
    const markup = render(true);
    expect(markup).toContain('Read 2 files');
    expect(markup).toContain('alpha.ts');
    expect(markup).toContain('beta.ts');
  });

  test('the group row outweighs the rows it opens, so the two levels read apart', () => {
    // Tool titles one level down are regular weight (`InlineTriggerTitle`), so
    // the parent carrying `font-medium` is the non-colour cue that says these
    // rows hang off it. Without it, indent was the only difference.
    expect(render(false)).toContain('font-medium');
  });

  /** A group whose SECOND read died. The first still succeeded — this is the
   *  case where the burst summary reads like ordinary work and the failure is
   *  a level down. */
  const mixed: Part[] = [
    tool('1', 'read', { status: 'completed', input: { filePath: '/workspace/alpha.ts' } }),
    tool('2', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
  ];

  test('a group holding a failed member is status error and wears failure wording', () => {
    const step = groupOf(mixed);
    expect(step.parts).toHaveLength(2);
    expect(step.status).toBe('error');
    // `group-steps.finalize` routes an errored step through `narrateFailedStep`.
    expect(step.label).toBe("Couldn't read your files");
    expect(step.label).not.toContain('Read 2 files');
  });

  test('a failed group carries the destructive mark, not just the wording', () => {
    // The gap this closes: the row used to render the same muted family glyph
    // whatever `step.status` said, so a failed group and a clean one were
    // indistinguishable until the reader clicked one level deeper.
    const markup = render(false, mixed);
    expect(markup).toContain('data-status="error"');
    expect(markup).toContain('aria-label="This step failed"');
    expect(markup).toContain('text-destructive');
    expect(markup).not.toContain('Read 2 files');
  });

  test('a settled clean group is status done and carries no failure mark', () => {
    const markup = render(false);
    expect(groupOf(parts).status).toBe('done');
    expect(markup).toContain('data-status="done"');
    expect(markup).not.toContain('aria-label="This step failed"');
    expect(markup).not.toContain('text-destructive');
  });

  test('a group with a member still in flight shows a running affordance', () => {
    const inFlight: Part[] = [
      tool('1', 'bash', { status: 'completed', input: { command: 'bun test' } }),
      tool('2', 'bash', { status: 'running', input: { command: 'bun run build' } }),
    ];
    const step = groupOf(inFlight);
    expect(step.status).toBe('running');

    const markup = render(false, inFlight);
    expect(markup).toContain('data-status="running"');
    // `bg-clip-text` is `TextShimmer`'s signature — the same "still going"
    // treatment the tool rows one level down already use.
    expect(markup).toContain('bg-clip-text');
  });
});

describe('group labels are plain language', () => {
  /**
   * Shapes that would betray the wire format to a non-technical reader:
   * snake_case, an MCP `server__tool` id, an `oc-` alias, or a `server/tool`
   * path. A group label may never match any of them.
   */
  const RAW_SHAPES: ReadonlyArray<RegExp> = [
    /[a-z0-9]_[a-z0-9]/, // snake_case
    /__/, // an MCP `server__tool` id
    /\boc-/, // an `oc-` alias
    /\//, // a `server/tool` namespaced path
  ];

  /** The label the burst puts on a group row for a run of two calls to `name`. */
  function groupLabelFor(name: string): string {
    const steps = mergeBurstSteps(
      [
        tool('1', name, { status: 'completed', input: {} }),
        tool('2', name, { status: 'completed', input: {} }),
      ],
      (p) => stepLabel(p).tier,
    );
    const first = steps[0];
    if (!first || first.kind !== 'group') throw new Error(`expected a group row for ${name}`);
    return first.step.label;
  }

  /** One tool per narration family, plus the two catch-alls that cannot be
   *  enumerated: an unknown future tool and an MCP `server__tool` id. */
  const TOOLS = [
    'read',
    'oc-grep',
    'write',
    'apply_patch',
    'bash',
    'web_search',
    'scrape_webpage',
    'image_gen',
    'todo_write',
    'agent_task_create',
    'session_list',
    'connector_setup',
    'trigger_create',
    'project_get',
    'skill',
    'question',
    'integration_run',
    'some_future_tool',
    'mcp__linear__create_issue',
  ];

  for (const name of TOOLS) {
    test(`${name} never surfaces its own identifier`, () => {
      const label = groupLabelFor(name);
      // Only names that carry wire-format punctuation can be echoed verbatim.
      // `skill` and `question` are ordinary English, and a sentence is allowed
      // to use the word ("Used 2 skills") — the shapes below are the real test.
      if (/[_\-/]/.test(name)) expect(label).not.toContain(name);
      for (const pattern of RAW_SHAPES) expect(label).not.toMatch(pattern);
    });
  }

  test('a failed group of an unknown tool still says nothing raw', () => {
    const steps = mergeBurstSteps(
      [
        tool('1', 'some_future_tool', { status: 'completed', input: {} }),
        tool('2', 'some_future_tool', { status: 'error', error: 'boom', input: {} }),
      ],
      (p) => stepLabel(p).tier,
    );
    const first = steps[0];
    if (!first || first.kind !== 'group') throw new Error('expected a group row');
    expect(first.step.status).toBe('error');
    expect(first.step.label).toBe("Couldn't finish using Some Future Tool");
    expect(first.step.label).not.toContain('some_future_tool');
  });
});

describe('burstFailureCount', () => {
  const SCRAPE_PARTIAL = JSON.stringify({
    total: 3,
    successful: 2,
    failed: 1,
    results: [
      { url: 'https://a.test', success: true, content: 'ok' },
      { url: 'https://b.test', success: true, content: 'ok' },
      { url: 'https://example.invalid', success: false, error: 'ENOTFOUND' },
    ],
  });

  test('a clean burst has no failures', () => {
    const parts: Part[] = [
      tool('1', 'read', {
        status: 'completed',
        output: 'file contents',
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(0);
  });

  test('counts a thrown call', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'error', error: 'Error: boom' })];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('counts a call that RETURNED its error — the case the cap used to call Done', () => {
    const parts: Part[] = [
      tool('1', 'scrape_webpage', {
        status: 'completed',
        output: 'Error: DNS lookup failed for example.invalid (ENOTFOUND).',
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('counts a batch where one of three URLs died', () => {
    const parts: Part[] = [
      tool('1', 'scrape_webpage', {
        status: 'completed',
        output: SCRAPE_PARTIAL,
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('a reasoning part has no verdict and is never counted', () => {
    const parts: Part[] = [
      {
        id: 'r',
        type: 'reasoning',
        text: 'thinking',
        time: { start: 1, end: 2 },
      } as unknown as Part,
    ];
    expect(burstFailureCount(parts)).toBe(0);
  });

  test('an in-flight call is not a failure yet', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstFailureCount(parts)).toBe(0);
  });

  // The three readers of a burst must agree on what is IN it. `burstTitle`
  // skips non-primary tiers and `mergeBurstSteps` drops plumbing, so a failed
  // `prune`/`distill`/`compress` renders no row at all — counting it here made
  // a burst of two clean reads collapse to "Read 2 files ⚠", expand to two
  // clean rows, and close on "1 step failed" the reader could never locate.
  test('a failed plumbing call is not counted — it renders no row to point at', () => {
    const parts: Part[] = [
      tool('1', 'read', { status: 'completed', output: 'ok', time: { start: 1, end: 2 } }),
      tool('2', 'read', { status: 'completed', output: 'ok', time: { start: 2, end: 3 } }),
      tool('3', 'prune', { status: 'error', error: 'Error: boom' }),
    ];
    expect(burstFailureCount(parts)).toBe(0);
    expect(mergeBurstSteps(parts, (p) => stepLabel(p).tier)).toHaveLength(1);
  });

  test('memory plumbing is not counted either', () => {
    const parts: Part[] = [tool('1', 'memory_search', { status: 'error', error: 'Error: boom' })];
    expect(burstFailureCount(parts)).toBe(0);
  });

  test('a primary failure alongside failed plumbing still counts exactly once', () => {
    const parts: Part[] = [
      tool('1', 'bash', { status: 'error', error: 'Error: boom' }),
      tool('2', 'compress', { status: 'error', error: 'Error: boom' }),
    ];
    expect(burstFailureCount(parts)).toBe(1);
  });
});
