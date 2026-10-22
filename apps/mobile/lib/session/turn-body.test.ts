import { describe, expect, test } from 'bun:test';
import { toolCallMetadata, type SessionLogTurn, type ToolCallBlock } from '@kortix/sdk';

import { blocksOf, turnsOf } from '@/lib/testing/session-log';
import {
  WORKSPACE_ROOTS,
  answeredQuestionCalls,
  busyStatusText,
  commandPromptText,
  compactionTurnView,
  inlineContentItems,
  isSuppressedFailedCompaction,
  lastCompactionTurnIndex,
  lastTextBlockId,
  liveTextBlockId,
  textBlockRevealKey,
  parseAnswersFromOutput,
  segmentInputBlocks,
  showTurnActions,
  showTurnBusyIndicator,
  standaloneCallIdsFor,
  suppressWorkingTurnBusy,
  toDisplayPath,
  transcriptBusyRowVisible,
  turnBlocks,
  turnBodyLayout,
  turnErrorIsAbort,
  turnErrorText,
  turnHasSteps,
  turnResponse,
  turnSegments,
  turnWorkSplit,
} from './turn-body';

// ─── Fixtures ────────────────────────────────────────────────────────────────
// v1 parts and rows (the shape a fixture is easiest to write in), converted to
// the session-log blocks and turns the app renders (`lib/testing/session-log.ts`).

let seq = 0;
type V1Part = { id: string; [key: string]: unknown };

function tool(name: string, state: Record<string, unknown> = {}, callID?: string): V1Part {
  seq += 1;
  return {
    type: 'tool',
    id: `prt_${seq}`,
    callID: callID ?? `call_${seq}`,
    tool: name,
    sessionID: 's',
    messageID: 'm',
    state: { status: 'completed', input: {}, output: '', ...state },
  };
}

function text(value: string, extra: Record<string, unknown> = {}): V1Part {
  seq += 1;
  return { type: 'text', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text: value, ...extra };
}

function reasoning(value: string): V1Part {
  seq += 1;
  return { type: 'reasoning', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text: value, time: { start: 1 } };
}

function plumbing(type: 'step-start' | 'step-finish' | 'snapshot' | 'patch'): V1Part {
  seq += 1;
  return { type, id: `prt_${seq}`, sessionID: 's', messageID: 'm' };
}

/** An assistant row; `turn` points it at its prompt. */
function message(parts: V1Part[], info: Record<string, unknown> = {}) {
  seq += 1;
  return { info: { id: `msg_${seq}`, role: 'assistant', time: { created: seq }, ...info }, parts };
}

/** One turn: a prompt and the replies to it. */
function turn(assistant: ReturnType<typeof message>[], userParts: V1Part[] = [text('hi')], id = 'msg_user'): SessionLogTurn {
  return turnsOf(rows(id, assistant, userParts))[0]!;
}

function rows(id: string, assistant: ReturnType<typeof message>[], userParts: V1Part[] = [text('hi')]) {
  return [
    { info: { id, role: 'user', time: { created: 0 } }, parts: userParts },
    ...assistant.map((m) => ({ ...m, info: { ...m.info, parentID: id } })),
  ];
}

const QUESTION_INPUT = { questions: [{ question: 'Which colour?' }] };

// ─── hasSteps / reasoning ────────────────────────────────────────────────────

describe('turnHasSteps (web SessionTurnImpl hasSteps)', () => {
  test('a visible tool call is a step', () => {
    expect(turnHasSteps(blocksOf([text('a'), tool('bash')]))).toBe(true);
  });

  test('plan writes, task, and question calls are not steps', () => {
    expect(turnHasSteps(blocksOf([tool('todowrite'), tool('todo_write'), tool('task'), tool('question')]))).toBe(false);
  });

  test('snapshot, patch, and compaction parts count as steps', () => {
    expect(turnHasSteps(blocksOf([plumbing('snapshot')]))).toBe(true);
    expect(turnHasSteps(blocksOf([plumbing('patch')]))).toBe(true);
  });

  test('text and reasoning alone are not steps; hidden tools are not steps', () => {
    expect(turnHasSteps(blocksOf([text('a'), reasoning('b')]))).toBe(false);
    expect(turnHasSteps(blocksOf([tool('todoread')]))).toBe(false);
  });
});

