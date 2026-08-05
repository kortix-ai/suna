/**
 * `computeTurnRowInputs` is a refactor, not a feature: it lifts the bodies of
 * `useTurnModel`'s memos into a plain function so a row-granularity transcript
 * can run them in a loop. The only thing worth testing about a refactor is that
 * it changed nothing.
 *
 * So this file carries a FROZEN transcription of the memo bodies as they stood
 * before the lift (`oracleRowInputs`), and asserts the two agree, field by
 * field, over representative turns. It is a characterization test: the oracle
 * must never be "fixed" to match a new implementation. If it goes red, either
 * the extraction drifted (fix the code) or the behaviour changed on purpose
 * (say so, and replace the oracle in its own commit).
 *
 * The concrete-value assertions below the equivalence block do the second job:
 * they say what the values ARE, so the file still documents behaviour once the
 * oracle is eventually retired.
 */

import {
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type TextPart,
  type ToolPart,
  collectTurnParts,
  findLastTextPart,
  getShellModePart,
  getWorkingState,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
} from '@/ui';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SessionTurnProps } from '../session-chat';
import { type Segment, segmentTurn } from './segment-turn';
import {
  type TurnRowInputs,
  computeTurnParts,
  computeTurnRowInputs,
  optimisticAnswersCache,
} from './use-turn-model';

// ============================================================================
// The oracle — a frozen copy of the pre-extraction memo bodies
// ============================================================================

/** Frozen copy of `parseAnswersFromOutput` (module-private in the source). */
function oracleParseAnswersFromOutput(
  output: string,
  input?: { questions?: Array<{ question: string }> },
): string[][] | null {
  if (!output) return null;
  const questions = input?.questions;
  if (!questions || questions.length === 0) return null;
  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const pairs: { question: string; answer: string }[] = [];
  let match;
  while ((match = pairRegex.exec(output)) !== null) {
    pairs.push({ question: match[1], answer: match[2] });
  }
  if (pairs.length > 0) {
    return questions.map((_, i) => {
      const pair = pairs[i];
      return pair ? [pair.answer] : [];
    });
  }
  if (output.toLowerCase().includes('answered')) {
    return questions.map(() => ['Answered']);
  }
  return null;
}

/**
 * Frozen copy of the memo chain that produced `segments`, `showSegments`,
 * `singleRowKind`, `working`, `hasSteps` and `answeredQuestionPartsById`,
 * plus `response`, which `singleRowKind` reads.
 */
