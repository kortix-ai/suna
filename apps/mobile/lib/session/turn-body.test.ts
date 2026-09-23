import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@kortix/sdk';

import {
  WORKSPACE_ROOTS,
  answeredQuestionParts,
  commandPromptText,
  compactionTurnView,
  hasCompactionTurn,
  inlineContentItems,
  isSuppressedFailedCompaction,
  lastCompactionTurnIndex,
  lastTextPartId,
  parseAnswersFromOutput,
  segmentInputParts,
  showTurnActions,
  showTurnBusyIndicator,
  standaloneCallIdsFor,
  suppressWorkingTurnBusy,
  toDisplayPath,
  transcriptBusyRowVisible,
  turnErrorIsAbort,
  turnErrorText,
  turnHasReasoning,
  turnHasSteps,
  turnResponse,
  type TurnBodyTurn,
} from './turn-body';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function tool(name: string, state: Record<string, unknown> = {}, callID?: string): Part {
  seq += 1;
  return {
    type: 'tool',
    id: `prt_${seq}`,
    callID: callID ?? `call_${seq}`,
    tool: name,
    sessionID: 's',
    messageID: 'm',
    state: { status: 'completed', input: {}, output: '', ...state },
  } as unknown as Part;
}

function text(value: string, extra: Record<string, unknown> = {}): Part {
  seq += 1;
  return { type: 'text', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text: value, ...extra } as unknown as Part;
}

function reasoning(value: string): Part {
  seq += 1;
  return { type: 'reasoning', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text: value, time: { start: 1 } } as unknown as Part;
}

function plumbing(type: 'step-start' | 'step-finish' | 'snapshot' | 'patch'): Part {
  seq += 1;
  return { type, id: `prt_${seq}`, sessionID: 's', messageID: 'm' } as unknown as Part;
}

function message(parts: Part[], info: Record<string, unknown> = {}) {
  seq += 1;
  return { info: { id: `msg_${seq}`, role: 'assistant', time: { created: 1 }, ...info }, parts };
}

function turn(assistant: ReturnType<typeof message>[], userParts: Part[] = [text('hi')]): TurnBodyTurn {
  return {
    userMessage: { info: { id: 'msg_user', role: 'user', time: { created: 0 } }, parts: userParts },
    assistantMessages: assistant,
  } as unknown as TurnBodyTurn;
}

const wrap = (parts: Part[]) => parts.map((part) => ({ part }));

const QUESTION_INPUT = { questions: [{ question: 'Which colour?' }] };

// ─── hasSteps / hasReasoning ─────────────────────────────────────────────────

describe('turnHasSteps (web SessionTurnImpl hasSteps)', () => {
  test('a visible tool call is a step', () => {
    expect(turnHasSteps(wrap([text('a'), tool('bash')]))).toBe(true);
  });

  test('plan writes, task, and question calls are not steps', () => {
    expect(turnHasSteps(wrap([tool('todowrite'), tool('todo_write'), tool('task'), tool('question')]))).toBe(false);
  });

  test('snapshot, patch, and compaction parts count as steps', () => {
    expect(turnHasSteps(wrap([plumbing('snapshot')]))).toBe(true);
    expect(turnHasSteps(wrap([plumbing('patch')]))).toBe(true);
  });

  test('text and reasoning alone are not steps; hidden tools are not steps', () => {
    expect(turnHasSteps(wrap([text('a'), reasoning('b')]))).toBe(false);
    expect(turnHasSteps(wrap([tool('todoread')]))).toBe(false);
  });
});

