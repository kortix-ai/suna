import { describe, expect, test } from 'bun:test';

import type { MessageWithParts, Part, ToolPart } from '@/ui';
import {
  buildActivityItems,
  formatActivityDuration,
  isRunLive,
  isStructuralPart,
  partitionForNarrative,
  summarizeItems,
} from './activity-model';

const message = { info: { id: 'msg-1', role: 'assistant' } } as unknown as MessageWithParts;

let seq = 0;
function tool(name: string, extra: Partial<ToolPart> = {}): Part {
  seq += 1;
  return {
    id: `part-${seq}`,
    type: 'tool',
    tool: name,
    callID: `call-${seq}`,
    state: { status: 'completed', input: {}, time: { start: 0, end: 1000 } },
    ...extra,
  } as unknown as Part;
}

function step(phase: 'start' | 'finish'): Part {
  seq += 1;
  return { id: `step-${seq}`, type: `step-${phase}` } as unknown as Part;
}

function text(value: string): Part {
  seq += 1;
  return { id: `text-${seq}`, type: 'text', text: value } as unknown as Part;
}

function wrap(parts: Part[]) {
  return parts.map((part) => ({ part, message }));
}

describe('isStructuralPart', () => {
  test('step-start/step-finish paint nothing and must be transparent to grouping', () => {
    expect(isStructuralPart({ type: 'step-start' })).toBe(true);
    expect(isStructuralPart({ type: 'step-finish' })).toBe(true);
  });

  test('internal bookkeeping is structural', () => {
    expect(isStructuralPart({ type: 'snapshot' })).toBe(true);
    expect(isStructuralPart({ type: 'patch' })).toBe(true);
    expect(isStructuralPart({ type: 'agent' })).toBe(true);
    expect(isStructuralPart({ type: 'retry' })).toBe(true);
  });

  test('blank text/reasoning fragments are structural; real prose is not', () => {
    expect(isStructuralPart({ type: 'text', text: '  ' })).toBe(true);
    expect(isStructuralPart({ type: 'reasoning', text: '' })).toBe(true);
    expect(isStructuralPart({ type: 'text', text: 'Building the deck' })).toBe(false);
    expect(isStructuralPart({ type: 'tool' })).toBe(false);
  });
});

describe('buildActivityItems — the regression', () => {
  test('step parts between tool calls do NOT split the run', () => {
    // Exactly the wire shape that produced twelve raw `$ …` rows in the UI.
    const parts = wrap([
      step('start'),
      tool('bash'),
      step('finish'),
      step('start'),
      tool('bash'),
      step('finish'),
      step('start'),
      tool('bash'),
      step('finish'),
    ]);

    const items = buildActivityItems(parts);

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('group');
    if (items[0].type === 'group') {
      expect(items[0].entries).toHaveLength(3);
      expect(items[0].kind).toBe('shell');
      expect(items[0].counts.shell).toBe(3);
    }
  });

  test('snapshot/patch bookkeeping also stays transparent', () => {
    const parts = wrap([
      tool('bash'),
      { id: 's', type: 'snapshot' } as unknown as Part,
      tool('bash'),
    ]);
    const items = buildActivityItems(parts);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('group');
  });

  test('real prose DOES split a run — narration is a paragraph break', () => {
    const items = buildActivityItems(
      wrap([tool('bash'), tool('bash'), text('Now let me build the deck.'), tool('bash'), tool('bash')]),
    );
    expect(items.map((i) => i.type)).toEqual(['group', 'text', 'group']);
  });
});

describe('buildActivityItems — density', () => {
  const mixed = () => wrap([tool('read'), step('finish'), tool('bash'), tool('write'), tool('bash')]);

  test('detailed groups only like with like', () => {
    const items = buildActivityItems(mixed(), { density: 'detailed' });
    // read | bash | write | bash — all runs of one, so four single rows.
    expect(items.map((i) => i.type)).toEqual(['tool', 'tool', 'tool', 'tool']);
  });

  test('simple folds any adjacent background work into one line', () => {
    const items = buildActivityItems(mixed(), { density: 'simple' });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('group');
    if (items[0].type === 'group') {
      expect(items[0].entries).toHaveLength(4);
      expect(items[0].kind).toBe('other'); // mixed
      expect(items[0].counts).toMatchObject({ read: 1, shell: 2, write: 1 });
    }
  });

  test('a run of one is never a group', () => {
    const items = buildActivityItems(wrap([tool('bash')]), { density: 'simple' });
    expect(items.map((i) => i.type)).toEqual(['tool']);
  });
});