function oracleRowInputs(props: SessionTurnProps): TurnRowInputs & { response: string } {
  const {
    turn,
    isLastUserTurn,
    sessionId,
    sessionStatus,
    permissions,
    questions,
    isBusy,
    isCompaction,
  } = props;

  const allParts = collectTurnParts(turn);

  const hasSteps = allParts.some(({ part }) => {
    if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch')
      return true;
    if (isToolPart(part)) {
      if (part.tool === 'todowrite' || part.tool === 'task' || part.tool === 'question')
        return false;
      return shouldShowToolPart(part);
    }
    return false;
  });

  const hasReasoning = allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim());

  const working = getWorkingState(sessionStatus, isLastUserTurn) || (isLastUserTurn && isBusy);

  let activeAssistantMessage: (typeof turn.assistantMessages)[number] | undefined;
  if (turn.assistantMessages.length === 0) {
    activeAssistantMessage = undefined;
  } else {
    activeAssistantMessage = turn.assistantMessages[turn.assistantMessages.length - 1];
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as any)?.time?.completed) {
        activeAssistantMessage = msg;
        break;
      }
    }
  }

  const streamingResponseRaw = !activeAssistantMessage
    ? ''
    : activeAssistantMessage.parts
        .filter(isTextPart)
        .map((p) => p.text ?? '')
        .join('');

  const lastTextPart = findLastTextPart(allParts);
  const responseRaw = lastTextPart?.text ?? '';

  let abortedTextFallback = '';
  if (!responseRaw) {
    const hasError = turn.assistantMessages.some((m) => (m.info as any).error);
    if (hasError) {
      const texts: string[] = [];
      for (const { part } of allParts) {
        if (isTextPart(part) && part.text?.trim()) texts.push(part.text);
      }
      abortedTextFallback = texts.join('\n\n').trim();
    }
  }

  const completedTextParts = allParts
    .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
    .filter((text): text is string => Boolean(text));

  const response = working
    ? streamingResponseRaw || responseRaw
    : !hasSteps && completedTextParts.length > 0
      ? completedTextParts.join('\n\n')
      : responseRaw.trim() || abortedTextFallback;

  const shellModePart = getShellModePart(turn);

  // ---- answeredQuestionParts ----
  const pendingCallIds = new Set(
    questions
      .filter((q) => q.sessionID === sessionId)
      .map((q) => q.tool?.callID)
      .filter(Boolean),
  );
  const questionInfos: { tool: ToolPart; msgId: string; msgIndex: number; partIndex: number }[] =
    [];
  for (let mi = 0; mi < turn.assistantMessages.length; mi++) {
    const msg = turn.assistantMessages[mi];
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== 'tool') continue;
      const tool = part as ToolPart;
      if (tool.tool !== 'question') continue;
      questionInfos.push({ tool, msgId: msg.info.id, msgIndex: mi, partIndex: pi });
    }
  }
  const answeredQuestionParts: { part: ToolPart; messageId: string }[] = [];
  for (const qInfo of questionInfos) {
    const { tool, msgId, msgIndex, partIndex } = qInfo;
    const hasSubsequentContent = (() => {
      const msg = turn.assistantMessages[msgIndex];
      for (let pi = partIndex + 1; pi < msg.parts.length; pi++) {
        const p = msg.parts[pi];
        if (p.type === 'step-finish' || p.type === 'step-start') continue;
        return true;
      }
      return msgIndex < turn.assistantMessages.length - 1;
    })();
    const isPending = pendingCallIds.has(tool.callID);
    if (isPending && !hasSubsequentContent) continue;

    const serverAnswers = (tool.state as any)?.metadata?.answers;
    const cached = optimisticAnswersCache.get(tool.id);
    const toolOutput = (tool.state as any)?.output as string | undefined;

    if (serverAnswers && serverAnswers.length > 0) {
      if (cached) optimisticAnswersCache.delete(tool.id);
      answeredQuestionParts.push({ part: tool, messageId: msgId });
    } else if (cached) {
      answeredQuestionParts.push({
        part: {
          ...tool,
          state: {
            ...(tool.state as any),
            status: 'completed',
            input: cached.input,
            metadata: { ...((tool.state as any)?.metadata ?? {}), answers: cached.answers },
          },
        } as unknown as ToolPart,
        messageId: msgId,
      });
    } else if (toolOutput && hasSubsequentContent) {
      const parsed = oracleParseAnswersFromOutput(toolOutput, (tool.state as any)?.input);
      if (parsed) {
        answeredQuestionParts.push({
          part: {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: { ...((tool.state as any)?.metadata ?? {}), answers: parsed },
            },
          } as unknown as ToolPart,
          messageId: msgId,
        });
      }
    } else if (!toolOutput && hasSubsequentContent) {
      const input = (tool.state as any)?.input;
      const questionsList: { question: string }[] = Array.isArray(input?.questions)
        ? input.questions
        : [];
      if (questionsList.length > 0) {
        answeredQuestionParts.push({
          part: {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: {
                ...((tool.state as any)?.metadata ?? {}),
                answers: questionsList.map(() => ['Answered']),
              },
            },
          } as unknown as ToolPart,
          messageId: msgId,
        });
      }
    }
  }

  const answeredQuestionPartsById = new Map(
    answeredQuestionParts.map(({ part }) => [part.id, part]),
  );

  // ---- inlineContentParts ----
  let inlineContentParts: Array<
    { type: 'text'; part: TextPart; id: string } | { type: 'question'; part: ToolPart; id: string }
  > | null = null;
  if (answeredQuestionParts.length > 0) {
    const items: Array<
      | { type: 'text'; part: TextPart; id: string }
      | { type: 'question'; part: ToolPart; id: string }
    > = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        items.push({ type: 'text', part, id: part.id });
      } else if (
        isToolPart(part) &&
        part.tool === 'question' &&
        answeredQuestionPartsById.has(part.id)
      ) {
        items.push({
          type: 'question',
          part: answeredQuestionPartsById.get(part.id)!,
          id: part.id,
        });
      }
    }
    const hasText = items.some((i) => i.type === 'text');
    const hasQuestion = items.some((i) => i.type === 'question');
    inlineContentParts = !hasText || !hasQuestion ? null : items;
  }
  const shouldUseInlineContent = !hasSteps && !!inlineContentParts;

  // ---- standaloneCallIds ----
  const standaloneCallIds = new Set<string>();
  for (const permission of permissions) {
    if (permission.sessionID === sessionId && permission.tool?.callID) {
      standaloneCallIds.add(permission.tool.callID);
    }
  }
  for (const { part } of answeredQuestionParts) standaloneCallIds.add(part.callID);

  // ---- segments ----
  const segments = segmentTurn(
    allParts
      .map(({ part }) => part)
      .filter((part) => {
        if (isToolPart(part) && part.tool === 'todowrite') return false;
        if (isToolPart(part) && part.tool === 'question') {
          return answeredQuestionPartsById.has(part.id) && !shouldUseInlineContent;
        }
        return true;
      }),
    { standaloneCallIds },
  );

  const showSegments = (working || hasSteps || hasReasoning) && turn.assistantMessages.length > 0;

  const singleRowKind: 'shell' | 'compaction' | null = shellModePart
    ? 'shell'
    : isCompaction && !working && response
      ? 'compaction'
      : null;

  return {
    segments,
    showSegments,
    singleRowKind,
    working,
    hasSteps,
    answeredQuestionPartsById,
    response,
  };
}

