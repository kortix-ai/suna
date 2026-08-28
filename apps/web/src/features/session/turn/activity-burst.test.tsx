import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import type { Part, ToolPart } from '@/ui';
import {
  FilesIcon,
  PencilSimpleIcon,
  ReadCvLogoIcon,
  StackIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityBurst,
  ActivityGroupStep,
  burstFailureCount,
  burstIsRunning,
  sameActivityGroupStepProps,
} from './activity-burst';
import { ActivityStep, iconFor } from './activity-step';
import { isAnsweredQuestionPart } from './answered-question-step';
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

  test('members are chain steps, so each one can own the rail over its own thread', () => {
    // Several `task` calls fold into ONE "Worked with N helper agents" row, so
    // the burst's own rail belongs to the GROUP. A member that opens a thread
    // of its own — a sub-agent's twenty steps — then had no line tying those
    // rows to THAT agent rather than to the group or to the agent below it, and
    // the list ran off the bottom unbounded.
    //
    // Answered with the component that already exists rather than a second rail
    // implementation: one rail for the group's step, one per member's, each
    // drawn only while it is open and each in ITS row's icon lane — the
    // member's 28px right of the group's, because `pl-7` is where the member's
    // glyph starts.
    const agents: Part[] = [
      tool('1', 'task', { status: 'completed', input: { description: 'Research Mars' } }),
      tool('2', 'task', { status: 'completed', input: { description: 'Research Jupiter' } }),
      tool('3', 'task', { status: 'completed', input: { description: 'Research galaxies' } }),
    ];
    const markup = render(true, agents);
    expect(markup).toContain('helper agents');
    // 1 for the group's own step + 1 per member.
    expect(markup.split('bg-muted-foreground/15').length - 1).toBe(1 + 3);
    // `ChainOfThought` owns the gap between members now, so the hand-rolled
    // list spacing is gone rather than doubled up with it.
    expect(markup).not.toContain('mt-3 space-y-3 pl-7');
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

  test('a failed group wears the wording alone — no destructive mark', () => {
    // The label already states the failure ("Couldn't read your files"), so
    // the row keeps its muted family glyph: a red warning beside words that
    // already say "failed" states the verdict twice.
    const markup = render(false, mixed);
    expect(markup).toContain('data-status="error"');
    expect(markup).not.toContain('aria-label="This step failed"');
    expect(markup).not.toContain('text-destructive');
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

describe('sameActivityGroupStepProps', () => {
  // ONE shared `parts` array/elements — re-running `mergeBurstSteps` on it is
  // exactly what a re-render does while an UNRELATED part streams elsewhere
  // in the burst: `parts` (the burst's own prop) keeps its element identities,
  // `mergeBurstSteps`'s `useMemo` still re-runs because the ARRAY reference
  // changed (see `same-parts.ts`), and `finalize` mints a new `Step` + a new
  // `parts` array around these same two elements every time.
  const sharedParts: Part[] = [
    tool('1', 'read', { status: 'completed', input: { filePath: '/workspace/alpha.ts' } }),
    tool('2', 'read', { status: 'completed', input: { filePath: '/workspace/beta.ts' } }),
  ];

  const freshGroup = (parts: Part[] = sharedParts) => {
    const steps = mergeBurstSteps(parts, (p) => stepLabel(p).tier);
    if (steps[0].kind !== 'group') throw new Error('expected a group row');
    return steps[0].step;
  };

  const props = (step: ReturnType<typeof freshGroup>) => ({
    step,
    sessionId: 'session-1',
    running: false,
    disableNavigation: true,
  });

  test('two independently-built Step objects for the same content compare equal', () => {
    // The regression: `mergeBurstSteps` -> `groupSteps` -> `finalize` mints a
    // NEW `step` object (and a NEW `parts` array around the SAME `ToolPart`
    // elements) on every call, so object identity always fails here — that is
    // exactly why a shallow-compare `memo` never held for this row.
    const a = freshGroup();
    const b = freshGroup();
    expect(a).not.toBe(b);
    expect(a.parts).not.toBe(b.parts);
    expect(sameActivityGroupStepProps(props(a), props(b))).toBe(true);
  });

  test('a status change (a member starts running) is caught', () => {
    const a = freshGroup();
    const running: Part[] = [
      tool('1', 'read', { status: 'completed', input: { filePath: '/workspace/alpha.ts' } }),
      tool('2', 'read', { status: 'running', input: { filePath: '/workspace/beta.ts' } }),
    ];
    const steps = mergeBurstSteps(running, (p) => stepLabel(p).tier);
    if (steps[0].kind !== 'group') throw new Error('expected a group row');
    expect(sameActivityGroupStepProps(props(a), props(steps[0].step))).toBe(false);
  });

  test('a member swapped for a different file is caught even though status/label hold', () => {
    const a = freshGroup();
    const swapped: Part[] = [
      tool('1', 'read', { status: 'completed', input: { filePath: '/workspace/alpha.ts' } }),
      tool('3', 'read', { status: 'completed', input: { filePath: '/workspace/gamma.ts' } }),
    ];
    const steps = mergeBurstSteps(swapped, (p) => stepLabel(p).tier);
    if (steps[0].kind !== 'group') throw new Error('expected a group row');
    const b = steps[0].step;
    // Same status and label ("Read 2 files"), different membership.
    expect(b.status).toBe(a.status);
    expect(b.label).toBe(a.label);
    expect(sameActivityGroupStepProps(props(a), props(b))).toBe(false);
  });

  test('sessionId, running, and disableNavigation are each load-bearing', () => {
    const a = freshGroup();
    const b = freshGroup();
    expect(sameActivityGroupStepProps({ ...props(a), sessionId: 'session-2' }, props(b))).toBe(
      false,
    );
    expect(sameActivityGroupStepProps({ ...props(a), running: true }, props(b))).toBe(false);
    expect(
      sameActivityGroupStepProps({ ...props(a), disableNavigation: false }, props(b)),
    ).toBe(false);
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

  // Every reader of a burst must agree on what is IN it. `burstSummary` skips
  // plumbing and `mergeBurstSteps` drops it, so a failed
  // `prune`/`distill`/`compress` renders no row at all — counting it made a
  // burst of two clean reads collapse to "Completed 1 of 2 steps · 1 failed",
  // expand to two clean rows, and close on "1 step failed" the reader could
  // never locate.
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

describe('ActivityBurst', () => {
  /** A settled call. `output` matters: `partOutcome` reads the payload, not
   *  just `state.status`. */
  const done = (id: string, name: string, input: Record<string, unknown> = {}) =>
    tool(id, name, { status: 'completed', output: 'ok', input, time: { start: 1, end: 2 } });

  const renderBurst = (
    parts: Part[],
    {
      working = false,
      isTrailing = false,
      density = 'normal' as 'normal' | 'minimal',
    } = {},
  ) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ActivityBurst
            parts={parts}
            sessionId="session-1"
            working={working}
            isTrailing={isTrailing}
            disableNavigation
            density={density}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  test('the collapsed line counts the work instead of quoting a thought', () => {
    // The exact regression: this row used to be the model's own heading, which
    // said nothing about how much is behind the caret.
    const markup = renderBurst([
      {
        id: 'r',
        type: 'reasoning',
        text: '**Setting up the SCREAMSHEET project structure**',
        time: { start: 1, end: 2 },
      } as unknown as Part,
      done('1', 'bash'),
      done('2', 'bash'),
    ]);
    expect(markup).toContain('Completed 3 steps');
    expect(markup).not.toContain('SCREAMSHEET');
  });

  test('one call drops the summary line and IS its row', () => {
    // "Completed 1 step" over a single row is a door in front of a door: a line
    // naming no tool, no file and no command, guarding the one row that names
    // all three. The row already opens on its own.
    const markup = renderBurst([done('1', 'bash', { command: 'pnpm build' })]);
    expect(markup).not.toContain('Completed 1 step');
    expect(markup).toContain('pnpm build');
  });

  test('a bare single step still carries its own failure', () => {
    // Nothing above it says "failed" any more — no summary line, no closing
    // step — so the verdict has to survive on the row itself.
    const markup = renderBurst([tool('1', 'bash', { status: 'error', error: 'Error: boom' })]);
    expect(markup).not.toContain('Completed');
    expect(markup).not.toContain('1 step failed');
    // `ToolOutcomeIcon`'s mark, on the row's own trigger.
    expect(markup).toContain('data-tone="failed"');
  });

  test('a bare step KEEPS its leading glyph — the icon is what names the tool', () => {
    // It used to be stripped, on the argument that the glyph only exists to
    // anchor the chain rail and one row has no chain. That cost the row the
    // only thing saying WHICH tool ran: a lone write rendered as a line of
    // text with nothing on it. The tool's name is not always in the words —
    // "Write" is, "Ran command" is not.
    const markup = renderBurst([done('1', 'bash', { command: 'pnpm build' })]);
    // The hide rule is gone; the class arrives HTML-escaped in static markup,
    // so match the escaped tail rather than the source string.
    expect(markup).not.toContain('&gt;span:first-child]:hidden');
    // `ToolHeaderRow`'s leading span, holding the terminal glyph.
    expect(markup).toContain('<span class="text-muted-foreground size-4 shrink-0">');
    expect(markup).toContain('pnpm build');
  });

  test('a bare step keeps its OUTCOME mark — nothing else says it failed', () => {
    const markup = renderBurst([tool('1', 'bash', { status: 'error', error: 'Error: boom' })]);
    // The hide rule must NOT be applied, or the only failure signal goes with it.
    expect(markup).not.toContain('&gt;span:first-child]:hidden');
    expect(markup).toContain('data-tone="failed"');
    expect(markup).toContain('aria-label="This step failed"');
  });

  test('one sub-agent draws exactly ONE rail — not a second bar in the content lane', () => {
    // The reported regression. `SubAgentActivity` used to draw a hairline down
    // the left of its own list, which is the CONTENT lane — anchored to no
    // icon, 20px inside the burst's own chain rail, and saying the same thing
    // that rail already said. Two bars for one level of nesting.
    const markup = renderBurst([
      done('1', 'task', { subagent_type: 'general', description: 'Research nearby galaxies' }),
    ]);
    expect(markup.split('bg-muted-foreground/15').length - 1).toBe(1);
  });

  test('a bare DELEGATE row keeps its glyph — it anchors a thread of its own', () => {
    // "A single row has no rail and no thread" is true of a read or a command
    // and false of a sub-agent: `task` opens the child agent's whole step list
    // under itself, with its own hairline (`tool/shared/sub-agent.tsx`). So the
    // row IS a parent and the icon is that thread's anchor — stripping it left
    // twenty rows hanging off a line of bare text.
    const markup = renderBurst([
      done('1', 'task', { subagent_type: 'general', description: 'Research Mars overview' }),
    ]);
    // Bare in every other respect: no summary line over one call.
    expect(markup).not.toContain('Completed 1 step');
    expect(markup).toContain('Agent · general');
    expect(markup).not.toContain('&gt;span:first-child]:hidden');
  });

  test('a bare FAILED read is the tool row, not a door onto nothing', () => {
    // No chip is produced, so "Read 1 file" would open to the one row already
    // behind it — two labels, two clicks, one call.
    const markup = renderBurst([
      tool('1', 'read', {
        status: 'error',
        error: 'Error: ENOENT',
        input: { filePath: '/gone.ts' },
      }),
    ]);
    expect(markup).not.toContain('Read 1 file');
    expect(markup).toContain('data-tone="failed"');
  });

  test('bare and wrapped share a root element type, so growing never remounts', () => {
    // A burst streams 1 step then 2. React tears down a subtree whose element
    // type changes at the same position — which would snap shut a row the
    // reader had just opened. Both roots must be the burst `Disclosure`.
    const one = renderBurst([done('1', 'bash')]);
    const two = renderBurst([done('1', 'bash'), done('2', 'bash')]);
    expect(one.startsWith('<div class="group/burst flex-row"')).toBe(true);
    expect(two.startsWith('<div class="group/burst flex-row"')).toBe(true);
    // Bare is permanently open — there is no trigger to close it with.
    expect(one).toContain('data-state="open"');
  });

  test('a single read is bare too — the chip row is the burst', () => {
    const markup = renderBurst([done('1', 'read', { filePath: '/workspace/main.ts' })]);
    expect(markup).not.toContain('Completed 1 step');
    // The chip itself sits behind this row's OWN caret, exactly as it does
    // inside a chain, so a closed static render shows the label and not the
    // chip. `activity-file-chips.test.tsx` covers the open state.
    // ONE file names itself — the row says WHICH, not "one".
    expect(markup).toContain('Read /workspace/main.ts');
    expect(markup).toContain('data-status="done"');
  });

  test('two calls keep the summary line', () => {
    expect(renderBurst([done('1', 'bash'), done('2', 'bash')])).toContain('Completed 2 steps');
  });

  test('one ROW over three calls keeps the summary line', () => {
    // `steps.length === 1` is not the test — a group row is one row over N
    // calls, and "Completed 3 steps" is information the bare row cannot carry.
    const markup = renderBurst([
      done('1', 'read', { filePath: '/a.ts' }),
      done('2', 'read', { filePath: '/b.ts' }),
      done('3', 'read', { filePath: '/c.ts' }),
    ]);
    expect(markup).toContain('Completed 3 steps');
  });

  test('a lone thought is bare too — the Thinking row labels itself', () => {
    // It was excluded while a thought was unlabelled prose with no trigger of
    // its own. `ThoughtChainStep` gave it a label and a caret, so the burst no
    // longer has to be its door.
    const markup = renderBurst([
      {
        id: 'r',
        type: 'reasoning',
        text: 'Weighing two schemas',
        time: { start: 1, end: 2 },
      } as unknown as Part,
    ]);
    expect(markup).not.toContain('Completed 1 step');
    expect(markup).toContain('Thinking');
  });

  test('a settled thought is a closed row, not a wall of prose', () => {
    // The text used to render inline and always-open, which made reasoning the
    // loudest thing in a list of work. Asserted through a BARE lone thought:
    // the burst is force-open there, so what is closed is the thought row
    // itself rather than the burst around it.
    const markup = renderBurst([
      {
        id: 'r',
        type: 'reasoning',
        text: 'Weighing two schemas',
        time: { start: 1, end: 2 },
      } as unknown as Part,
    ]);
    expect(markup).toContain('Thinking');
    expect(markup).not.toContain('Weighing two schemas');
  });

  test('a settled thought reports how long it took', () => {
    // `Thinking` alone answered "the model did something" and nothing else —
    // not whether that was two seconds or ninety, which is the one question a
    // reader waiting on a thought has.
    const markup = renderBurst([
      {
        id: 'r',
        type: 'reasoning',
        text: 'Weighing two schemas',
        time: { start: 1_700_000_000_000, end: 1_700_000_012_000 },
      } as unknown as Part,
    ]);
    expect(markup).toContain('Thought for 12s');
  });

  test('a thought under a second stays plain "Thinking"', () => {
    // `formatDuration` returns '' below 1000ms on purpose. A row saying "0s" is
    // worse than one saying nothing, and the same fallback covers a provider
    // that sends no timing at all.
    const timed = renderBurst([
      {
        id: 'r',
        type: 'reasoning',
        text: 'Weighing two schemas',
        time: { start: 1_700_000_000_000, end: 1_700_000_000_400 },
      } as unknown as Part,
    ]);
    expect(timed).toContain('>Thinking<');
    expect(timed).not.toContain('Thought for');

    const untimed = renderBurst([
      { id: 'r', type: 'reasoning', text: 'Weighing two schemas' } as unknown as Part,
    ]);
    expect(untimed).toContain('Thinking');
    expect(untimed).not.toContain('Thought for');
  });

  test('a LIVE thought never claims a total — it counts up instead', () => {
    // Past tense on a thought that has not finished would report a number the
    // run has not reached. The live row counts from the client (see
    // `useLiveElapsedMs`), so a static render is always at zero seconds.
    const markup = renderBurst(
      [
        {
          id: 'r',
          type: 'reasoning',
          text: 'Weighing two schemas',
          time: { start: 1_700_000_000_000 },
        } as unknown as Part,
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).not.toContain('Thought for');
    expect(markup).toContain('Thinking');
  });

  test('a thought opens itself while the model is still thinking', () => {
    // The live thought is the LAST row, which is the only place one can be:
    // a tool call after it means the model closed that reasoning block to make
    // the call. The fixture used to put a running bash after the thought and
    // still expect it open — the exact shape this row must NOT treat as live.
    const markup = renderBurst(
      [
        done('1', 'bash'),
        { id: 'r', type: 'reasoning', text: 'Weighing two schemas' } as unknown as Part,
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Weighing two schemas');
  });

  test('a tool call after a thought settles it, even with no end time on the part', () => {
    // The structural half of the rule, and the half that survives a provider
    // that never writes `time.end`: the model cannot call a tool and keep
    // writing the same reasoning block.
    const markup = renderBurst(
      [
        { id: 'r', type: 'reasoning', text: 'Weighing two schemas' } as unknown as Part,
        tool('1', 'bash', { status: 'running', input: { command: 'ls' } }),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Thinking');
    expect(markup).not.toContain('Weighing two schemas');
    expect(shimmeringThoughts(markup)).toBe(0);
  });

  describe('minimal density', () => {
    // The user preference this gates: "i hate seeing so much text on my screen
    // while kortix is thinking". Minimal keeps the LIVE view to one line; a
    // click still opens everything, and a settled turn renders identically.
    const liveParts = (): Part[] => [
      done('1', 'read', { filePath: '/workspace/a.ts' }),
      tool('2', 'bash', { status: 'running', input: { command: 'pnpm build' } }),
    ];

    test('a running burst stays collapsed to its one summary line', () => {
      const markup = renderBurst(liveParts(), {
        working: true,
        isTrailing: true,
        density: 'minimal',
      });
      expect(markup).toContain('Working');
      expect(markup).toContain('2 steps');
      expect(markup).not.toContain('pnpm build');
    });

    test('…and the same running burst IS open under normal density', () => {
      // The control: proves the assertion above can fail. Without it, a
      // refactor that stopped rendering the command at all would keep the
      // minimal test green for the wrong reason.
      const markup = renderBurst(liveParts(), { working: true, isTrailing: true });
      expect(markup).toContain('pnpm build');
    });

    test('a live bare thought keeps its text behind the caret', () => {
      // Bare bursts are force-open (no trigger to close them), so the thought
      // row itself must decline to unfurl — otherwise the streaming paragraph
      // reappears through the one door minimal cannot shut.
      const thought: Part[] = [
        { id: 'r', type: 'reasoning', text: 'Weighing two schemas' } as unknown as Part,
      ];
      const minimal = renderBurst(thought, {
        working: true,
        isTrailing: true,
        density: 'minimal',
      });
      expect(minimal).toContain('Thinking');
      expect(minimal).not.toContain('Weighing two schemas');
      // The control again: normal density DOES open the live thought.
      const normal = renderBurst(thought, { working: true, isTrailing: true });
      expect(normal).toContain('Weighing two schemas');
    });

    test('a settled burst renders identically in both modes', () => {
      // Minimal governs only the live view. Once the turn settles, both modes
      // auto-collapse to the same one-row summary — byte for byte.
      const parts = [done('1', 'bash', { command: 'ls' }), done('2', 'bash', { command: 'pwd' })];
      expect(renderBurst(parts, { density: 'minimal' })).toBe(renderBurst(parts));
    });
  });

  /**
   * A `Thinking` row rendered by `TextShimmer` rather than a plain span.
   * `bg-clip-text` is the shimmer's signature; the caret is a SIBLING of the
   * label, so the shimmering span closes on the word itself.
   */
  const shimmeringThoughts = (markup: string) =>
    markup.match(/bg-clip-text[^>]*>Thinking</g)?.length ?? 0;

  const thinking = (id: string, text: string, end?: number) =>
    ({
      id,
      type: 'reasoning',
      text,
      time: end === undefined ? { start: 1 } : { start: 1, end },
    }) as unknown as Part;

  test('only the LIVE thought shimmers — settled ones in the same burst do not', () => {
    // The regression: the burst hands ONE running flag to every row, and a
    // trailing burst is running for the whole turn — so a 27-step burst
    // shimmered every `Thinking` row it had ever emitted.
    const markup = renderBurst(
      [
        thinking('r1', 'Weighing the first schema', 2),
        done('1', 'bash'),
        thinking('r2', 'Weighing the second schema', 4),
        done('2', 'read', { filePath: '/workspace/main.ts' }),
        thinking('r3', 'Weighing the third schema'),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Thinking');
    expect(shimmeringThoughts(markup)).toBe(1);
  });

  test('a settled thought stays CLOSED while later work runs', () => {
    // The same flag force-opens every past thought, so finished reasoning
    // unfurled its whole paragraph under a row the reader never opened.
    const markup = renderBurst(
      [
        thinking('r1', 'Weighing the first schema', 2),
        done('1', 'bash'),
        thinking('r2', 'Weighing the second schema'),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).not.toContain('Weighing the first schema');
    expect(markup).toContain('Weighing the second schema');
  });

  test('a thought that ended stops shimmering even as the last row of a working burst', () => {
    // The gap between a closed reasoning block and the next tool call. The
    // summary line still says the turn is working; the thought must not claim
    // the model is still thinking.
    const markup = renderBurst(
      [thinking('r1', 'Weighing the first schema', 2), done('1', 'bash')],
      {
        working: true,
        isTrailing: true,
      },
    );
    expect(shimmeringThoughts(markup)).toBe(0);
    expect(markup).not.toContain('Weighing the first schema');
  });

  test('a settled turn shimmers no thought at all', () => {
    const markup = renderBurst([
      thinking('r1', 'Weighing the first schema'),
      done('1', 'bash'),
      thinking('r2', 'Weighing the second schema'),
    ]);
    expect(shimmeringThoughts(markup)).toBe(0);
  });

  test('a bare single step is still running-aware', () => {
    const markup = renderBurst(
      [tool('1', 'bash', { status: 'running', input: { command: 'ls' } })],
      {
        working: true,
        isTrailing: true,
      },
    );
    expect(markup).not.toContain('Working · 1 step');
    expect(markup).toContain('ls');
  });

  test('a burst with a failure says so in words alone — no warning glyph', () => {
    const parts: Part[] = [
      ...Array.from({ length: 10 }, (_, i) => done(`ok${i}`, 'bash')),
      tool('bad', 'bash', { status: 'error', error: 'Error: boom' }),
    ];
    const markup = renderBurst(parts);
    // The clause is what removes the subtraction from `10 of 11`.
    expect(markup).toContain('Completed 10 of 11 steps · 1 failed');
    // The words are the whole signal — the summary line never carries a
    // destructive mark beside a title that already says "failed".
    expect(markup).not.toContain('aria-label="1 step failed"');
  });

  test('a burst where everything failed never claims a completion', () => {
    const markup = renderBurst([
      tool('1', 'bash', { status: 'error', error: 'Error: boom' }),
      tool('2', 'bash', { status: 'error', error: 'Error: boom' }),
    ]);
    expect(markup).toContain('2 steps failed');
    expect(markup).not.toContain('Completed');
  });

  test('a running burst reports its size so far, and shimmers while it does', () => {
    const markup = renderBurst(
      [
        done('1', 'bash'),
        done('2', 'bash'),
        tool('3', 'bash', { status: 'running' }),
        tool('4', 'bash', { status: 'pending' }),
      ],
      { working: true, isTrailing: true },
    );
    // `bg-clip-text` is `TextShimmer`'s signature; the running rows inside carry
    // it too, so the assertion pins it to the title's own element.
    expect(markup).toMatch(/class="[^"]*bg-clip-text[^"]*"[^>]*>Working · 4 steps/);
  });

  test('a running burst counts no failures — the run is not over', () => {
    const markup = renderBurst(
      [
        done('1', 'bash'),
        tool('2', 'bash', { status: 'error', error: 'Error: boom' }),
        tool('3', 'bash', { status: 'running' }),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Working · 3 steps');
    expect(markup).not.toContain('· 1 failed');
    expect(markup).not.toContain('aria-label="1 step failed"');
  });

  /**
   * A burst renders only when it has rows. Plumbing is dropped by
   * `mergeBurstSteps` and blank reasoning is skipped, so a run made only of
   * those merges to nothing — and a summary line over an empty chain is a
   * caret that promises a body it does not have. `parts.length > 0` is exactly
   * the case that used to produce it, which is why the guard tests `steps`.
   */
  test('a burst of nothing but machinery renders nothing at all', () => {
    expect(renderBurst([tool('1', 'prune', { status: 'completed', output: 'ok' })])).toBe('');
  });

  test('a burst of blank reasoning renders nothing at all', () => {
    const blank = { id: 'r', type: 'reasoning', text: '   ', time: { start: 1, end: 2 } };
    expect(renderBurst([blank as unknown as Part])).toBe('');
  });

  test('a running burst with no rows yet renders nothing', () => {
    // The trailing burst is forced open while the turn works, so without the
    // guard this is the loudest empty row on the surface.
    const markup = renderBurst([tool('1', 'prune', { status: 'running' })], {
      working: true,
      isTrailing: true,
    });
    expect(markup).toBe('');
  });

  test('one real call still renders once machinery is filtered out', () => {
    // The guard must not swallow a burst that has work in it — plumbing beside
    // a real call leaves one step, and one step is a bare row.
    const markup = renderBurst([
      tool('1', 'prune', { status: 'completed', output: 'ok' }),
      done('2', 'bash', { command: 'pnpm build' }),
    ]);
    expect(markup).not.toBe('');
    expect(markup).toContain('pnpm build');
  });

  /**
   * The burst must be running for these: a settled burst collapses itself, and
   * a chain step is closed until the reader opens it — so a burst render shows
   * the step ROWS, not the chips (`activity-file-chips.test.tsx` renders the
   * body open). Each case therefore asserts on a label the two row types cannot
   * both produce.
   */
  test('a run of reads becomes a file row, not a group of tool cards', () => {
    // A failed member is what separates the two: `ActivityGroupStep` takes its
    // words from `narrateFailedStep` ("Couldn't read your files"), while a file
    // row keeps counting files and puts the verdict in the glyph.
    const markup = renderBurst(
      [
        done('1', 'read', { filePath: '/workspace/package.json' }),
        tool('2', 'read', { status: 'error', error: 'ENOENT', input: { filePath: '/gone.ts' } }),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Read 2 files');
    expect(markup).not.toContain("Couldn't read your files");
    expect(markup).toContain('data-status="error"');
  });

  test('a lone read is unwrapped by the merge and is still a file', () => {
    // `mergeBurstSteps` flattens a run of one, so this row arrives as a bare
    // part. An `ActivityStep` here would render the read tool's own card, whose
    // trigger says "Read" and the filename as a separate subtitle.
    const markup = renderBurst([done('1', 'read', { filePath: '/workspace/main.ts' })], {
      working: true,
      isTrailing: true,
    });
    expect(markup).toContain('Read /workspace/main.ts');
  });

  test('a read grouped with a grep stays on the tool rows', () => {
    // `groupSteps` buckets `grep` with `read` under the `explore` family, so a
    // family match alone would hand a search to a row whose only vocabulary is
    // files.
    const markup = renderBurst(
      [
        done('1', 'read', { filePath: '/workspace/main.ts' }),
        done('2', 'grep', { pattern: 'foo' }),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Looked through your files · 1 read');
    expect(markup).not.toContain('Read 2 files');
  });

  test('an edit is never a file row — its renderer shows the diff', () => {
    const markup = renderBurst(
      [
        done('1', 'edit', { filePath: '/workspace/main.ts' }),
        done('2', 'edit', { filePath: '/workspace/other.ts' }),
      ],
      { working: true, isTrailing: true },
    );
    expect(markup).toContain('Updated 2 files');
    expect(markup).not.toContain('Wrote 2 files');
  });
});

describe('chain rail', () => {
  /**
   * A `bash` row does NOT bind to the step's own `Disclosure` — `ToolPartRenderer`
   * brings its own. So the step reads `closed` while the command is expanded, and
   * a rail gated only on `group-data-[state=open]/step` never draws beside it.
   */
  const railStep = (defaultOpen: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ChainOfThoughtStep>
            <ToolPartRenderer
              part={
                tool('1', 'bash', {
                  status: 'completed',
                  output: 'total 28',
                  input: { command: 'ls -la' },
                  time: { start: 1, end: 2 },
                }) as never
              }
              sessionId="session-1"
              defaultOpen={defaultOpen}
              disableNavigation
            />
          </ChainOfThoughtStep>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  test('an expanded tool row leaves the STEP closed — the first rule cannot fire', () => {
    const markup = railStep(true);
    expect(markup).toContain('class="group/step relative" data-state="closed"');
    // …but a descendant IS open, which is what the `has-` clause asks.
    expect(markup).toContain('data-state="open"');
  });

  test('a collapsed tool row has no open descendant, so no rail', () => {
    const markup = railStep(false);
    expect(markup).not.toContain('data-state="open"');
  });

  test('the rail asks both questions', () => {
    const markup = railStep(false);
    expect(markup).toContain('group-data-[state=open]/step:block');
    expect(markup).toContain('group-has-[[data-state=open]]/step:block');
  });
});

describe('step family glyphs', () => {
  test('a read row leads with the read mark, not a generic page', () => {
    // The row says WHICH kind of work it was; the chip inside it still says
    // which kind of file (see attachment-icon.test.ts).
    expect(iconFor(tool('1', 'read', { status: 'completed' }))).toBe(ReadCvLogoIcon);
  });

  test('a skills row leads with the stacked-pages mark', () => {
    // It had no entry at all, so it fell through to the generic `StackIcon`
    // fallback — the mark every unrecognised tool gets.
    expect(iconFor(tool('1', 'skill', { status: 'completed' }))).toBe(FilesIcon);
  });

  test('the other families are untouched', () => {
    expect(iconFor(tool('1', 'write', { status: 'completed' }))).toBe(PencilSimpleIcon);
    expect(iconFor(tool('2', 'bash', { status: 'completed' }))).toBe(TerminalWindowIcon);
  });

  test('an unrecognised tool still gets the generic fallback', () => {
    // The fallback must stay reachable — that is what makes the named entries
    // above meaningful rather than decorative.
    expect(iconFor(tool('1', 'some_unknown_mcp_tool', { status: 'completed' }))).toBe(StackIcon);
  });
});

describe('bare row alignment', () => {
  /**
   * A bare row keeps its icon AND its rail, so the two have to agree about the
   * same 28px lane: the rail hangs at `left-2`, and content flush to the margin
   * puts that hairline 8px inside it — straight through the left edge of the
   * file chip. The indent is what the rail runs in.
   */
  const renderBare = (parts: Part[]) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ActivityBurst parts={parts} sessionId="session-1" working={false} disableNavigation />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  const RAIL_SHOWS = 'group-data-[state=open]/step:block';

  const write = (id: string, path: string) =>
    tool(id, 'write', {
      status: 'completed',
      output: 'ok',
      input: { filePath: path },
      time: { start: 1, end: 2 },
    });

  test('a bare row still draws the rail', () => {
    const markup = renderBare([write('1', '/workspace/pdf.ts')]);
    // The row IS bare: no summary line above it.
    expect(markup).not.toContain('Completed 1 step');
    expect(markup).toContain(RAIL_SHOWS);
  });

  test('a bare TOOL row keeps its card indent for the same reason', () => {
    const markup = renderBare([
      tool('1', 'bash', {
        status: 'completed',
        output: 'ok',
        input: { command: 'ls' },
        time: { start: 1, end: 2 },
      }),
    ]);
    // The icon stays…
    expect(markup).not.toContain('&gt;span:first-child]:hidden');
    expect(markup).toContain('<span class="text-muted-foreground size-4 shrink-0">');
    // …and the card sits in the rail's lane, never at 0.
    expect(markup).toContain('[--tool-indent:1.75rem]');
    expect(markup).not.toContain('[--tool-indent:0rem]');
  });

  test('a bare THOUGHT keeps both the rail and the indent', () => {
    const markup = renderBare([
      {
        id: 'r',
        type: 'reasoning',
        text: 'Weighing two schemas',
        time: { start: 1, end: 2 },
      } as unknown as Part,
    ]);
    expect(markup).toContain('Thinking');
    expect(markup).toContain(RAIL_SHOWS);
  });
});

describe('chain alignment', () => {
  /**
   * A tool row's card has to land in the same column as every other row's
   * content in the chain — the thought text and the file chips both sit at
   * `pl-7`.
   *
   * `TOOL_INDENT` derives its 22px from the tool row's NATIVE `gap-1.5`, and
   * `ActivityStep` overrides that gap to `gap-3` so the trigger's label lines up
   * with the rows above it. Overriding one and not the other is what put an
   * expanded command's block 6px left of everything else in the same chain.
   */
  const bashPart = tool('1', 'bash', {
    status: 'completed',
    output: 'total 28',
    input: { command: 'ls -la' },
    time: { start: 1, end: 2 },
  }) as unknown as Part;

  const wrap = (node: React.ReactNode) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          {node}
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  test('a chain row sets the indent to its own icon + gap', () => {
    // 1.75rem = size-4 icon (16px) + the overridden gap-3 (12px) = pl-7.
    const markup = wrap(
      <ChainOfThoughtStep>
        <ActivityStep part={bashPart} sessionId="session-1" running={false} disableNavigation />
      </ChainOfThoughtStep>,
    );
    // Classes arrive HTML-escaped in static markup.
    expect(markup).toContain('tool-trigger&#x27;]]:!gap-3');
    expect(markup).toContain('[--tool-indent:1.75rem]');
  });

  test('a lone row keeps both its icon and the card in the rail lane', () => {
    // `ActivityStep` has no bare/not-bare rendering left: one row and twenty
    // draw the same glyph in the same 28px lane, and the card follows it. The
    // chain rail runs at `left-2`, so a card at the margin would have the
    // hairline cutting through it.
    const markup = wrap(
      <ChainOfThoughtStep>
        <ActivityStep part={bashPart} sessionId="session-1" running={false} disableNavigation />
      </ChainOfThoughtStep>,
    );
    expect(markup).not.toContain('&gt;span:first-child]:hidden');
    expect(markup).toContain('<span class="text-muted-foreground size-4 shrink-0">');
    expect(markup).toContain('[--tool-indent:1.75rem]');
    expect(markup).not.toContain('[--tool-indent:0rem]');
  });

  test('the card reads the variable rather than a hardcoded 22px', () => {
    const markup = wrap(
      <ChainOfThoughtStep>
        <ToolPartRenderer
          part={bashPart as never}
          sessionId="session-1"
          defaultOpen
          disableNavigation
        />
      </ChainOfThoughtStep>,
    );
    expect(markup).toContain('ml-[var(--tool-indent,1.375rem)]');
    // The old constant must not survive anywhere, or the two drift again.
    expect(markup).not.toContain('ml-5.5');
  });
});

describe('answered question step', () => {
  const done = (id: string, name: string, input: Record<string, unknown> = {}) =>
    tool(id, name, { status: 'completed', output: 'ok', input, time: { start: 1, end: 2 } });

  /** A `question` call the user already answered — questions in `input`,
   *  answers in `metadata`, exactly as the session store settles them. */
  const answered = (id: string) =>
    tool(id, 'question', {
      status: 'completed',
      input: {
        questions: [
          { question: 'What should the presentation cover?' },
          { question: 'Who is the presentation for?' },
        ],
      },
      metadata: { answers: [['Serbia and Mumbai'], ['General audience']] },
      time: { start: 1, end: 2 },
    });

  const renderBurst = (parts: Part[], { working = false, isTrailing = false } = {}) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ActivityBurst
            parts={parts}
            sessionId="session-1"
            working={working}
            isTrailing={isTrailing}
            disableNavigation
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

  test('an answered question is a chain row, not the generic tool card', () => {
    // The regression this pins: answered questions used to be forced standalone,
    // which split the burst in two and dropped an outlined card between the
    // halves. Inside the burst the row reads "Questions · N answered".
    const markup = renderBurst([answered('q'), done('1', 'bash'), done('2', 'bash')], {
      working: true,
      isTrailing: true,
    });
    expect(markup).toContain('Questions');
    expect(markup).toContain('2 answered');
    // It is counted as a step of the burst like any other call.
    expect(markup).toContain('Working · 3 steps');
    // The QuestionTool card's own label must not leak in beside the row.
    expect(markup).not.toContain('data-component="tool-trigger"');
  });

  test('a lone answered question is a bare row without the summary line', () => {
    const markup = renderBurst([answered('q')]);
    expect(markup).not.toContain('Completed 1 step');
    expect(markup).toContain('Questions');
    expect(markup).toContain('2 answered');
  });

  test('a question without answers stays off the answered-question row', () => {
    expect(
      isAnsweredQuestionPart(
        tool('q', 'question', { status: 'running', input: { questions: [{ question: 'x' }] } }),
      ),
    ).toBe(false);
    expect(isAnsweredQuestionPart(answered('q'))).toBe(true);
  });
});