describe('buildActivityItems — things that must never be folded away', () => {
  test('a show deliverable stands alone and splits the run around it', () => {
    const items = buildActivityItems(
      wrap([tool('bash'), tool('bash'), tool('show'), tool('bash'), tool('bash')]),
      { density: 'simple' },
    );
    expect(items.map((i) => i.type)).toEqual(['group', 'deliverable', 'group']);
  });

  test('a tool awaiting permission is never swallowed by a group', () => {
    const locked = tool('bash') as ToolPart;
    const items = buildActivityItems(
      wrap([tool('bash'), locked as unknown as Part, tool('bash')]),
      { density: 'simple', lockedCallIds: new Set([locked.callID]) },
    );
    expect(items.map((i) => i.type)).toEqual(['tool', 'tool', 'tool']);
  });

  test('todos and questions pass through to the turn body', () => {
    const items = buildActivityItems(wrap([tool('todowrite'), tool('question')]));
    expect(items.map((i) => i.type)).toEqual(['passthrough', 'passthrough']);
  });

  test('hidden parts are dropped without breaking the run', () => {
    const hidden = tool('bash') as ToolPart;
    const items = buildActivityItems(
      wrap([tool('bash'), hidden as unknown as Part, tool('bash')]),
      { density: 'simple', isHidden: (p) => p.id === hidden.id },
    );
    expect(items).toHaveLength(1);
    if (items[0].type === 'group') expect(items[0].entries).toHaveLength(2);
  });
});

describe('summarizeItems', () => {
  test('counts every step across groups, singles and deliverables', () => {
    const items = buildActivityItems(
      wrap([tool('bash'), tool('bash'), tool('show'), tool('read')]),
      { density: 'simple' },
    );
    const summary = summarizeItems(items);
    expect(summary.totalSteps).toBe(4);
    expect(summary.counts.shell).toBe(2);
    expect(summary.counts.read).toBe(1);
  });

  test('duration spans the whole run, not the sum of its parts', () => {
    const a = tool('bash', { state: { status: 'completed', time: { start: 0, end: 5_000 } } } as Partial<ToolPart>);
    const b = tool('bash', { state: { status: 'completed', time: { start: 4_000, end: 9_000 } } } as Partial<ToolPart>);
    const summary = summarizeItems(buildActivityItems(wrap([a, b])));
    expect(summary.durationMs).toBe(9_000);
  });

  test('running when any step is still in flight', () => {
    const live = tool('bash', { state: { status: 'running' } } as Partial<ToolPart>);
    const summary = summarizeItems(buildActivityItems(wrap([tool('bash'), live])));
    expect(summary.running).toBe(true);
  });
});

describe('formatActivityDuration', () => {
  test('sub-second durations are noise and render as nothing', () => {
    expect(formatActivityDuration(0)).toBe('');
    expect(formatActivityDuration(999)).toBe('');
  });

  test('seconds and minutes', () => {
    expect(formatActivityDuration(4_200)).toBe('4s');
    expect(formatActivityDuration(72_000)).toBe('1m 12s');
    expect(formatActivityDuration(120_000)).toBe('2m');
  });
});