// ============================================================================
// Fixtures
// ============================================================================

function tool(id: string, name: string, state: Record<string, unknown> = {}): Part {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed', ...state },
  } as unknown as Part;
}

function text(id: string, body: string, extra: Record<string, unknown> = {}): Part {
  return { id, type: 'text', text: body, ...extra } as unknown as Part;
}

function reasoning(id: string, body: string): Part {
  return { id, type: 'reasoning', text: body } as unknown as Part;
}

function message(id: string, parts: Part[], info: Record<string, unknown> = {}) {
  return {
    info: { id, role: 'assistant', time: { completed: 1 }, ...info },
    parts,
  } as unknown as SessionTurnProps['turn']['assistantMessages'][number];
}

function userMessage(parts: Part[]) {
  return {
    info: { id: 'user-1', role: 'user' },
    parts,
  } as unknown as SessionTurnProps['turn']['userMessage'];
}

function props(overrides: Partial<SessionTurnProps> = {}): SessionTurnProps {
  return {
    turn: {
      userMessage: userMessage([text('u1', 'do the thing')]),
      assistantMessages: [],
    },
    isLastUserTurn: false,
    isPlanAnchor: false,
    sessionId: 'ses_1',
    sessionStatus: undefined,
    permissions: [],
    questions: [],
    isFirstTurn: true,
    isBusy: false,
    onPermissionReply: async () => {},
    onRewind: () => {},
    rewindDisabled: false,
    ...overrides,
  } as SessionTurnProps;
}

const busyStatus = { type: 'busy' } as unknown as SessionTurnProps['sessionStatus'];

/** A turn with a tool burst and a closing response. */
const toolBurstTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'read the config')]),
      assistantMessages: [
        message('m1', [
          tool('t1', 'read'),
          tool('t2', 'bash'),
          reasoning('r1', 'the config is json'),
          text('x1', 'Here is the config.'),
        ]),
      ],
    },
  });

/** Shell mode: one synthetic user text part, one assistant message, one bash part. */
const shellTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', '!ls -la', { synthetic: true })]),
      assistantMessages: [message('m1', [tool('t1', 'bash')])],
    },
  });

/** A compaction turn: `isCompaction`, settled, with a summary to show. */
const compactionTurn = () =>
  props({
    isCompaction: true,
    turn: {
      userMessage: userMessage([text('u1', '', { synthetic: true })]),
      assistantMessages: [message('m1', [text('x1', 'Summary of the conversation so far.')])],
    },
  });

/**
 * A compaction turn that ALSO has steps — `hasSteps` flips `response` onto a
 * different branch, and `singleRowKind` reads `response`.
 */
const compactionWithStepsTurn = () =>
  props({
    isCompaction: true,
    turn: {
      userMessage: userMessage([text('u1', '', { synthetic: true })]),
      assistantMessages: [
        message('m1', [
          { id: 'c1', type: 'compaction' } as unknown as Part,
          text('x1', 'Summary of the conversation so far.'),
        ]),
      ],
    },
  });