describe('turnBlocks (mobile never shows thinking)', () => {
  test('drops every reasoning block and keeps the order of the rest', () => {
    const a = text('a');
    const read = tool('read');
    const t = turn([message([a, reasoning('private'), read, reasoning('')])]);
    expect(turnBlocks(t).map((b) => b.id)).toEqual([a.id, read.id]);
  });

  test('a reasoning-only turn has no steps and no response', () => {
    const blocks = turnBlocks(turn([message([reasoning('only thinking')])]));
    expect(blocks).toEqual([]);
    expect(turnHasSteps(blocks)).toBe(false);
    expect(turnSegments(segmentInputBlocks(blocks, new Map(), false), new Set())).toEqual([]);
  });

  test('a thought between text and a tool leaves a text segment and a burst', () => {
    const blocks = turnBlocks(turn([message([text('a'), reasoning('b'), tool('read')])]));
    const kinds = turnSegments(segmentInputBlocks(blocks, new Map(), false), new Set()).map((s) => s.kind);
    expect(kinds).toEqual(['text', 'burst']);
  });
});

describe('busyStatusText', () => {
  test('a thought after a tool reads "Thinking...", not the tool phrase', () => {
    const t = turn([message([tool('read'), reasoning('**Plan** secret')])]);
    expect(busyStatusText(turnBlocks(t))).toBe('Reading files...');
    expect(busyStatusText(t.blocks)).toBe('Thinking...');
  });

  test('a reasoning-only working turn reads "Thinking..." and leaks no text', () => {
    const t = turn([message([reasoning('**Heading** private')])]);
    expect(busyStatusText(turnBlocks(t))).toContain('Figuring out');
    expect(busyStatusText(t.blocks)).toBe('Thinking...');
    expect(busyStatusText(t.blocks)).not.toContain('private');
  });

  test('blocks after the thought still win', () => {
    expect(busyStatusText(blocksOf([reasoning('x'), tool('read')]))).toBe('Reading files...');
  });
});

// ─── Answered questions ──────────────────────────────────────────────────────

describe('parseAnswersFromOutput', () => {
  test('reads "question"="answer" pairs in order', () => {
    expect(
      parseAnswersFromOutput('User has answered your questions: "Which colour?"="Blue". Continue', QUESTION_INPUT),
    ).toEqual([['Blue']]);
  });

  test('falls back to a placeholder when the output only says answered', () => {
    expect(parseAnswersFromOutput('The user answered.', QUESTION_INPUT)).toEqual([['Answered']]);
  });

  test('returns null with no questions or no usable output', () => {
    expect(parseAnswersFromOutput('x', { questions: [] })).toBeNull();
    expect(parseAnswersFromOutput('nothing here', QUESTION_INPUT)).toBeNull();
    expect(parseAnswersFromOutput('', QUESTION_INPUT)).toBeNull();
  });
});

describe('answeredQuestionCalls', () => {
  test('a question with server answers is kept as-is', () => {
    const q = tool('question', { input: QUESTION_INPUT, metadata: { answers: [['Blue']] } });
    const t = turn([message([q])]);
    const result = answeredQuestionCalls(t.assistant, new Set());
    expect(result).toEqual([t.blocks[0] as ToolCallBlock]);
    expect(result[0]).toBe(t.blocks[0] as ToolCallBlock);
  });

  test('the currently pending question with nothing after it is skipped', () => {
    const q = tool('question', { status: 'running', input: QUESTION_INPUT, output: undefined }, 'call_pending');
    expect(answeredQuestionCalls(turn([message([q, plumbing('step-finish')])]).assistant, new Set(['call_pending']))).toEqual([]);
  });

  test('output plus later content yields a synthetic call with parsed answers', () => {
    const q = tool('question', { input: QUESTION_INPUT, output: '"Which colour?"="Red"' });
    const [result] = answeredQuestionCalls(turn([message([q, text('ok')])]).assistant, new Set());
    expect(result!.id).toBe(q.id);
    expect(toolCallMetadata(result!).answers).toEqual([['Red']]);
  });

  test('no output but later content yields placeholder answers', () => {
    const q = tool('question', { status: 'running', input: QUESTION_INPUT, output: undefined });
    const [result] = answeredQuestionCalls(turn([message([q]), message([text('next')])]).assistant, new Set());
    expect(result!.status).toBe('complete');
    expect(toolCallMetadata(result!).answers).toEqual([['Answered']]);
  });

  test('a question with neither answers nor later content is dropped', () => {
    const q = tool('question', { input: QUESTION_INPUT, output: '' });
    expect(answeredQuestionCalls(turn([message([q])]).assistant, new Set())).toEqual([]);
  });
});

