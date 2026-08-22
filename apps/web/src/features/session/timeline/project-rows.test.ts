import { describe, expect, test } from 'bun:test';

import { groupMessagesIntoTurns, type MessageWithParts, type Part, type Turn } from '@/ui';

import { buildChatRows, groupRowsByTurn } from './build-chat-rows';
import {
  type AssistantPartRowProps,
  createProjectionCache,
  deriveAnsweredQuestionIds,
  deriveTurnView,
  projectTurnPlacements,
  type TurnPlacements,
  type TurnViewContext,
} from './project-rows';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type AnyPart = Record<string, unknown>;
const part = (messageID: string, id: string, rest: AnyPart): Part =>
  ({ id, messageID, sessionID: 'ses', ...rest }) as unknown as Part;
const text = (m: string, id: string, body: string) => part(m, id, { type: 'text', text: body });
const reasoning = (m: string, id: string, body: string) =>
  part(m, id, { type: 'reasoning', text: body });
const tool = (m: string, id: string, name: string, state: AnyPart = { status: 'completed' }) =>
  part(m, id, { type: 'tool', tool: name, callID: `call_${id}`, state });
const question = (m: string, id: string) =>
  tool(m, id, 'question', {
    status: 'completed',
    input: { questions: [{ question: 'Colour?' }] },
    metadata: { answers: [['Blue']] },
    output: 'User has answered your questions: "Colour?"="Blue".',
  });

let t = 1000;
const user = (id: string, parts?: Part[]): MessageWithParts =>
  ({
    info: { id, role: 'user', time: { created: (t += 10) } },
    parts: parts ?? [text(id, `${id}t`, 'prompt')],
  }) as unknown as MessageWithParts;
const assistant = (
  id: string,
  parentID: string,
  parts: Part[],
  info: AnyPart = {},
): MessageWithParts =>
  ({
    info: {
      id,
      role: 'assistant',
      parentID,
      time: { created: (t += 10), completed: t + 5 },
      ...info,
    },
    parts,
  }) as unknown as MessageWithParts;

const orphan = (id: string, parts: Part[], info: AnyPart = {}): MessageWithParts =>
  ({
    info: { id, role: 'assistant', time: { created: (t += 10), completed: t + 5 }, ...info },
    parts,
  }) as unknown as MessageWithParts;
/** An assistant message still streaming: no `time.completed`. (`time.created`
 *  stays on the fixture clock — a stamp below the prompt's would sort the
 *  message AHEAD of its prompt in display order.) */
const streaming = (
  id: string,
  parentID: string,
  parts: Part[],
  info: AnyPart = {},
): MessageWithParts => assistant(id, parentID, parts, { time: { created: (t += 10) }, ...info });
const USER_ABORT = {
  name: 'AbortError',
  data: { message: 'The operation was aborted.', reason: 'user' },
};

const noopReply = async () => {};
const ctx = (overrides: Partial<TurnViewContext> = {}): TurnViewContext => ({
  sessionId: 'ses',
  questions: [],
  working: false,
  commandMessages: undefined,
  commands: undefined,
  pricingLookup: () => null,
  ...overrides,
});

function project(
  messages: MessageWithParts[],
  viewCtx: Partial<TurnViewContext> = {},
  cache = createProjectionCache(),
): { turn: Turn; placements: TurnPlacements; view: ReturnType<typeof deriveTurnView> } {
  const turns = groupMessagesIntoTurns(messages);
  const turn = turns[0];
  const c = ctx(viewCtx);
  const answered = deriveAnsweredQuestionIds(turns, c.questions, c.sessionId);
  const rows = buildChatRows({
    messages,
    activeUserMessageID: turn.userMessage.info.id,
    status: c.working ? 'busy' : 'idle',
    standaloneCallIds: new Set(),
    answeredQuestionIds: answered,
    prev: undefined,
  });
  const group = groupRowsByTurn(rows)[0];
  const view = deriveTurnView(turn, c);
  const placements = projectTurnPlacements(
    group,
    turn,
    view,
    {
      sessionId: 'ses',
      disableNavigation: false,
      density: 'normal',
      permissions: [],
      onPermissionReply: noopReply,
    },
    cache,
  );
  return { turn, placements, view };
}