/** `isCompaction`, but nothing to summarize — the card must NOT short-circuit. */
const compactionNoResponseTurn = () =>
  props({
    isCompaction: true,
    turn: {
      userMessage: userMessage([text('u1', '', { synthetic: true })]),
      assistantMessages: [message('m1', [tool('t1', 'read')])],
    },
  });

/** `isCompaction` while still working — the card must NOT short-circuit. */
const compactionWorkingTurn = () =>
  props({
    isCompaction: true,
    isLastUserTurn: true,
    sessionStatus: busyStatus,
    turn: {
      userMessage: userMessage([text('u1', '', { synthetic: true })]),
      assistantMessages: [message('m1', [text('x1', 'Summary so far.')], { time: {} })],
    },
  });

/** An answered question with server answers, followed by prose. No tool steps. */
const answeredQuestionTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'which framework?')]),
      assistantMessages: [
        message('m1', [
          text('x1', 'A couple of things first.'),
          tool('q1', 'question', {
            input: { questions: [{ question: 'Which framework?' }] },
            metadata: { answers: [['Next.js']] },
          }),
          text('x2', 'Going with Next.js then.'),
        ]),
      ],
    },
  });

/** The same answered question, but the turn also has real tool steps. */
const answeredQuestionWithStepsTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'which framework?')]),
      assistantMessages: [
        message('m1', [
          tool('t1', 'read'),
          tool('q1', 'question', {
            input: { questions: [{ question: 'Which framework?' }] },
            metadata: { answers: [['Next.js']] },
          }),
          text('x2', 'Going with Next.js then.'),
        ]),
      ],
    },
  });

/** A `todowrite` call — the plan card owns it, so it never reaches a segment. */
const todowriteTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'plan it')]),
      assistantMessages: [
        message('m1', [tool('t1', 'read'), tool('t2', 'todowrite'), text('x1', 'Planned.')]),
      ],
    },
  });

/**
 * A question that is pending in the composer AND already carries server
 * answers, with nothing after it. The pending check is the only thing keeping
 * it out of the answered set.
 */
const pendingQuestionWithAnswersTurn = () =>
  props({
    questions: [{ sessionID: 'ses_1', tool: { callID: 'call_q1' } } as unknown as QuestionRequest],
    turn: {
      userMessage: userMessage([text('u1', 'which framework?')]),
      assistantMessages: [
        message('m1', [
          tool('q1', 'question', {
            input: { questions: [{ question: 'Which framework?' }] },
            metadata: { answers: [['Next.js']] },
          }),
        ]),
      ],
    },
  });

/** Just sent: working, but the assistant has not replied yet. */
const justSentTurn = () =>
  props({
    isLastUserTurn: true,
    sessionStatus: busyStatus,
    turn: {
      userMessage: userMessage([text('u1', 'go')]),
      assistantMessages: [],
    },
  });

/** Streaming across two text parts — the concatenation differs from the last. */
const multiTextStreamingTurn = () =>
  props({
    isLastUserTurn: true,
    sessionStatus: busyStatus,
    turn: {
      userMessage: userMessage([text('u1', 'explain')]),
      assistantMessages: [
        message('m1', [text('x1', 'Part one. '), text('x2', 'Part two.')], { time: {} }),
      ],
    },
  });

/**
 * Two unsettled assistant messages. The streamed response comes from the LAST
 * one, so scanning from the wrong end shows stale text.
 */
const twoLiveAssistantMessagesTurn = () =>
  props({
    isLastUserTurn: true,
    sessionStatus: busyStatus,
    turn: {
      userMessage: userMessage([text('u1', 'draft it')]),
      assistantMessages: [
        message('m1', [text('x1', 'Earlier draft.')], { time: {} }),
        message('m2', [text('x2', 'Latest draft.')], { time: {} }),
      ],
    },
  });

/**
 * An answered question with NO prose anywhere in the turn. Inline rendering
 * needs both kinds, so it must stay off and the question must stay a segment.
 */
const answeredQuestionNoTextTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'which framework?')]),
      assistantMessages: [
        message('m1', [
          tool('q1', 'question', {
            input: { questions: [{ question: 'Which framework?' }] },
            metadata: { answers: [['Next.js']] },
          }),
        ]),
        message('m2', [tool('t1', 'todowrite')]),
      ],
    },
  });