describe('inlineContentItems', () => {
  test('null unless both text and an answered question exist', () => {
    const [q] = blocksOf([tool('question')]) as ToolCallBlock[];
    const answered = new Map([[q!.id, q!]]);
    expect(inlineContentItems(blocksOf([text('a')]), answered)).toBeNull();
    expect(inlineContentItems([q!], answered)).toBeNull();
  });

  test('keeps text and answered questions in natural order, substituting the answered call', () => {
    const blocks = blocksOf([text('a'), tool('question'), tool('bash'), text('b')]);
    const q = blocks[1] as ToolCallBlock;
    const synthetic: ToolCallBlock = { ...q, status: 'complete' };
    const items = inlineContentItems(blocks, new Map([[q.id, synthetic]]));
    expect(items?.map((i) => i.type)).toEqual(['text', 'question', 'text']);
    expect(items?.[1]?.type === 'question' && items[1].call).toBe(synthetic);
  });
});

// ─── Segment input ───────────────────────────────────────────────────────────

describe('segmentInputBlocks', () => {
  test('drops unanswered questions and substitutes answered ones', () => {
    const [pending, answered, bash] = blocksOf([tool('question'), tool('question'), tool('bash')]) as ToolCallBlock[];
    const synthetic: ToolCallBlock = { ...answered! };
    const result = segmentInputBlocks([pending!, answered!, bash!], new Map([[answered!.id, synthetic]]), false);
    expect(result).toEqual([synthetic, bash!]);
    expect(result[0]).toBe(synthetic);
  });

  test('drops answered questions too when the inline content renders them', () => {
    const [answered] = blocksOf([tool('question')]) as ToolCallBlock[];
    expect(segmentInputBlocks([answered!], new Map([[answered!.id, answered!]]), true)).toEqual([]);
  });

  test('keeps plan writes: mobile has no plan card, so the burst is the only todo surface', () => {
    const plan = blocksOf([tool('todowrite')]);
    expect(segmentInputBlocks(plan, new Map(), false)).toEqual(plan);
  });
});

describe('standaloneCallIdsFor', () => {
  test('collects the call ids of this session\'s pending permissions only', () => {
    const ids = standaloneCallIdsFor(
      [
        { sessionID: 's1', tool: { callID: 'c1' } },
        { sessionID: 's2', tool: { callID: 'c2' } },
        { sessionID: 's1' },
      ],
      's1',
    );
    expect([...ids]).toEqual(['c1']);
  });

  test('adds connector calls that ask for a connect or an approval, so they never hide in a burst', () => {
    const connect = tool(
      'kortix-connectors_call',
      {
        output: JSON.stringify({
          ok: false,
          status: 'denied',
          reason: 'connector_not_connected',
          connect_url: 'https://kortix.com/connect/abc',
          connector: 'gmail',
        }),
      },
      'c_connect',
    );
    const approval = tool(
      'kortix-connectors_call',
      { output: JSON.stringify({ status: 'pending_approval', execution_id: 'exec_1' }) },
      'c_approve',
    );
    const ok = tool('kortix-connectors_call', { output: JSON.stringify({ ok: true, data: {} }) }, 'c_ok');
    const ids = standaloneCallIdsFor([], 's1', blocksOf([connect, approval, ok]));
    expect([...ids].sort()).toEqual(['c_approve', 'c_connect']);
    expect(turnSegments(blocksOf([tool('read'), connect, tool('read')]), ids).map((s) => s.kind)).toEqual([
      'burst',
      'standalone',
      'burst',
    ]);
  });
});