describe('turnHasReasoning', () => {
  test('only non-blank reasoning counts', () => {
    expect(turnHasReasoning(wrap([reasoning('  ')]))).toBe(false);
    expect(turnHasReasoning(wrap([reasoning('plan')]))).toBe(true);
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

describe('answeredQuestionParts', () => {
  test('a question with server answers is kept as-is', () => {
    const q = tool('question', { input: QUESTION_INPUT, metadata: { answers: [['Blue']] } });
    const result = answeredQuestionParts(turn([message([q])]), new Set());
    expect(result).toEqual([q as ToolPart]);
  });

  test('the currently pending question with nothing after it is skipped', () => {
    const q = tool('question', { status: 'running', input: QUESTION_INPUT, output: undefined }, 'call_pending');
    expect(answeredQuestionParts(turn([message([q, plumbing('step-finish')])]), new Set(['call_pending']))).toEqual([]);
  });

  test('output plus later content yields a synthetic part with parsed answers', () => {
    const q = tool('question', { input: QUESTION_INPUT, output: '"Which colour?"="Red"' });
    const [result] = answeredQuestionParts(turn([message([q, text('ok')])]), new Set());
    expect(result.id).toBe(q.id);
    expect((result.state as { metadata?: { answers?: unknown } }).metadata?.answers).toEqual([['Red']]);
  });

  test('no output but later content yields placeholder answers', () => {
    const q = tool('question', { status: 'running', input: QUESTION_INPUT, output: undefined });
    const [result] = answeredQuestionParts(turn([message([q]), message([text('next')])]), new Set());
    expect((result.state as { status: string }).status).toBe('completed');
    expect((result.state as { metadata?: { answers?: unknown } }).metadata?.answers).toEqual([['Answered']]);
  });

  test('a question with neither answers nor later content is dropped', () => {
    const q = tool('question', { input: QUESTION_INPUT, output: '' });
    expect(answeredQuestionParts(turn([message([q])]), new Set())).toEqual([]);
  });
});

describe('inlineContentItems', () => {
  test('null unless both text and an answered question exist', () => {
    const q = tool('question');
    const answered = new Map([[q.id, q as ToolPart]]);
    expect(inlineContentItems(wrap([text('a')]), answered)).toBeNull();
    expect(inlineContentItems(wrap([q]), answered)).toBeNull();
  });

  test('keeps text and answered questions in natural order, substituting the answered part', () => {
    const a = text('a');
    const q = tool('question');
    const synthetic = { ...(q as ToolPart), state: { status: 'completed' } } as unknown as ToolPart;
    const b = text('b');
    const items = inlineContentItems(wrap([a, q, tool('bash'), b]), new Map([[q.id, synthetic]]));
    expect(items?.map((i) => i.type)).toEqual(['text', 'question', 'text']);
    expect(items?.[1].part).toBe(synthetic);
  });
});

// ─── Segment input ───────────────────────────────────────────────────────────

describe('segmentInputParts', () => {
  test('drops unanswered questions and substitutes answered ones', () => {
    const pending = tool('question');
    const answered = tool('question');
    const synthetic = { ...(answered as ToolPart) } as ToolPart;
    const bash = tool('bash');
    const result = segmentInputParts(wrap([pending, answered, bash]), new Map([[answered.id, synthetic]]), false);
    expect(result).toEqual([synthetic, bash]);
  });

  test('drops answered questions too when the inline content renders them', () => {
    const answered = tool('question');
    const result = segmentInputParts(wrap([answered]), new Map([[answered.id, answered as ToolPart]]), true);
    expect(result).toEqual([]);
  });

  test('keeps plan writes: mobile has no plan card, so the burst is the only todo surface', () => {
    const plan = tool('todowrite');
    expect(segmentInputParts(wrap([plan]), new Map(), false)).toEqual([plan]);
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
});

describe('lastTextPartId', () => {
  test('the id of the last text segment, or undefined', () => {
    const a = text('a');
    const b = text('b');
    expect(
      lastTextPartId([
        { kind: 'text', part: a },
        { kind: 'burst', parts: [] },
        { kind: 'text', part: b },
        { kind: 'burst', parts: [] },
      ] as never),
    ).toBe(b.id);
    expect(lastTextPartId([{ kind: 'burst', parts: [] }] as never)).toBeUndefined();
  });
});

// ─── Response ────────────────────────────────────────────────────────────────

describe('turnResponse (web `response`)', () => {
  test('while working: the active assistant message\'s text', () => {
    const done = message([text('old')], { time: { created: 1, completed: 2 } });
    const live = message([text('new '), text('stream')]);
    const t = turn([done, live]);
    expect(turnResponse({ turn: t, allParts: wrap([...done.parts, ...live.parts]), working: true, hasSteps: false })).toBe(
      'new stream',
    );
  });

  test('settled, no steps: every text part joined by a blank line', () => {
    const m = message([text(' one '), text('two')], { time: { created: 1, completed: 2 } });
    expect(turnResponse({ turn: turn([m]), allParts: wrap(m.parts), working: false, hasSteps: false })).toBe('one\n\ntwo');
  });

  test('settled with steps: the last text part, trimmed', () => {
    const m = message([text('one'), tool('bash'), text(' two ')], { time: { created: 1, completed: 2 } });
    expect(turnResponse({ turn: turn([m]), allParts: wrap(m.parts), working: false, hasSteps: true })).toBe('two');
  });

  test('a blank trailing text part does not hide the last real one', () => {
    const m = message([text('first'), tool('bash'), text('second'), text('')], {
      time: { created: 1, completed: 2 },
      error: { name: 'UnknownError', data: { message: 'x' } },
    });
    expect(turnResponse({ turn: turn([m]), allParts: wrap(m.parts), working: false, hasSteps: true })).toBe('second');
  });

  test('no text at all: empty', () => {
    const m = message([tool('bash')], { time: { created: 1, completed: 2 } });
    expect(turnResponse({ turn: turn([m]), allParts: wrap(m.parts), working: false, hasSteps: true })).toBe('');
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
    expect(turnErrorIsAbort(turn([message([])]))).toBe(false);
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
      commandPromptText([text('a'), text('hidden', { synthetic: true }), text('skip', { ignored: true }), text('b')]),
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

function compactionRequestTurn(id: string, assistant: ReturnType<typeof message>[]): TurnBodyTurn {
  seq += 1;
  return {
    userMessage: {
      info: { id, role: 'user', time: { created: 0 } },
      parts: [{ type: 'compaction', id: `prt_${seq}`, sessionID: 's', messageID: id } as unknown as Part],
    },
    assistantMessages: assistant,
  } as unknown as TurnBodyTurn;
}

function plainTurn(id: string, assistant: ReturnType<typeof message>[]): TurnBodyTurn {
  return {
    userMessage: { info: { id, role: 'user', time: { created: 0 } }, parts: [text('hi')] },
    assistantMessages: assistant,
  } as unknown as TurnBodyTurn;
}

describe('compactionTurnView (web SessionTurnImpl isCompaction branch)', () => {
  const idle = { inFlight: false, hasContent: false, error: null };

  test('running while the turn works or the summary message is open', () => {
    expect(compactionTurnView({ working: true, info: idle, response: '', turnErrorIsAbort: false })).toEqual({
      kind: 'marker',
      running: true,
    });
    expect(
      compactionTurnView({ working: false, info: { ...idle, inFlight: true }, response: '', turnErrorIsAbort: false }),
    ).toEqual({ kind: 'marker', running: true });
  });

  test('a landed summary, or a compaction part with no text, is a settled marker', () => {
    expect(compactionTurnView({ working: false, info: idle, response: 'Summary', turnErrorIsAbort: false })).toEqual({
      kind: 'marker',
      running: false,
    });
    expect(
      compactionTurnView({ working: false, info: { ...idle, hasContent: true }, response: '', turnErrorIsAbort: false }),
    ).toEqual({ kind: 'marker', running: false });
  });

  test('an attempt that produced nothing is the failed row, turn error first', () => {
    expect(
      compactionTurnView({
        working: false,
        info: { ...idle, error: { name: 'APIError', data: { message: 'raw failure' } } },
        response: '',
        turnError: 'Context too large',
        turnErrorIsAbort: false,
      }),
    ).toEqual({ kind: 'failed', error: 'Context too large', isAbort: false });
  });

  test('a synthetic turn falls back to the summary message error, unwrapped', () => {
    const view = compactionTurnView({
      working: false,
      info: { ...idle, error: { name: 'APIError', data: { message: 'Provider overloaded' } } },
      response: '',
      turnErrorIsAbort: false,
    });
    expect(view).toEqual({ kind: 'failed', error: 'Provider overloaded', isAbort: false });
  });

  test('no error at all leaves the error undefined', () => {
    expect(compactionTurnView({ working: false, info: idle, response: '', turnErrorIsAbort: false })).toEqual({
      kind: 'failed',
      error: undefined,
      isAbort: false,
    });
  });

  test('an abort from the turn or from the structured summary error', () => {
    expect(
      compactionTurnView({ working: false, info: idle, response: '', turnError: 'Aborted', turnErrorIsAbort: true }),
    ).toMatchObject({ kind: 'failed', isAbort: true });
    expect(
      compactionTurnView({
        working: false,
        info: { ...idle, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } },
        response: '',
        turnErrorIsAbort: false,
      }),
    ).toMatchObject({ kind: 'failed', isAbort: true });
    // A string error is prose, never an abort identity.
    expect(
      compactionTurnView({ working: false, info: { ...idle, error: 'aborted' }, response: '', turnErrorIsAbort: false }),
    ).toMatchObject({ kind: 'failed', isAbort: false });
  });
});

describe('lastCompactionTurnIndex / hasCompactionTurn', () => {
  test('finds the last compaction turn in any state', () => {
    const turns = [
      compactionRequestTurn('a', [message([], { summary: true, error: { name: 'APIError' } })]),
      plainTurn('b', [message([text('ok')], { time: { created: 1, completed: 2 } })]),
      compactionRequestTurn('c', []),
      plainTurn('d', []),
    ];
    expect(lastCompactionTurnIndex(turns)).toBe(2);
    expect(hasCompactionTurn(turns)).toBe(true);
  });

  test('-1 and false without one', () => {
    const turns = [plainTurn('a', [message([text('ok')])])];
    expect(lastCompactionTurnIndex(turns)).toBe(-1);
    expect(hasCompactionTurn(turns)).toBe(false);
    expect(lastCompactionTurnIndex([])).toBe(-1);
  });
});

describe('isSuppressedFailedCompaction (web retries collapse to one row)', () => {
  const failed = { isCompaction: true, hasContent: false, inFlight: false, error: null };

  test('a failed attempt before the last compaction turn is hidden', () => {
    expect(
      isSuppressedFailedCompaction({ info: failed, isTurnWorking: false, turnIndex: 0, lastCompactionTurnIndex: 2 }),
    ).toBe(true);
  });

  test('the latest attempt, a working one, an in-flight one, or a landed one stays', () => {
    const at = (info: typeof failed, isTurnWorking = false, turnIndex = 0) =>
      isSuppressedFailedCompaction({ info, isTurnWorking, turnIndex, lastCompactionTurnIndex: 2 });
    expect(at(failed, false, 2)).toBe(false);
    expect(at(failed, true)).toBe(false);
    expect(at({ ...failed, inFlight: true })).toBe(false);
    expect(at({ ...failed, hasContent: true })).toBe(false);
    expect(at({ ...failed, isCompaction: false })).toBe(false);
  });
});

describe('suppressWorkingTurnBusy (web SessionChat)', () => {
  const done = { time: { created: 1, completed: 2 } };

  test('false without pending turns', () => {
    const turns = [plainTurn('a', [message([text('ok')], done)])];
    expect(suppressWorkingTurnBusy(turns, { workingTurnId: 'a', pendingTurnIds: [] })).toBe(false);
  });

  test('true when the working turn finished while prompts wait below it', () => {
    const turns = [plainTurn('a', [message([text('ok')], done)]), plainTurn('b', [])];
    expect(suppressWorkingTurnBusy(turns, { workingTurnId: 'a', pendingTurnIds: ['b'] })).toBe(true);
  });

  test('false while the working turn streams, or has no answer yet', () => {
    const streaming = [plainTurn('a', [message([text('…')])]), plainTurn('b', [])];
    expect(suppressWorkingTurnBusy(streaming, { workingTurnId: 'a', pendingTurnIds: ['b'] })).toBe(false);
    const unanswered = [plainTurn('a', []), plainTurn('b', [])];
    expect(suppressWorkingTurnBusy(unanswered, { workingTurnId: 'a', pendingTurnIds: ['b'] })).toBe(false);
    expect(suppressWorkingTurnBusy(unanswered, { workingTurnId: null, pendingTurnIds: ['a', 'b'] })).toBe(false);
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