/** A pending question — no subsequent content, so it is NOT answered. */
const pendingQuestionTurn = () =>
  props({
    questions: [{ sessionID: 'ses_1', tool: { callID: 'call_q1' } } as unknown as QuestionRequest],
    turn: {
      userMessage: userMessage([text('u1', 'which framework?')]),
      assistantMessages: [
        message('m1', [
          tool('q1', 'question', { input: { questions: [{ question: 'Which framework?' }] } }),
        ]),
      ],
    },
  });

/** A live turn: last user turn, session busy, last assistant message unsettled. */
const streamingTurn = () =>
  props({
    isLastUserTurn: true,
    sessionStatus: busyStatus,
    turn: {
      userMessage: userMessage([text('u1', 'write the file')]),
      assistantMessages: [
        message('m1', [tool('t1', 'write'), text('x1', 'Writing it now')], { time: {} }),
      ],
    },
  });

/**
 * Reasoning and nothing else — settled, no tool steps. `hasReasoning` is the
 * only thing that can open the segment region here.
 */
const reasoningOnlyTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'think about it')]),
      assistantMessages: [message('m1', [reasoning('r1', 'weighing the options')])],
    },
  });

/** Reasoning whose text is blank — it does NOT count as reasoning. */
const blankReasoningTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'think about it')]),
      assistantMessages: [message('m1', [reasoning('r1', '   ')])],
    },
  });

/**
 * Sent, but the session status has not caught up yet: `isBusy` is the only
 * thing making this turn work.
 */
const optimisticallyBusyTurn = () =>
  props({
    isLastUserTurn: true,
    isBusy: true,
    sessionStatus: undefined,
    turn: {
      userMessage: userMessage([text('u1', 'go')]),
      assistantMessages: [message('m1', [text('x1', 'On it')], { time: {} })],
    },
  });

/** An aborted turn whose LAST text part is blank — earlier text still shows. */
const abortedTurn = () =>
  props({
    turn: {
      userMessage: userMessage([text('u1', 'do it')]),
      assistantMessages: [
        message('m1', [text('x1', 'Started the work'), text('x2', '   ')], {
          error: { name: 'AbortedError' },
        }),
      ],
    },
  });

/** A same-session permission and a foreign one, over the same tool burst. */
const permissionTurn = () =>
  props({
    permissions: [
      { sessionID: 'ses_other', tool: { callID: 'call_t1' } } as unknown as PermissionRequest,
      { sessionID: 'ses_1', tool: { callID: 'call_t2' } } as unknown as PermissionRequest,
    ],
    turn: toolBurstTurn().turn,
  });

/** No assistant messages at all. */
const emptyTurn = () => props();

const FIXTURES: [string, () => SessionTurnProps][] = [
  ['tool burst + text', toolBurstTurn],
  ['shell mode', shellTurn],
  ['compaction', compactionTurn],
  ['compaction with steps', compactionWithStepsTurn],
  ['compaction, no response', compactionNoResponseTurn],
  ['compaction, still working', compactionWorkingTurn],
  ['answered question (no steps)', answeredQuestionTurn],
  ['answered question (with steps)', answeredQuestionWithStepsTurn],
  ['pending question', pendingQuestionTurn],
  ['pending question with server answers', pendingQuestionWithAnswersTurn],
  ['todowrite', todowriteTurn],
  ['just sent, no assistant reply', justSentTurn],
  ['streaming across two text parts', multiTextStreamingTurn],
  ['two live assistant messages', twoLiveAssistantMessagesTurn],
  ['answered question, no prose', answeredQuestionNoTextTurn],
  ['streaming', streamingTurn],
  ['reasoning only', reasoningOnlyTurn],
  ['blank reasoning only', blankReasoningTurn],
  ['optimistically busy', optimisticallyBusyTurn],
  ['aborted, blank last text', abortedTurn],
  ['scoped permissions', permissionTurn],
  ['empty turn', emptyTurn],
];

// ============================================================================
// Equivalence — the actual proof
// ============================================================================