describe('turnSegments (no show carousel on mobile)', () => {
  test('adjacent show calls stay one standalone segment each', () => {
    const blocks = blocksOf([
      tool('show', { input: { path: '/workspace/a.pdf' } }),
      tool('show', { input: { path: '/workspace/b.pdf' } }),
    ]);
    expect(turnSegments(blocks, new Set()).map((s) => (s.kind === 'standalone' ? s.block.id : s.kind))).toEqual(
      blocks.map((b) => b.id),
    );
  });
});

describe('lastTextBlockId', () => {
  test('the id of the last text segment, or undefined', () => {
    const [a, b] = blocksOf([text('a'), text('b')]);
    expect(
      lastTextBlockId([
        { kind: 'text', block: a },
        { kind: 'burst', blocks: [] },
        { kind: 'text', block: b },
        { kind: 'burst', blocks: [] },
      ] as never),
    ).toBe(b!.id);
    expect(lastTextBlockId([{ kind: 'burst', blocks: [] }])).toBeUndefined();
  });
});

describe('liveTextBlockId and textBlockRevealKey (KRTX-2933)', () => {
  const msg = (id: string, status: string, blockIds: string[]) =>
    ({ message_id: id, status, blocks: blockIds.map((b) => ({ id: b, type: 'text', text: b })) }) as never;
  const seg = (id: string) => ({ kind: 'text', block: { id, type: 'text', text: id } }) as never;

  test('the last text block of a streaming message is live', () => {
    expect(liveTextBlockId([msg('m1', 'complete', ['a']), msg('m2', 'streaming', ['b'])], [seg('a'), seg('b')])).toBe('b');
  });

  test('a text block whose message completed is not live, even while the turn reads busy', () => {
    expect(liveTextBlockId([msg('m1', 'complete', ['a'])], [seg('a')])).toBeUndefined();
    expect(liveTextBlockId([msg('m1', 'interrupted', ['a'])], [seg('a')])).toBeUndefined();
  });

  test('a text block followed by another block of its message has ended', () => {
    expect(liveTextBlockId([msg('m1', 'streaming', ['a', 'call'])], [seg('a')])).toBeUndefined();
  });

  test('the reveal key names the message and the block', () => {
    expect(textBlockRevealKey([msg('m1', 'complete', ['a']), msg('m2', 'streaming', ['b'])], 'b')).toBe('m2:b');
    expect(textBlockRevealKey([msg('m1', 'complete', ['a'])], 'zz')).toBe('zz');
  });

  test('each reply list answers from its own blocks, the first message holding an id wins', () => {
    const first = [msg('m1', 'complete', ['a', 'b']), msg('m2', 'streaming', ['b'])];
    expect(textBlockRevealKey(first, 'b')).toBe('m1:b');
    // The next streamed frame is a new list: an index built for `first` must not answer for it.
    const next = [msg('m1', 'complete', ['a']), msg('m2', 'streaming', ['b'])];
    expect(textBlockRevealKey(next, 'b')).toBe('m2:b');
    expect(textBlockRevealKey(first, 'b')).toBe('m1:b');
  });

});