describe('partitionForNarrative — what the shipping default hides, and where', () => {
  const reasoning = (value: string): Part =>
    ({ id: `r-${(seq += 1)}`, type: 'reasoning', text: value }) as unknown as Part;

  test('a plain run of work folds into one line at its first slot', () => {
    const items = buildActivityItems(wrap([tool('bash'), tool('bash'), tool('bash')]), {
      density: 'simple',
    });
    const fold = partitionForNarrative(items);
    expect(fold.runs).toHaveLength(1);
    expect(fold.runs[0].entries).toHaveLength(3);
    expect(fold.runs[0].key).toBe(items[0].key);
  });

  test('PROSE SPLITS THE FOLD — work/text/work stays interleaved', () => {
    // The bug: folding per-TURN collapsed every run into one line at the top and
    // left all the prose bunched underneath, so the back-and-forth vanished.
    const items = buildActivityItems(
      wrap([
        tool('bash'),
        tool('bash'),
        text('Here is what I found.'),
        tool('bash'),
        tool('bash'),
        text('Now the plan.'),
        tool('bash'),
      ]),
      { density: 'simple' },
    );
    const fold = partitionForNarrative(items);

    expect(fold.runs).toHaveLength(3);
    expect(fold.runs.map((r) => r.entries.length)).toEqual([2, 2, 1]);

    // Each run paints at its own slot, and the text slots stay unfolded so they
    // render exactly where they happened.
    const rendered = items.map((i) =>
      fold.runByKey.has(i.key) ? 'work' : fold.foldedKeys.has(i.key) ? null : i.type,
    );
    expect(rendered.filter(Boolean)).toEqual(['work', 'text', 'work', 'text', 'work']);
  });

  test('a deliverable breaks the run, so the line above summarises only prior work', () => {
    const items = buildActivityItems(
      wrap([tool('bash'), tool('bash'), tool('show'), tool('bash')]),
      { density: 'simple' },
    );
    const fold = partitionForNarrative(items);
    expect(fold.runs).toHaveLength(2);
    expect(fold.runs[0].entries).toHaveLength(2);
    expect(fold.runs[1].entries).toHaveLength(1);
  });

  test('a FAILED step is never folded, and ends the run it interrupted', () => {
    const boom = tool('bash', { state: { status: 'error', error: 'boom' } } as Partial<ToolPart>);
    const items = buildActivityItems(wrap([tool('bash'), text('x'), boom, text('y'), tool('bash')]), {
      density: 'simple',
    });
    const fold = partitionForNarrative(items);
    const foldedIds = fold.runs.flatMap((r) => r.entries.map((e) => e.part.id));
    expect(foldedIds).not.toContain((boom as unknown as ToolPart).id);
  });

  test('a permission-locked step is never folded — approval must be legible', () => {
    const locked = tool('bash') as unknown as ToolPart;
    const items = buildActivityItems(wrap([tool('bash'), locked as unknown as Part, tool('bash')]), {
      density: 'simple',
      lockedCallIds: new Set([locked.callID]),
    });
    const fold = partitionForNarrative(items, new Set([locked.callID]));
    const foldedIds = fold.runs.flatMap((r) => r.entries.map((e) => e.part.id));
    expect(foldedIds).not.toContain(locked.id);
  });

  test('a group with an un-foldable member is not folded AT ALL — no double render', () => {
    const boom = tool('bash', { state: { status: 'error', error: 'boom' } } as Partial<ToolPart>);
    const items = buildActivityItems(wrap([tool('bash'), boom]), { density: 'simple' });
    expect(items[0].type).toBe('group');
    const fold = partitionForNarrative(items);
    expect(fold.foldedKeys.size).toBe(0);
    expect(fold.runs).toHaveLength(0);
  });

  test('reasoning folds into its run rather than vanishing', () => {
    const items = buildActivityItems(wrap([reasoning('Let me plan this out.'), tool('bash')]), {
      density: 'simple',
    });
    const fold = partitionForNarrative(items);
    expect(fold.runs[0].reasoningParts.map((p) => p.text)).toEqual(['Let me plan this out.']);
  });

  test('a turn with nothing foldable yields no work line at all', () => {
    const items = buildActivityItems(wrap([text('Just an answer.')]), { density: 'simple' });
    const fold = partitionForNarrative(items);
    expect(fold.runs).toHaveLength(0);
    expect(fold.foldedKeys.size).toBe(0);
  });
});

describe('isRunLive — only one run may spin', () => {
  test('an earlier, finished run is never live, even mid-turn', () => {
    // The bug: "Making edits…" repeated down the page, once per finished run.
    expect(isRunLive({ hasRunningStep: false, turnWorking: true, isLatest: false })).toBe(false);
  });

  test('the last run of a working turn is live — the next step lands there', () => {
    expect(isRunLive({ hasRunningStep: false, turnWorking: true, isLatest: true })).toBe(true);
  });

  test('a run with a step actually in flight is live regardless of position', () => {
    expect(isRunLive({ hasRunningStep: true, turnWorking: false, isLatest: false })).toBe(true);
  });

  test('nothing is live once the turn is done', () => {
    expect(isRunLive({ hasRunningStep: false, turnWorking: false, isLatest: true })).toBe(false);
  });
});

describe('partitionForNarrative — order is preserved', () => {
  const reasoning = (value: string): Part =>
    ({ id: `r-${(seq += 1)}`, type: 'reasoning', text: value }) as unknown as Part;

  test('a run interleaves reasoning and steps as they happened', () => {
    // The wire shape the runtime actually emits, per a captured transcript:
    //   step-start → reasoning → tool → step-finish, repeated.
    const items = buildActivityItems(
      wrap([
        step('start'),
        reasoning('Let me check memory.'),
        tool('bash'),
        step('finish'),
        step('start'),
        reasoning('Now list the sessions.'),
        tool('bash'),
        step('finish'),
      ]),
      { density: 'simple' },
    );
    const fold = partitionForNarrative(items);
    expect(fold.runs).toHaveLength(1);

    // Bucketing reasoning separately from steps produced
    // [reasoning, reasoning, step, step] — thinking detached from the work.
    expect(fold.runs[0].children.map((c) => c.kind)).toEqual([
      'reasoning',
      'step',
      'reasoning',
      'step',
    ]);
  });

  test('children and entries agree on the step count', () => {
    const items = buildActivityItems(
      wrap([reasoning('thinking'), tool('bash'), tool('bash')]),
      { density: 'simple' },
    );
    const run = partitionForNarrative(items).runs[0];
    expect(run.children.filter((c) => c.kind === 'step')).toHaveLength(run.entries.length);
  });
});