describe('computeTurnRowInputs matches the pre-extraction memo bodies', () => {
  beforeEach(() => optimisticAnswersCache.clear());

  for (const [name, build] of FIXTURES) {
    test(name, () => {
      // Two independent fixture instances so neither run can observe the
      // other's part objects; the oracle runs first and may mutate the
      // shared optimistic-answers cache, so it is cleared in between.
      const expected = oracleRowInputs(build());
      optimisticAnswersCache.clear();
      const actual = computeTurnRowInputs(build());

      expect(actual.hasSteps).toEqual(expected.hasSteps);
      expect(actual.working).toEqual(expected.working);
      expect(actual.showSegments).toEqual(expected.showSegments);
      expect(actual.singleRowKind).toEqual(expected.singleRowKind);
      expect(actual.response).toEqual(expected.response);
      expect(actual.segments).toEqual(expected.segments);
      expect(actual.answeredQuestionPartsById).toEqual(expected.answeredQuestionPartsById);
    });
  }

  test('optimistically-cached answers agree, and the cache delete is idempotent', () => {
    const cached = { answers: [['Next.js']], input: { questions: [{ question: 'Which?' }] } };
    const build = () =>
      props({
        turn: {
          userMessage: userMessage([text('u1', 'which framework?')]),
          assistantMessages: [
            message('m1', [
              tool('q1', 'question', { input: { questions: [{ question: 'Which?' }] } }),
              text('x1', 'Going with Next.js then.'),
            ]),
          ],
        },
      });

    optimisticAnswersCache.set('q1', cached);
    const expected = oracleRowInputs(build());
    optimisticAnswersCache.clear();
    optimisticAnswersCache.set('q1', cached);
    const actual = computeTurnRowInputs(build());

    expect(actual.answeredQuestionPartsById).toEqual(expected.answeredQuestionPartsById);
    expect((actual.answeredQuestionPartsById.get('q1')!.state as any).metadata.answers).toEqual([
      ['Next.js'],
    ]);
    // A cache entry with no server answers survives — nothing deletes it.
    expect(optimisticAnswersCache.has('q1')).toBe(true);

    // Server answers arrive: the entry is deleted, and running twice over the
    // same data (which the transcript loop + the hook both do) is stable.
    const served = () =>
      props({
        turn: {
          userMessage: userMessage([text('u1', 'which framework?')]),
          assistantMessages: [
            message('m1', [
              tool('q1', 'question', {
                input: { questions: [{ question: 'Which?' }] },
                metadata: { answers: [['Next.js']] },
              }),
              text('x1', 'Going with Next.js then.'),
            ]),
          ],
        },
      });
    const first = computeTurnRowInputs(served());
    expect(optimisticAnswersCache.has('q1')).toBe(false);
    const second = computeTurnRowInputs(served());
    expect(second.answeredQuestionPartsById).toEqual(first.answeredQuestionPartsById);
  });
});

// ============================================================================
// What the values actually are
// ============================================================================

const kinds = (segments: Segment[]) => segments.map((s) => s.kind);