describe('turnWorkSplit (KRTX-2113, web TurnToolBlocks fold)', () => {
  const shownFile = () => tool('show', { input: { path: '/workspace/report.pdf' } });
  const segments = (parts: V1Part[]) => turnSegments(blocksOf(parts), new Set());

  test('working: null, the stream renders as today', () => {
    expect(turnWorkSplit(segments([tool('read'), text('Done.')]), true)).toBeNull();
  });

  test('settled: work folds, the deliverable is hoisted, the final text stays', () => {
    const interim = text('Let me check.');
    const read = tool('read');
    const shown = shownFile();
    const final = text('Here it is.');
    const split = turnWorkSplit(segments([interim, read, shown, final]), false);
    expect(split?.work.map((s) => s.kind)).toEqual(['text', 'burst']);
    expect(split?.hoisted.map((s) => (s.kind === 'standalone' ? s.block.id : null))).toEqual([shown.id]);
    expect(split?.final.map((s) => (s.kind === 'text' ? s.block.id : null))).toEqual([final.id]);
  });

  test('settled with no work (text, or deliverable + text): null', () => {
    expect(turnWorkSplit(segments([text('Hi.')]), false)).toBeNull();
    expect(turnWorkSplit(segments([shownFile(), text('Done.')]), false)).toBeNull();
  });

  test('interim text is work: it folds behind the row and reads inline when opened', () => {
    expect(turnWorkSplit(segments([text('Checking.'), text('Done.')]), false)?.work.map((s) => s.kind)).toEqual(['text']);
    expect(turnWorkSplit(segments([text('Here it is.'), shownFile(), text('Done.')]), false)?.work.map((s) => s.kind)).toEqual([
      'text',
    ]);
  });

  test('a burst that renders nothing is no work and does not block the final text', () => {
    // A thought-only burst has no step: `burstView(...).hidden`, so ActivityBurst draws nothing.
    const invisible = { kind: 'burst' as const, blocks: blocksOf([reasoning('hmm')]) };
    expect(turnWorkSplit([invisible, ...segments([text('Done.')])], false)).toBeNull();
    const final = text('Done.');
    const split = turnWorkSplit([...segments([tool('read'), final]), invisible], false);
    expect(split?.work.map((s) => s.kind)).toEqual(['burst']);
    expect(split?.final.map((s) => (s.kind === 'text' ? s.block.id : null))).toEqual([final.id]);
  });

  test('a turn that ends on a tool has no final text: everything is work', () => {
    const split = turnWorkSplit(segments([text('Trying.'), tool('bash')]), false);
    expect(split?.work).toHaveLength(2);
    expect(split?.final).toEqual([]);
  });
});

// ─── Response ────────────────────────────────────────────────────────────────

describe('turnResponse (web `response`)', () => {
  const respond = (t: SessionLogTurn, working: boolean, hasSteps: boolean) =>
    turnResponse({ turn: t, blocks: turnBlocks(t), working, hasSteps });

  test('while working: the active assistant message\'s text', () => {
    const done = message([text('old')], { time: { created: 1, completed: 2 } });
    const live = message([text('new '), text('stream')], { time: { created: 3 } });
    expect(respond(turn([done, live]), true, false)).toBe('new stream');
  });

  test('settled, no steps: every text block joined by a blank line', () => {
    const m = message([text(' one '), text('two')], { time: { created: 1, completed: 2 } });
    expect(respond(turn([m]), false, false)).toBe('one\n\ntwo');
  });

  test('settled with steps: the last text block, trimmed', () => {
    const m = message([text('one'), tool('bash'), text(' two ')], { time: { created: 1, completed: 2 } });
    expect(respond(turn([m]), false, true)).toBe('two');
  });

  test('a blank trailing text block does not hide the last real one', () => {
    const m = message([text('first'), tool('bash'), text('second'), text('')], {
      time: { created: 1, completed: 2 },
      error: { name: 'UnknownError', data: { message: 'x' } },
    });
    expect(respond(turn([m]), false, true)).toBe('second');
  });

  test('no text at all: empty', () => {
    const m = message([tool('bash')], { time: { created: 1, completed: 2 } });
    expect(respond(turn([m]), false, true)).toBe('');
  });
});

// ─── Errors ──────────────────────────────────────────────────────────────────

describe('turnErrorText', () => {
  test('the message-level error first', () => {
    const m = message([], { error: { name: 'UnknownError', data: { message: 'provider down' } } });
    expect(turnErrorText(turn([m]))).toBe('provider down');
  });

  test('falls back to a dismissed question tool error, without the "Error:" prefix', () => {
    const q = tool('question', { status: 'error', error: 'Error: The user dismissed this question' });
    expect(turnErrorText(turn([message([q])]))).toBe('The user dismissed this question');
  });

  test('undefined with no error', () => {
    expect(turnErrorText(turn([message([text('ok')])]))).toBeUndefined();
  });
});

describe('turnErrorIsAbort', () => {
  test('a MessageAbortedError is an abort; another error is not', () => {
    expect(turnErrorIsAbort(turn([message([], { error: { name: 'MessageAbortedError', data: { message: 'aborted' } } })]))).toBe(true);
    expect(turnErrorIsAbort(turn([message([], { error: { name: 'APIError', data: { message: 'abort mission' } } })]))).toBe(false);
    expect(turnErrorIsAbort(turn([message([text('ok')])]))).toBe(false);
  });
});