const ids = (p: AssistantPartRowProps) => p.parts.map((x) => x.id);

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

describe('role projection', () => {
  test('shell-only: the shell part alone, nothing in steps or body', () => {
    const { placements } = project([
      user('u', [part('u', 'ut', { type: 'text', text: '!ls', synthetic: true })]),
      assistant('a', 'u', [tool('a', 'b', 'bash')]),
    ]);
    expect(placements.shell?.role).toBe('shell-only');
    expect(placements.shell && ids(placements.shell)).toEqual(['b']);
    expect(placements.steps).toEqual([]);
    expect(placements.body).toEqual([]);
  });

  test('burst + standalone + text-step in steps mode, in part order, trailing marked', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [
        tool('a', 'p1', 'read'),
        tool('a', 'p2', 'bash'),
        tool('a', 'p3', 'show_user', { status: 'completed', input: { path: '/x.png' } }),
        text('a', 'p4', 'Here it is'),
        tool('a', 'p5', 'grep'),
      ]),
    ]);
    expect(view.hasSteps).toBe(true);
    expect(view.showStepsBlock).toBe(true);
    expect(placements.steps.map((p) => p.role)).toEqual([
      'burst',
      'standalone',
      'text-step',
      'burst',
    ]);
    expect(placements.steps.map(ids)).toEqual([['p1', 'p2'], ['p3'], ['p4'], ['p5']]);
    expect(placements.steps.map((p) => p.isTrailing)).toEqual([false, false, false, true]);
    expect(placements.steps[2].text).toBe('Here it is');
    expect(placements.body).toEqual([]);
  });

  test('isTrailing counts text segments even though steps mode is off', () => {
    // Response mode with a reasoning burst followed by prose: today's
    // `segments` are [burst, text], so the burst is NOT trailing.
    const { placements } = project([
      user('u'),
      assistant('a', 'u', [reasoning('a', 'r', 'hmm'), text('a', 'p', 'answer')]),
    ]);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(placements.steps[0].isTrailing).toBe(false);
  });

  test('response: ONLY the last text row carries the joined completed text', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [text('a', 'p1', 'first  '), text('a', 'p2', 'second')]),
    ]);
    expect(view.hasSteps).toBe(false);
    expect(view.showStepsBlock).toBe(false);
    expect(placements.steps).toEqual([]);
    expect(placements.body.map((p) => p.role)).toEqual(['response']);
    expect(ids(placements.body[0])).toEqual(['p2']);
    expect(placements.body[0].text).toBe('first\n\nsecond');
    expect(placements.body[0].text).toBe(view.response);
    expect(placements.body[0].isStreaming).toBe(false);
  });

  test('response while working streams the active message text', () => {
    const { placements, view } = project(
      [user('u'), assistant('a', 'u', [text('a', 'p1', 'stream')], { time: { created: 5 } })],
      { working: true },
    );
    expect(view.working).toBe(true);
    expect(placements.body.map((p) => p.role)).toEqual(['response']);
    expect(placements.body[0].isStreaming).toBe(true);
    expect(placements.body[0].text).toBe('stream');
  });

  test('inline: text and answered questions in part order, the reasoning burst in steps', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [
        reasoning('a', 'r', 'hmm'),
        question('a', 'q'),
        text('a', 'p1', 'Blue it is.'),
        text('a', 'p2', 'Anything else?'),
      ]),
    ]);
    expect(view.shouldUseInlineContent).toBe(true);
    // hasReasoning → the steps block shows the reasoning burst WITHOUT the question.
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(ids(placements.steps[0])).toEqual(['r']);
    expect(placements.body.map((p) => p.role)).toEqual([
      'inline-questions',
      'inline-text',
      'inline-text',
    ]);
    expect(ids(placements.body[0])).toEqual(['q']);
    expect(placements.body[1].text).toBe('Blue it is.');
    expect(placements.body[2].text).toBe('Anything else?');
    // Not working: nothing streams.
    expect(placements.body.every((p) => !p.isStreaming)).toBe(true);
  });

  test('inline while working: only the LAST text item streams', () => {
    const { placements } = project(
      [
        user('u'),
        assistant(
          'a',
          'u',
          [question('a', 'q'), text('a', 'p1', 'one '), text('a', 'p2', 'two ')],
          {
            time: { created: 5 },
          },
        ),
      ],
      { working: true },
    );
    const texts = placements.body.filter((p) => p.role === 'inline-text');
    expect(texts.map((p) => p.isStreaming)).toEqual([false, true]);
    // Streaming text is untrimmed; settled text is trimmed — as today.
    expect(texts.map((p) => p.text)).toEqual(['one', 'two ']);
  });

  test('an answered question rides INSIDE its burst in steps mode', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [tool('a', 'p1', 'read'), question('a', 'q'), tool('a', 'p2', 'bash')]),
    ]);
    expect(view.shouldUseInlineContent).toBe(false);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(ids(placements.steps[0])).toEqual(['p1', 'q', 'p2']);
    // The answered card's part is the SUBSTITUTED one (answers present).
    const q = placements.steps[0].parts[1] as unknown as {
      state: { metadata?: { answers?: string[][] } };
    };
    expect(q.state.metadata?.answers).toEqual([['Blue']]);
    expect(placements.body).toEqual([]);
  });

  test('hidden: a compaction card turn projects no placements', () => {
    const { placements, view } = project([
      user('u'),
      assistant(
        'a',
        'u',
        [part('a', 'c', { type: 'compaction' }), text('a', 'p', 'Summary of all of it')],
        { summary: true },
      ),
    ]);
    expect(view.hasCompaction).toBe(true);
    expect(view.isCompactionCard).toBe(true);
    expect(placements.shell).toBeNull();
    expect(placements.steps).toEqual([]);
    expect(placements.body).toEqual([]);
  });

  test('the steps-block gate folds working / hasSteps / hasReasoning and a non-empty reply', () => {
    const bare = project([user('u')]);
    expect(bare.view.showStepsBlock).toBe(false);
    const working = project([user('u'), assistant('a', 'u', [], { time: { created: 5 } })], {
      working: true,
    });
    expect(working.view.showStepsBlock).toBe(true);
    const plain = project([user('u'), assistant('a', 'u', [text('a', 'p', 'hi')])]);
    expect(plain.view.showStepsBlock).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('projection identity', () => {
  test('mutating ONE part object changes exactly one props object', () => {
    const cache = createProjectionCache();
    const messages = [
      user('u'),
      assistant('a', 'u', [
        tool('a', 'p1', 'read'),
        text('a', 'p2', 'first'),
        tool('a', 'p3', 'bash'),
        tool('a', 'p4', 'grep'),
        text('a', 'p5', 'second'),
      ]),
    ];
    const before = project(messages, {}, cache);
    const all = (p: TurnPlacements) => [...p.steps, ...p.body];
    expect(all(before.placements).length).toBe(4);

    // A delta to `p4`: the bucket array is copied, p4 is replaced, the rest kept.
    const next = messages.map((m, i) =>
      i === 1
        ? ({
            ...m,
            parts: m.parts.map((p) => (p.id === 'p4' ? { ...p } : p)),
          } as MessageWithParts)
        : m,
    );
    const after = project(next, {}, cache);
    const a = all(before.placements);
    const b = all(after.placements);
    expect(b.length).toBe(a.length);
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      if (Object.is(a[i], b[i])) continue;
      changed += 1;
      expect(b[i].parts.some((p) => p.id === 'p4')).toBe(true);
    }
    expect(changed).toBe(1);
  });

  test('an unchanged turn re-projects to the SAME props objects', () => {
    const cache = createProjectionCache();
    const messages = [
      user('u'),
      assistant('a', 'u', [tool('a', 'p1', 'read'), text('a', 'p2', 'x')]),
    ];
    const one = project(messages, {}, cache);
    const two = project(messages, {}, cache);
    expect(one.placements.steps.length).toBe(2);
    for (let i = 0; i < one.placements.steps.length; i++) {
      expect(Object.is(one.placements.steps[i], two.placements.steps[i])).toBe(true);
    }
  });

  test('deriveTurnView is cached on the turn object for an equal context', () => {
    const messages = [user('u'), assistant('a', 'u', [text('a', 'p', 'x')])];
    const turn = groupMessagesIntoTurns(messages)[0];
    const c = ctx();
    expect(Object.is(deriveTurnView(turn, c), deriveTurnView(turn, { ...c }))).toBe(true);
    expect(Object.is(deriveTurnView(turn, c), deriveTurnView(turn, { ...c, working: true }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// bursts across non-rendering rows (F1 / F2)
// ---------------------------------------------------------------------------

describe('a burst spans the rows the host does not render', () => {
  test('F1: the interrupted divider does not split a burst (abort on step 2, reasoning head)', () => {
    // OpenCode: one assistant message per step, the abort on the last one.
    const { placements, view } = project([
      user('u'),
      assistant('s1', 'u', [tool('s1', 'p1', 'read'), tool('s1', 'p2', 'grep')]),
      streaming('s2', 'u', [reasoning('s2', 'p3', 'edit it'), tool('s2', 'p4', 'bash')], {
        error: USER_ABORT,
      }),
    ]);
    expect(view.turnErrorIsAbort).toBe(true);
    // `segmentTurn` over the turn's parts: ONE burst of four.
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(ids(placements.steps[0])).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(placements.steps[0].isTrailing).toBe(true);
    // The merged placement keeps the FIRST row's key.
    expect(placements.steps[0].key).toBe('assistant-part:u:context:s1:p1');
  });

  test('F1: three steps, abort on the third — one closed burst of three', () => {
    const { placements } = project([
      user('u'),
      assistant('s1', 'u', [tool('s1', 'p1', 'read')]),
      assistant('s2', 'u', [tool('s2', 'p2', 'read')]),
      streaming('s3', 'u', [tool('s3', 'p3', 'read')], { error: USER_ABORT }),
    ]);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(ids(placements.steps[0])).toEqual(['p1', 'p2', 'p3']);
  });

  test('F1: a text head on the aborted step still closes the burst (as segmentTurn does)', () => {
    const { placements } = project([
      user('u'),
      assistant('s1', 'u', [tool('s1', 'p1', 'read')]),
      streaming('s2', 'u', [text('s2', 'p2', 'Now I will'), tool('s2', 'p3', 'bash')], {
        error: USER_ABORT,
      }),
    ]);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst', 'text-step', 'burst']);
    expect(placements.steps.map(ids)).toEqual([['p1'], ['p2'], ['p3']]);
  });

  test('F2: the orphan preamble error does not split a burst', () => {
    const { placements } = project([
      orphan('pre', [tool('pre', 'p0', 'read')], {
        error: { name: 'APIError', data: { message: 'init failed' } },
      }),
      user('u'),
      assistant('a', 'u', [
        tool('a', 'p1', 'read'),
        tool('a', 'p2', 'bash'),
        text('a', 'p3', 'done'),
      ]),
    ]);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst', 'text-step']);
    expect(ids(placements.steps[0])).toEqual(['p0', 'p1', 'p2']);
  });
});

// ---------------------------------------------------------------------------
// assistant-only turn (F3)
// ---------------------------------------------------------------------------

describe('an assistant-only turn renders its head message as assistant content', () => {
  test('text only: the response block on the head text', () => {
    const { placements, view } = project([
      orphan('o', [text('o', 'p', 'Session init: I am here.')]),
    ]);
    expect(view.hasVisibleUserContent).toBe(false);
    expect(view.response).toBe('Session init: I am here.');
    expect(placements.steps).toEqual([]);
    expect(placements.body.map((p) => p.role)).toEqual(['response']);
    expect(ids(placements.body[0])).toEqual(['p']);
    expect(placements.body[0].text).toBe('Session init: I am here.');
  });

  test('error, no parts: the error text is the turn error', () => {
    const { placements, view } = project([
      orphan('o', [], { error: { name: 'APIError', data: { message: 'init exploded' } } }),
    ]);
    expect(view.turnError).toBe('init exploded');
    expect(view.turnErrorIsAbort).toBe(false);
    expect(placements.steps).toEqual([]);
    expect(placements.body).toEqual([]);
  });

  test('head holding only a tool, second orphan aborted: both tools are ONE burst', () => {
    const { placements, view } = project([
      orphan('o', [tool('o', 'p0', 'read')]),
      orphan('o2', [tool('o2', 'p1', 'read')], { error: USER_ABORT }),
    ]);
    expect(view.hasSteps).toBe(true);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect(ids(placements.steps[0])).toEqual(['p0', 'p1']);
    expect(placements.body).toEqual([]);
  });

  test('head plus a second orphan with tools: the head text is the first text step', () => {
    const { placements, view } = project([
      orphan('o', [text('o', 'p1', 'first orphan')]),
      orphan('o2', [tool('o2', 'p2', 'read'), text('o2', 'p3', 'second orphan prose')]),
    ]);
    expect(view.hasSteps).toBe(true);
    expect(placements.steps.map((p) => p.role)).toEqual(['text-step', 'burst', 'text-step']);
    expect(placements.steps.map(ids)).toEqual([['p1'], ['p2'], ['p3']]);
    expect(placements.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// part refs without a usable id (F5 / F6)
// ---------------------------------------------------------------------------

describe('resolving refs without a usable part id', () => {
  test('F5: an EMPTY part id resolves by position — the tool and the text render', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [
        part('a', '', {
          type: 'tool',
          tool: 'read',
          callID: 'call_x',
          state: { status: 'completed' },
        }),
        part('a', '', { type: 'text', text: 'no id text' }),
      ]),
    ]);
    expect(view.hasSteps).toBe(true);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst', 'text-step']);
    expect(placements.steps[0].parts[0]).toBe(view.allParts[0].part);
    expect(placements.steps[1].parts[0]).toBe(view.allParts[1].part);
    expect(placements.steps[1].text).toBe('no id text');
  });

  test('F5: an EMPTY text id resolves by position in response mode', () => {
    const { placements } = project([
      user('u'),
      assistant('a', 'u', [part('a', '', { type: 'text', text: 'no id text' })]),
    ]);
    expect(placements.body.map((p) => p.role)).toEqual(['response']);
    expect(placements.body[0].text).toBe('no id text');
  });

  test('F6: DUPLICATE part ids — the first ref is the first part, the second the second', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [
        text('a', 'DUP', 'first text'),
        tool('a', 'DUP', 'read'),
        text('a', 'p3', 'final'),
      ]),
    ]);
    expect(view.hasSteps).toBe(true);
    expect(placements.steps.map((p) => p.role)).toEqual(['text-step', 'burst', 'text-step']);
    expect(placements.steps[0].text).toBe('first text');
    expect(placements.steps[0].parts[0]).toBe(view.allParts[0].part);
    expect(placements.steps[1].parts[0]).toBe(view.allParts[1].part);
    expect(placements.steps[2].text).toBe('final');
  });

  test('F6: a duplicate id whose first holder is NOT renderable skips to the renderable one', () => {
    // A `step-start` bookkeeping part sharing its id with the tool after it.
    const { placements } = project([
      user('u'),
      assistant('a', 'u', [part('a', 'DUP', { type: 'step-start' }), tool('a', 'DUP', 'read')]),
    ]);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    expect((placements.steps[0].parts[0] as { type: string }).type).toBe('tool');
  });
});

// ---------------------------------------------------------------------------
// a part that SHARES its id with an answered question
// ---------------------------------------------------------------------------

describe('only a question part takes the answered substitute', () => {
  const answers = (p: Part) =>
    (p as unknown as { state: { metadata?: { answers?: string[][] } } }).state.metadata?.answers;
  const toolName = (p: Part) => (p as unknown as { tool?: string }).tool;
  const bashRunning = (m: string, id: string) =>
    tool(m, id, 'bash', { status: 'running', time: { start: 1 }, input: { command: 'ls' } });

  test('W7c: question then a read sharing its id, working — the read stays a read', () => {
    const { placements, view } = project(
      [
        user('u'),
        streaming('a', 'u', [
          question('a', 'QDUPW'),
          tool('a', 'QDUPW', 'read'),
          bashRunning('a', 'b'),
        ]),
      ],
      { working: true },
    );
    expect(view.shouldUseInlineContent).toBe(false);
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    const parts = placements.steps[0].parts;
    expect(parts.map(toolName)).toEqual(['question', 'read', 'bash']);
    // The question is the ANSWERED substitute; the read is the store part itself.
    expect(answers(parts[0])).toEqual([['Blue']]);
    expect(parts[1]).toBe(view.allParts[1].part);
  });

  test('W30: a read then a question sharing its id, working — the read stays a read', () => {
    const { placements, view } = project(
      [
        user('u'),
        streaming('a', 'u', [
          tool('a', 'QDUPY', 'read'),
          question('a', 'QDUPY'),
          bashRunning('a', 'b'),
        ]),
      ],
      { working: true },
    );
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    const parts = placements.steps[0].parts;
    expect(parts.map(toolName)).toEqual(['read', 'question', 'bash']);
    expect(parts[0]).toBe(view.allParts[0].part);
    expect(answers(parts[1])).toEqual([['Blue']]);
  });

  test('W7b: the question and the read share an id ACROSS messages — the read stays a read', () => {
    const { placements, view } = project(
      [
        user('u'),
        assistant('a', 'u', [question('a', 'QDUPX')]),
        streaming('b', 'u', [tool('b', 'QDUPX', 'read'), bashRunning('b', 'bb')]),
      ],
      { working: true },
    );
    expect(placements.steps.map((p) => p.role)).toEqual(['burst']);
    const parts = placements.steps[0].parts;
    expect(parts.map(toolName)).toEqual(['question', 'read', 'bash']);
    expect(answers(parts[0])).toEqual([['Blue']]);
    expect(parts[1]).toBe(view.allParts[1].part);
  });

  test('V24: inline — a text sharing the answered question id still renders as text', () => {
    const { placements, view } = project([
      user('u'),
      assistant('a', 'u', [
        text('a', 'p1', 'Q time'),
        question('a', 'IDUP'),
        text('a', 'IDUP', 'after the answer'),
      ]),
    ]);
    expect(view.shouldUseInlineContent).toBe(true);
    expect(placements.body.map((p) => p.role)).toEqual([
      'inline-text',
      'inline-questions',
      'inline-text',
    ]);
    expect(placements.body[0].text).toBe('Q time');
    expect(ids(placements.body[1])).toEqual(['IDUP']);
    expect(answers(placements.body[1].parts[0])).toEqual([['Blue']]);
    expect(placements.body[2].text).toBe('after the answer');
    expect(placements.body[2].parts[0]).toBe(view.allParts[2].part);
  });
});