describe('computeTurnRowInputs', () => {
  beforeEach(() => optimisticAnswersCache.clear());

  test('a tool burst plus prose segments into burst + text', () => {
    const result = computeTurnRowInputs(toolBurstTurn());

    expect(kinds(result.segments)).toEqual(['burst', 'text']);
    expect(result.hasSteps).toBe(true);
    expect(result.showSegments).toBe(true);
    expect(result.singleRowKind).toBeNull();
    expect(result.working).toBe(false);
  });

  test('a shell turn is a single row, and shell wins over everything else', () => {
    const result = computeTurnRowInputs(shellTurn());

    expect(result.singleRowKind).toBe('shell');
  });

  test('shell wins over compaction', () => {
    const shell = shellTurn();
    const result = computeTurnRowInputs({ ...shell, isCompaction: true });

    expect(result.singleRowKind).toBe('shell');
  });

  test('a settled compaction turn with a summary is a single row', () => {
    const result = computeTurnRowInputs(compactionTurn());

    expect(result.singleRowKind).toBe('compaction');
    // No steps, no reasoning, not working — the segment region is off anyway.
    expect(result.showSegments).toBe(false);
  });

  test('a compaction turn WITH steps still short-circuits to one row', () => {
    const result = computeTurnRowInputs(compactionWithStepsTurn());

    // `hasSteps` is true (the compaction part), which moves `response` onto the
    // `responseRaw.trim()` branch — it must still be non-empty, or the turn
    // silently renders as a normal turn instead of a compaction card.
    expect(result.hasSteps).toBe(true);
    expect(result.showSegments).toBe(true);
    expect(result.singleRowKind).toBe('compaction');
  });

  test('a compaction turn with no response is NOT a single row', () => {
    const base = compactionTurn();
    const result = computeTurnRowInputs({
      ...base,
      turn: {
        ...base.turn,
        assistantMessages: [message('m1', [tool('t1', 'read')])],
      },
    });

    expect(result.singleRowKind).toBeNull();
  });

  test('a working compaction turn is NOT a single row', () => {
    const base = compactionTurn();
    const result = computeTurnRowInputs({
      ...base,
      isLastUserTurn: true,
      sessionStatus: busyStatus,
    });

    expect(result.working).toBe(true);
    expect(result.singleRowKind).toBeNull();
  });

  test('an answered question with no steps renders inline, so it leaves the segments', () => {
    const result = computeTurnRowInputs(answeredQuestionTurn());

    expect(result.answeredQuestionPartsById.has('q1')).toBe(true);
    expect(result.hasSteps).toBe(false);
    // The question is filtered out: TurnTail renders it inline instead.
    expect(kinds(result.segments)).toEqual(['text', 'text']);
  });

  test('an answered question in a turn WITH steps stays, as a standalone segment', () => {
    const result = computeTurnRowInputs(answeredQuestionWithStepsTurn());

    expect(result.hasSteps).toBe(true);
    expect(kinds(result.segments)).toEqual(['burst', 'standalone', 'text']);
  });

  test('a pending question is not answered, and is dropped from the segments', () => {
    const result = computeTurnRowInputs(pendingQuestionTurn());

    expect(result.answeredQuestionPartsById.size).toBe(0);
    expect(result.segments).toEqual([]);
    // A question part is not a "step".
    expect(result.hasSteps).toBe(false);
    expect(result.showSegments).toBe(false);
  });

  test('a pending question that already has server answers is still skipped', () => {
    const result = computeTurnRowInputs(pendingQuestionWithAnswersTurn());

    // The composer owns the live prompt; a second card here would duplicate it.
    expect(result.answeredQuestionPartsById.size).toBe(0);
  });

  test('todowrite never reaches a segment — the plan card owns it', () => {
    const result = computeTurnRowInputs(todowriteTurn());

    expect(kinds(result.segments)).toEqual(['burst', 'text']);
    expect((result.segments[0] as { parts: Part[] }).parts.map((p) => p.id)).toEqual(['t1']);
  });

  test('a live turn is working and shows the segment region', () => {
    const result = computeTurnRowInputs(streamingTurn());

    expect(result.working).toBe(true);
    expect(result.showSegments).toBe(true);
    expect(result.singleRowKind).toBeNull();
  });

  test('the streamed response comes from the LAST unsettled assistant message', () => {
    const result = computeTurnRowInputs(twoLiveAssistantMessagesTurn());

    expect(result.response).toBe('Latest draft.');
  });

  test('inline rendering needs both prose and a question, so a lone question stays a segment', () => {
    const result = computeTurnRowInputs(answeredQuestionNoTextTurn());

    expect(result.answeredQuestionPartsById.has('q1')).toBe(true);
    expect(kinds(result.segments)).toEqual(['standalone']);
  });

  test('a just-sent turn is working but has no segment region to show', () => {
    const result = computeTurnRowInputs(justSentTurn());

    expect(result.working).toBe(true);
    expect(result.showSegments).toBe(false);
    expect(result.segments).toEqual([]);
  });

  test('a streaming response is the active message concatenated, not its last part', () => {
    const result = computeTurnRowInputs(multiTextStreamingTurn());

    expect(result.response).toBe('Part one. Part two.');
  });

  test('reasoning alone opens the segment region', () => {
    const result = computeTurnRowInputs(reasoningOnlyTurn());

    expect(result.hasSteps).toBe(false);
    expect(result.working).toBe(false);
    expect(result.showSegments).toBe(true);
    expect(kinds(result.segments)).toEqual(['burst']);
  });

  test('blank reasoning does not open the segment region', () => {
    const result = computeTurnRowInputs(blankReasoningTurn());

    expect(result.showSegments).toBe(false);
  });

  test('isBusy on the last turn is working, before the status catches up', () => {
    const result = computeTurnRowInputs(optimisticallyBusyTurn());

    expect(result.working).toBe(true);
    // Not the last turn: isBusy alone means nothing.
    expect(
      computeTurnRowInputs({ ...optimisticallyBusyTurn(), isLastUserTurn: false }).working,
    ).toBe(false);
  });

  test('an empty turn produces no segments and no segment region', () => {
    const result = computeTurnRowInputs(emptyTurn());

    expect(result.segments).toEqual([]);
    expect(result.showSegments).toBe(false);
    expect(result.singleRowKind).toBeNull();
    expect(result.hasSteps).toBe(false);
    expect(result.answeredQuestionPartsById.size).toBe(0);
  });

  test('a pending permission forces its tool part out of the burst', () => {
    const base = toolBurstTurn();
    const result = computeTurnRowInputs({
      ...base,
      permissions: [
        { sessionID: 'ses_1', tool: { callID: 'call_t2' } } as unknown as PermissionRequest,
      ],
    });

    // read | bash | reasoning | text — pulling bash out splits the burst in two.
    expect(kinds(result.segments)).toEqual(['burst', 'standalone', 'burst', 'text']);
  });

  test('a permission for ANOTHER session does not', () => {
    const base = toolBurstTurn();
    const result = computeTurnRowInputs({
      ...base,
      permissions: [
        { sessionID: 'ses_other', tool: { callID: 'call_t2' } } as unknown as PermissionRequest,
      ],
    });

    expect(kinds(result.segments)).toEqual(['burst', 'text']);
  });

  test('an aborted turn with a blank last text part still shows the earlier text', () => {
    const result = computeTurnRowInputs(abortedTurn());

    // Via the `completedTextParts` branch, not the aborted fallback — see below.
    expect(result.response).toBe('Started the work');
  });

  test('`abortedTextFallback` is unreachable, and stays that way', () => {
    // `findLastTextPart` returns the last text part whose text is non-BLANK, so
    // `responseRaw` is non-empty exactly when the fallback's loop would collect
    // anything — and the fallback only runs when `responseRaw` is empty. Every
    // shape below is an errored turn; none produces a non-empty fallback.
    const errored = (parts: Part[]) => {
      const base = abortedTurn();
      return computeTurnParts({
        ...base,
        turn: {
          ...base.turn,
          assistantMessages: [message('m1', parts, { error: { name: 'AbortedError' } })],
        },
      });
    };

    expect(errored([text('x1', '   ')]).abortedTextFallback).toBe('');
    expect(errored([text('x1', '')]).abortedTextFallback).toBe('');
    expect(errored([text('x1', 'Started the work')]).abortedTextFallback).toBe('');
    expect(errored([text('x1', 'Started'), text('x2', ' ')]).abortedTextFallback).toBe('');
    expect(errored([tool('t1', 'read')]).abortedTextFallback).toBe('');
  });
});