// ─── Visibility ──────────────────────────────────────────────────────────────

describe('showTurnBusyIndicator (web turn-busy-visibility.ts)', () => {
  test('hidden when not working', () => {
    expect(showTurnBusyIndicator({ working: false, hasError: false, isRetrying: true })).toBe(false);
  });
  test('an error hides it unless a retry is under way', () => {
    expect(showTurnBusyIndicator({ working: true, hasError: true, isRetrying: false })).toBe(false);
    expect(showTurnBusyIndicator({ working: true, hasError: true, isRetrying: true })).toBe(true);
    expect(showTurnBusyIndicator({ working: true, hasError: false, isRetrying: false })).toBe(true);
  });
});

describe('showTurnActions (web action bar gate)', () => {
  test('shown whenever the turn is not working, with or without a response', () => {
    expect(showTurnActions({ working: false })).toBe(true);
    expect(showTurnActions({ working: true })).toBe(false);
  });
});

// ─── Command ─────────────────────────────────────────────────────────────────

describe('commandPromptText', () => {
  test('joins non-synthetic, non-ignored user text', () => {
    expect(
      commandPromptText(blocksOf([text('a'), text('hidden', { synthetic: true }), text('skip', { ignored: true }), text('b')])),
    ).toBe('a\nb');
  });
});

// ─── Display path ────────────────────────────────────────────────────────────

describe('toDisplayPath (web use-oc-file-open toDisplayPath)', () => {
  test('strips the workspace root', () => {
    expect(toDisplayPath('/workspace/src/app.tsx')).toBe('src/app.tsx');
  });

  test('relative paths and paths outside every root stay as they are', () => {
    expect(toDisplayPath('src/app.tsx')).toBe('src/app.tsx');
    expect(toDisplayPath('/etc/hosts')).toBe('/etc/hosts');
    expect(toDisplayPath('/workspacefoo/a')).toBe('/workspacefoo/a');
    expect(toDisplayPath('')).toBe('');
  });

  test('the longest matching root wins', () => {
    expect(toDisplayPath('/workspace/repo/a.ts', ['/workspace', '/workspace/repo'])).toBe('a.ts');
  });

  test('the root "/" is never stripped', () => {
    expect(toDisplayPath('/a/b', ['/'])).toBe('/a/b');
  });

  test('defaults to the sandbox workspace root', () => {
    expect(WORKSPACE_ROOTS).toEqual(['/workspace']);
  });
});

// ─── Compaction + working turn (web session-chat.tsx) ────────────────────────

/** A compaction: the marker prompt (a `compaction` part) and the summary reply it got. */
function compactionRows(id: string, assistant: ReturnType<typeof message>[], created = 0) {
  seq += 1;
  return [
    { info: { id, role: 'user', time: { created } }, parts: [{ type: 'compaction', id: `prt_${seq}`, sessionID: 's', messageID: id }] },
    ...assistant.map((m) => ({ ...m, info: { ...m.info, parentID: id, summary: true } })),
  ];
}

function plainRows(id: string, assistant: ReturnType<typeof message>[], created = 0) {
  return [
    { info: { id, role: 'user', time: { created } }, parts: [text('hi')] },
    ...assistant.map((m) => ({ ...m, info: { ...m.info, parentID: id } })),
  ];
}

describe('compactionTurnView (web SessionTurnImpl isCompaction branch)', () => {
  const idle = { inFlight: false, hasContent: false };

  test('running while the turn works or the summary message is open', () => {
    expect(compactionTurnView({ working: true, compaction: idle, response: '', turnErrorIsAbort: false })).toEqual({
      kind: 'marker',
      running: true,
    });
    expect(
      compactionTurnView({ working: false, compaction: { ...idle, inFlight: true }, response: '', turnErrorIsAbort: false }),
    ).toEqual({ kind: 'marker', running: true });
  });

  test('a landed summary, or a compaction block with no text, is a settled marker', () => {
    expect(compactionTurnView({ working: false, compaction: idle, response: 'Summary', turnErrorIsAbort: false })).toEqual({
      kind: 'marker',
      running: false,
    });
    expect(
      compactionTurnView({ working: false, compaction: { ...idle, hasContent: true }, response: '', turnErrorIsAbort: false }),
    ).toEqual({ kind: 'marker', running: false });
  });

  test('an attempt that produced nothing is the failed row, with the turn error', () => {
    expect(
      compactionTurnView({ working: false, compaction: idle, response: '', turnError: 'Context too large', turnErrorIsAbort: false }),
    ).toEqual({ kind: 'failed', error: 'Context too large', isAbort: false });
  });

  /** The failed row of a real compaction turn, as `SessionTurn` builds it. */
  const failedView = (error: unknown) => {
    const t = turnsOf(compactionRows('c', [message([], { time: { created: 1, completed: 2 }, error })]))[0]!;
    expect(t.compaction).not.toBeNull();
    return compactionTurnView({
      working: false,
      compaction: t.compaction!,
      response: '',
      turnError: turnErrorText(t),
      turnErrorIsAbort: turnErrorIsAbort(t),
    });
  };

  test('the summary message error is the turn error, unwrapped', () => {
    expect(failedView({ name: 'APIError', data: { message: 'Provider overloaded' } })).toEqual({
      kind: 'failed',
      error: 'Provider overloaded',
      isAbort: false,
    });
  });

  test('no error at all leaves the error undefined', () => {
    expect(compactionTurnView({ working: false, compaction: idle, response: '', turnErrorIsAbort: false })).toEqual({
      kind: 'failed',
      error: undefined,
      isAbort: false,
    });
  });

  test('an abort from the turn or from the structured summary error', () => {
    expect(
      compactionTurnView({ working: false, compaction: idle, response: '', turnError: 'Aborted', turnErrorIsAbort: true }),
    ).toMatchObject({ kind: 'failed', isAbort: true });
    expect(failedView({ name: 'MessageAbortedError', data: { message: 'aborted' } })).toMatchObject({ kind: 'failed', isAbort: true });
    // A string error is prose, never an abort identity.
    expect(failedView('aborted')).toMatchObject({ kind: 'failed', isAbort: false });
  });
});