// ============================================================================
// The two-stage split — what keeps `segments` referentially stable
// ============================================================================

describe('computeTurnParts / computeTurnRowInputs split', () => {
  beforeEach(() => optimisticAnswersCache.clear());

  test('a supplied parts computation is passed through by identity', () => {
    const p = toolBurstTurn();
    const parts = computeTurnParts(p);
    const result = computeTurnRowInputs(p, parts);

    // This is what lets `useTurnModel` memoize the parts stage on its own,
    // narrower dependency set: a status tick must not mint a new `Segment[]`.
    expect(result.segments).toBe(parts.segments);
    expect(result.answeredQuestionPartsById).toBe(parts.answeredQuestionPartsById);
    expect(result.hasSteps).toBe(parts.hasSteps);
  });

  test('the same parts computation drives both working and idle status', () => {
    const p = toolBurstTurn();
    const parts = computeTurnParts(p);

    const idle = computeTurnRowInputs(p, parts);
    const live = computeTurnRowInputs(
      { ...p, isLastUserTurn: true, sessionStatus: busyStatus },
      parts,
    );

    expect(idle.working).toBe(false);
    expect(live.working).toBe(true);
    expect(live.segments).toBe(idle.segments);
  });

  test('omitting the parts argument computes them', () => {
    const p = toolBurstTurn();

    expect(kinds(computeTurnRowInputs(p).segments)).toEqual(['burst', 'text']);
  });
});