describe('lastCompactionTurnIndex', () => {
  test('finds the last compaction turn in any state', () => {
    const turns = turnsOf([
      ...compactionRows('a', [message([], { time: { created: 2, completed: 3 }, error: { name: 'APIError', data: { message: 'x' } } })], 1),
      ...plainRows('b', [message([text('ok')], { time: { created: 5, completed: 6 } })], 4),
      ...compactionRows('c', [], 7),
      ...plainRows('d', [], 8),
    ]);
    expect(turns.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(lastCompactionTurnIndex(turns)).toBe(2);
  });

  test('-1 without one', () => {
    const turns = turnsOf(plainRows('a', [message([text('ok')])]));
    expect(lastCompactionTurnIndex(turns)).toBe(-1);
    expect(lastCompactionTurnIndex([])).toBe(-1);
  });
});

describe('isSuppressedFailedCompaction (web retries collapse to one row)', () => {
  const failed = { block: null, hasContent: false, inFlight: false };

  test('a failed attempt before the last compaction turn is hidden', () => {
    expect(
      isSuppressedFailedCompaction({ compaction: failed, isTurnWorking: false, turnIndex: 0, lastCompactionTurnIndex: 2 }),
    ).toBe(true);
  });

  test('the latest attempt, a working one, an in-flight one, or a landed one stays', () => {
    const at = (compaction: typeof failed | null, isTurnWorking = false, turnIndex = 0) =>
      isSuppressedFailedCompaction({ compaction, isTurnWorking, turnIndex, lastCompactionTurnIndex: 2 });
    expect(at(failed, false, 2)).toBe(false);
    expect(at(failed, true)).toBe(false);
    expect(at({ ...failed, inFlight: true })).toBe(false);
    expect(at({ ...failed, hasContent: true })).toBe(false);
    expect(at(null)).toBe(false);
  });
});

describe('suppressWorkingTurnBusy (web SessionChat)', () => {
  const done = { time: { created: 1, completed: 2 } };

  test('false without pending turns', () => {
    const turns = turnsOf(plainRows('a', [message([text('ok')], done)]), { busy: true });
    expect(turns[0]!.live).toBe(true);
    expect(suppressWorkingTurnBusy(turns)).toBe(false);
  });

  test('true when the working turn finished while prompts wait below it', () => {
    const turns = turnsOf([...plainRows('a', [message([text('ok')], done)]), ...plainRows('b', [], 3)], { busy: true, held: ['b'] });
    expect(turns.map((t) => [t.id, t.live, t.queued])).toEqual([['a', true, false], ['b', false, true]]);
    expect(suppressWorkingTurnBusy(turns)).toBe(true);
  });

  test('false while the working turn streams, or has no answer yet', () => {
    const streaming = turnsOf([...plainRows('a', [message([text('…')])]), ...plainRows('b', [], 3)], { busy: true, held: ['b'] });
    expect(suppressWorkingTurnBusy(streaming)).toBe(false);
    const unanswered = turnsOf([...plainRows('a', []), ...plainRows('b', [], 3)], { busy: true, held: ['b'] });
    expect(suppressWorkingTurnBusy(unanswered)).toBe(false);
    const nothingLive = turnsOf([...plainRows('a', []), ...plainRows('b', [], 3)], { busy: true, held: ['a', 'b'] });
    expect(nothingLive.some((t) => t.live)).toBe(false);
    expect(suppressWorkingTurnBusy(nothingLive)).toBe(false);
  });
});

describe('transcriptBusyRowVisible (web "busy with no turn to attach it to")', () => {
  test('hidden when idle', () => {
    expect(transcriptBusyRowVisible({ isBusy: false, workingTurnId: null, suppressWorkingTurnBusy: false })).toBe(false);
  });
  test('hidden when a working turn draws its own row', () => {
    expect(transcriptBusyRowVisible({ isBusy: true, workingTurnId: 'a', suppressWorkingTurnBusy: false })).toBe(false);
  });
  test('shown when busy and no turn draws the row', () => {
    expect(transcriptBusyRowVisible({ isBusy: true, workingTurnId: null, suppressWorkingTurnBusy: false })).toBe(true);
    expect(transcriptBusyRowVisible({ isBusy: true, workingTurnId: 'a', suppressWorkingTurnBusy: true })).toBe(true);
  });
});

describe('turnBodyLayout (KRTX-1678: one render tree for the whole stream)', () => {
  const base = { hasAssistantContent: true, showInlineContent: false, isCommand: false };

  test('reply text stays in the segments list from first token to settled, so the first tool call does not remount it', () => {
    // The stream's states, in order: text only → first tool call → settled.
    const states = [
      { ...base, working: true, hasSteps: false },
      { ...base, working: true, hasSteps: true },
      { ...base, working: false, hasSteps: true },
    ];
    for (const state of states) expect(turnBodyLayout(state)).toEqual({ segments: true, text: 'segments' });
  });

  test('a text-only turn keeps the same tree when it settles', () => {
    expect(turnBodyLayout({ ...base, working: true, hasSteps: false })).toEqual(
      turnBodyLayout({ ...base, working: false, hasSteps: false }),
    );
  });

  test('inline content (text + answered questions) owns its text', () => {
    expect(turnBodyLayout({ ...base, working: false, hasSteps: false, showInlineContent: true })).toEqual({
      segments: false,
      text: 'inline',
    });
  });

  test('a slash-command reply streams in its card until the turn has steps', () => {
    expect(turnBodyLayout({ ...base, isCommand: true, working: true, hasSteps: false })).toEqual({
      segments: true,
      text: 'response',
    });
    expect(turnBodyLayout({ ...base, isCommand: true, working: false, hasSteps: false })).toEqual({
      segments: false,
      text: 'response',
    });
    expect(turnBodyLayout({ ...base, isCommand: true, working: true, hasSteps: true }).text).toBe('segments');
  });

  test('no assistant message yet → no segments list', () => {
    expect(turnBodyLayout({ ...base, hasAssistantContent: false, working: true, hasSteps: false }).segments).toBe(false);
  });
});
