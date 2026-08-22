/**
 * The fixture transcript behind the timeline golden.
 *
 * Two broad scenarios, each a flat `messages` array in wire order plus the
 * host facts `SessionChat` derives around it (`workingTurnId`,
 * `pendingTurnIds`, `interruptedTurnIds`, `commandMessages`, the inbox rows),
 * and a list of one-turn EDGE scenarios (`edgeScenarios`). Every render
 * branch of the legacy turn card is exercised by at least one turn; the
 * golden proves nothing for a branch this file does not reach, so a branch
 * added to the card gets a turn added here.
 *
 *   idle     — a settled session: shell mode, plain reply, reasoning + reply,
 *              a tool burst split by prose (with hidden / dropped / invisible
 *              parts inside it), a standalone `show_user`, an answered question
 *              rendered inline, an answered question with no prose (fallback
 *              cards), a slash command with output, a turn that failed with
 *              `info.error`, a compaction turn (divider + card), an aborted
 *              turn, and two prompts stranded behind the abort
 *              (`interruptedBeforeRun`).
 *   working  — a settled reply, a turn mid-stream (busy footer), and two
 *              queued prompts painted as dimmed, stacked bubbles — one without
 *              an inbox row (ordinal id), one with (remove / send-now actions).
 */
import type { MessageWithParts, Part, SessionStatus } from '@/ui';
import type { SessionPrompt } from '@kortix/sdk';

export const FIXTURE_SESSION_ID = 'ses_fixture';

let clock = Date.UTC(2026, 7, 12, 9, 0, 0);
const tick = (): number => (clock += 1000);

type AnyPart = Record<string, unknown>;

function part(messageID: string, id: string, rest: AnyPart): Part {
  return { id, messageID, sessionID: FIXTURE_SESSION_ID, ...rest } as unknown as Part;
}

const text = (messageID: string, id: string, body: string, extra: AnyPart = {}) =>
  part(messageID, id, { type: 'text', text: body, ...extra });
const reasoning = (messageID: string, id: string, body: string) =>
  part(messageID, id, { type: 'reasoning', text: body });
const tool = (messageID: string, id: string, name: string, state: AnyPart, extra: AnyPart = {}) =>
  part(messageID, id, {
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state,
    ...extra,
  });
const bookkeeping = (messageID: string, id: string, type: string) => part(messageID, id, { type });

const done = (start: number) => ({ status: 'completed', time: { start, end: start + 40 } });

function user(id: string, parts: (messageID: string) => Part[]): MessageWithParts {
  return {
    info: { id, sessionID: FIXTURE_SESSION_ID, role: 'user', time: { created: tick() } },
    parts: parts(id),
  } as unknown as MessageWithParts;
}

function assistant(
  id: string,
  parentID: string,
  parts: (messageID: string) => Part[],
  info: AnyPart = {},
): MessageWithParts {
  const created = tick();
  return {
    info: {
      id,
      sessionID: FIXTURE_SESSION_ID,
      role: 'assistant',
      parentID,
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      time: { created, completed: created + 5000 },
      ...info,
    },
    parts: parts(id),
  } as unknown as MessageWithParts;
}

const answeredQuestion = (messageID: string, id: string) =>
  tool(messageID, id, 'question', {
    ...done(10),
    input: {
      questions: [{ question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }],
    },
    metadata: { answers: [['Blue']] },
    output: 'User has answered your questions: "Which colour?"="Blue". You can now continue.',
  });

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------

export const idleMessages: MessageWithParts[] = [
  // T0 — shell mode: all-synthetic prompt + exactly one bash tool part.
  user('u0', (m) => [text(m, 'u0t', '!ls', { synthetic: true })]),
  assistant('a0', 'u0', (m) => [
    tool(m, 'a0b', 'bash', {
      ...done(1),
      input: { command: 'ls', description: 'List files' },
      output: 'README.md\npackage.json',
      title: 'ls',
    }),
  ]),

  // T1 — plain reply, no steps, no reasoning: the response block alone.
  user('u1', (m) => [text(m, 'u1t', 'Hello there')]),
  assistant('a1', 'u1', (m) => [
    bookkeeping(m, 'a1s', 'step-start'),
    text(m, 'a1t', 'Hi! How can I help you today?'),
    bookkeeping(m, 'a1f', 'step-finish'),
  ]),

  // T2 — reasoning then prose: steps block (thought chain) + response block.
  user('u2', (m) => [text(m, 'u2t', 'Think about it')]),
  assistant('a2', 'u2', (m) => [
    reasoning(m, 'a2r', 'Let me weigh the options here.'),
    text(m, 'a2t', 'Thought it through: go with the second option.'),
  ]),

  // T3 — a tool burst split by prose. Carries a snapshot, a patch, a hidden
  //      `todoread` (stays in the burst — ActivityBurst does not filter it), a
  //      `todowrite` (dropped — the plan card owns it) and two text steps.
  user('u3', (m) => [text(m, 'u3t', 'Read the files and grep')]),
  assistant('a3', 'u3', (m) => [
    bookkeeping(m, 'a3snap', 'snapshot'),
    tool(m, 'a3read', 'read', {
      ...done(1),
      input: { filePath: '/workspace/README.md' },
      output: '# Readme',
      title: 'README.md',
    }),
    tool(m, 'a3todoread', 'todoread', { ...done(2), input: {}, output: '[]' }),
    tool(m, 'a3bash', 'bash', {
      ...done(3),
      input: { command: 'wc -l README.md', description: 'Count lines' },
      output: '12 README.md',
      title: 'wc -l',
    }),
    bookkeeping(m, 'a3patch', 'patch'),
    text(m, 'a3t1', 'Found the readme, now searching.'),
    tool(m, 'a3grep', 'grep', {
      ...done(4),
      input: { pattern: 'TODO', path: '/workspace' },
      output: 'src/a.ts:1:TODO',
      title: 'TODO',
    }),
    tool(m, 'a3todo', 'todowrite', {
      ...done(5),
      input: { todos: [{ content: 'Ship', status: 'pending', priority: 'high' }] },
      output: 'ok',
    }),
    text(m, 'a3t2', 'Done. One TODO left in `src/a.ts`.'),
  ]),

  // T4 — standalone `show_user` between a burst and prose.
  user('u4', (m) => [text(m, 'u4t', 'Show me the chart')]),
  assistant('a4', 'u4', (m) => [
    tool(m, 'a4bash', 'bash', {
      ...done(1),
      input: { command: 'python plot.py', description: 'Render chart' },
      output: 'wrote chart.png',
      title: 'python plot.py',
    }),
    tool(m, 'a4show', 'show_user', {
      ...done(2),
      input: { path: '/workspace/chart.png', title: 'Chart' },
      output: 'shown',
    }),
    text(m, 'a4t', 'Here is the chart.'),
  ]),

  // T5 — answered question + prose: inline content mode.
  user('u5', (m) => [text(m, 'u5t', 'Ask me something')]),
  assistant('a5', 'u5', (m) => [answeredQuestion(m, 'a5q'), text(m, 'a5t', 'Blue it is.')]),

  // T6 — answered question with no prose: the fallback card list.
  user('u6', (m) => [text(m, 'u6t', 'Ask only')]),
  assistant('a6', 'u6', (m) => [answeredQuestion(m, 'a6q')]),

  // T7 — a slash command with output: the command pill + expandable output.
  user('u7', (m) => [text(m, 'u7t', '/compact')]),
  assistant('a7', 'u7', (m) => [
    text(m, 'a7t', 'Compacted 12 messages into a summary.\n\nNothing else to report.'),
  ]),

  // T8 — a failed reply (`info.error`, not an abort).
  user('u8', (m) => [text(m, 'u8t', 'Fail please')]),
  assistant('a8', 'u8', (m) => [text(m, 'a8t', 'Starting, but')], {
    error: { name: 'APIError', data: { message: 'Provider exploded' } },
  }),

  // T9 — a compaction turn: `info.summary === true` + a `compaction` part.
  user('u9', (m) => [text(m, 'u9t', 'continue')]),
  assistant(
    'a9',
    'u9',
    (m) => [
      bookkeeping(m, 'a9c', 'compaction'),
      text(m, 'a9t', 'Summary: the user asked for files, charts and a colour.'),
    ],
    { summary: true },
  ),

  // T10 — aborted by the user: the muted "Interrupted" note.
  user('u10', (m) => [text(m, 'u10t', 'Stop me')]),
  assistant('a10', 'u10', (m) => [text(m, 'a10t', 'I was about to say')], {
    error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
  }),

  // T11 / T12 — stranded behind the abort: nothing under them, session idle.
  user('u11', (m) => [text(m, 'u11t', 'After the stop, one')]),
  user('u12', (m) => [text(m, 'u12t', 'After the stop, two')]),
];

export const idleCommandMessages = new Map<string, { name: string; args?: string }>([
  ['u7', { name: 'compact' }],
]);

// ---------------------------------------------------------------------------
// working
// ---------------------------------------------------------------------------

const workingBase: MessageWithParts[] = [
  user('w1', (m) => [text(m, 'w1t', 'Settled turn')]),
  assistant('wa1', 'w1', (m) => [text(m, 'wa1t', 'All settled.')]),
  user('wW', (m) => [text(m, 'wWt', 'Build the thing')]),
  {
    info: {
      id: 'waW',
      sessionID: FIXTURE_SESSION_ID,
      role: 'assistant',
      parentID: 'wW',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      time: { created: tick() },
    },
    parts: [
      tool('waW', 'waWbash', 'bash', {
        status: 'running',
        time: { start: 1 },
        input: { command: 'pnpm build', description: 'Build' },
      }),
    ],
  } as unknown as MessageWithParts,
];

/** Inbox rows behind the two queued bubbles. `p1` carries no `message_id`, so
 *  its bubble is named by the ordinal `queued-p1` and has NO row in
 *  `inboxRowsByMessageId`; `p2` names `msg_q2` and has one. */
export const workingPrompts: SessionPrompt[] = [
  {
    prompt_id: 'p1',
    client_message_id: 'c1',
    message_id: '',
    state: 'queued',
    reason: null,
    text: 'Then lint it',
    client_sent_at_ms: null,
    attempts: 0,
    last_error: null,
    created_at: '2026-08-12T09:30:00.000Z',
    available_at: '2026-08-12T09:30:00.000Z',
  } as SessionPrompt,
  {
    prompt_id: 'p2',
    client_message_id: 'c2',
    message_id: 'msg_q2',
    state: 'queued',
    reason: null,
    text: 'And then ship it',
    client_sent_at_ms: null,
    attempts: 0,
    last_error: null,
    created_at: '2026-08-12T09:30:01.000Z',
    available_at: '2026-08-12T09:30:01.000Z',
  } as SessionPrompt,
];

/** The exact shape `SessionChat.queuedSyntheticMessages` builds — ids are
 *  `prompt.message_id || 'queued-<prompt_id>'`, the part id `'syn-<prompt_id>'`. */
export function queuedSyntheticMessages(
  prompts: SessionPrompt[],
  floor: number,
): MessageWithParts[] {
  let previous = floor;
  return prompts.map((prompt) => {
    const id = prompt.message_id || `queued-${prompt.prompt_id}`;
    const createdMs = Math.max(Date.parse(prompt.created_at), previous + 1);
    previous = createdMs;
    return {
      info: { id, sessionID: FIXTURE_SESSION_ID, role: 'user', time: { created: createdMs } },
      parts: [
        {
          id: `syn-${prompt.prompt_id}`,
          messageID: id,
          sessionID: FIXTURE_SESSION_ID,
          type: 'text',
          text: prompt.text,
        },
      ],
    } as unknown as MessageWithParts;
  });
}

const workingFloor = Math.max(
  ...workingBase.map((m) => (m.info as { time?: { created?: number } }).time?.created ?? 0),
);
export const workingMessages: MessageWithParts[] = [
  ...workingBase,
  ...queuedSyntheticMessages(workingPrompts, workingFloor),
];

export const workingInboxRowsByMessageId = new Map<string, SessionPrompt>([
  ['msg_q2', workingPrompts[1]],
]);

// ---------------------------------------------------------------------------
// edge scenarios — one turn each
// ---------------------------------------------------------------------------

const USER_ABORT = {
  name: 'AbortError',
  data: { message: 'The operation was aborted.', reason: 'user' },
};

/** An assistant message still streaming (no `time.completed`). */
function streamingAssistant(
  id: string,
  parentID: string | undefined,
  parts: (messageID: string) => Part[],
  info: AnyPart = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: FIXTURE_SESSION_ID,
      role: 'assistant',
      ...(parentID ? { parentID } : {}),
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      time: { created: tick() },
      ...info,
    },
    parts: parts(id),
  } as unknown as MessageWithParts;
}

/** An orphan assistant message: no `parentID`, precedes every prompt. */
function orphanAssistant(
  id: string,
  parts: (messageID: string) => Part[],
  info: AnyPart = {},
): MessageWithParts {
  const created = tick();
  return {
    info: {
      id,
      sessionID: FIXTURE_SESSION_ID,
      role: 'assistant',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      time: { created, completed: created + 5000 },
      ...info,
    },
    parts: parts(id),
  } as unknown as MessageWithParts;
}

const readTool = (messageID: string, id: string) =>
  tool(messageID, id, 'read', {
    ...done(1),
    input: { filePath: '/workspace/a.ts' },
    output: 'export {}',
    title: 'a.ts',
  });
const bashTool = (messageID: string, id: string, running = false) =>
  tool(
    messageID,
    id,
    'bash',
    running
      ? { status: 'running', time: { start: 1 }, input: { command: 'ls', description: 'List' } }
      : { ...done(2), input: { command: 'ls', description: 'List' }, output: 'a.ts', title: 'ls' },
  );

const idle = (name: string, messages: MessageWithParts[]): TimelineScenario => ({
  name,
  messages,
  sessionStatus: { type: 'idle' } as SessionStatus,
  lastTurnWorking: false,
  rewindDisabled: false,
  commandMessages: new Map(),
  inboxRowsByMessageId: new Map(),
});
const busy = (name: string, messages: MessageWithParts[]): TimelineScenario => ({
  name,
  messages,
  sessionStatus: { type: 'busy' } as SessionStatus,
  lastTurnWorking: true,
  rewindDisabled: true,
  commandMessages: new Map(),
  inboxRowsByMessageId: new Map(),
});

/**
 * One turn per scenario. The first group reproduces the legacy card byte for
 * byte (the golden is the legacy render); the second group is the INTENDED
 * divergences, whose golden is the new render — each is listed with its
 * rationale in `build-chat-rows.test.ts` ("intended divergences").
 */
export const edgeScenarios: TimelineScenario[] = [
  // ── identical to legacy ──────────────────────────────────────────────────

  // OpenCode writes ONE assistant message PER STEP and a Stop lands the abort
  // on the LAST one. Step 1 ends in tool calls; step 2 opens with reasoning
  // then a running tool. The SDK flushes the group at the interrupted divider
  // (upstream semantics); the host merges the two context rows back into the
  // one burst `segmentTurn` always produced ("Completed 4 steps", not 2 + 2).
  idle('abort-step2-reasoning-head', [
    user('ue1', (m) => [text(m, 'ue1t', 'Find all TODOs and fix them')]),
    assistant('ae1s1', 'ue1', (m) => [
      bookkeeping(m, 'ae1s1ss', 'step-start'),
      text(m, 'ae1s1t', 'Let me look.'),
      readTool(m, 'ae1s1r'),
      tool(m, 'ae1s1g', 'grep', {
        ...done(4),
        input: { pattern: 'TODO', path: '/workspace' },
        output: 'a.ts:1:TODO',
        title: 'TODO',
      }),
      bookkeeping(m, 'ae1s1sf', 'step-finish'),
    ]),
    streamingAssistant(
      'ae1s2',
      'ue1',
      (m) => [
        bookkeeping(m, 'ae1s2ss', 'step-start'),
        reasoning(m, 'ae1s2r', 'I should edit a.ts'),
        bashTool(m, 'ae1s2b', true),
      ],
      { error: USER_ABORT },
    ),
  ]),

  // Three steps, all tools, abort on the third: ONE closed "Completed 3 steps"
  // burst, not a closed 2-step burst plus a separate open trailing one.
  idle('abort-step3-of-three', [
    user('ue2', (m) => [text(m, 'ue2t', 'go')]),
    assistant('ae2s1', 'ue2', (m) => [
      bookkeeping(m, 'ae2s1ss', 'step-start'),
      readTool(m, 'ae2s1r'),
      bookkeeping(m, 'ae2s1sf', 'step-finish'),
    ]),
    assistant('ae2s2', 'ue2', (m) => [
      bookkeeping(m, 'ae2s2ss', 'step-start'),
      readTool(m, 'ae2s2r'),
      bookkeeping(m, 'ae2s2sf', 'step-finish'),
    ]),
    streamingAssistant(
      'ae2s3',
      'ue2',
      (m) => [bookkeeping(m, 'ae2s3ss', 'step-start'), readTool(m, 'ae2s3r')],
      { error: USER_ABORT },
    ),
  ]),

  // An orphan preamble that FAILED with tool parts, then a prompt whose reply
  // opens with tools. The SDK emits the preamble's error row between the two
  // (and flushes the group there); the host renders that row nowhere in Stage
  // 2, so the burst stays one placement, as `segmentTurn` had it.
  idle('preamble-error-tools', [
    orphanAssistant('pe3', (m) => [readTool(m, 'pe3r')], {
      error: { name: 'APIError', data: { message: 'init failed' } },
    }),
    user('ue3', (m) => [text(m, 'ue3t', 'hello')]),
    assistant('ae3', 'ue3', (m) => [
      readTool(m, 'ae3r'),
      bashTool(m, 'ae3b'),
      text(m, 'ae3t', 'done'),
    ]),
  ]),

  // Parts with an EMPTY id: the SDK refs them by position (`<msg>:#<index>`)
  // and the host resolves that ref by index — the tool and the prose render.
  idle('empty-part-ids', [
    user('ue4', (m) => [text(m, 'ue4t', 'go')]),
    assistant('ae4', 'ue4', (m) => [
      part(m, '', {
        type: 'tool',
        tool: 'read',
        callID: 'call_noid',
        state: {
          ...done(1),
          input: { filePath: '/workspace/a.ts' },
          output: 'export {}',
          title: 'a.ts',
        },
      }),
      part(m, '', { type: 'text', text: 'no id text' }),
    ]),
  ]),

  // DUPLICATE part ids inside one message: the first ref resolves to the first
  // part with that id, the second to the second — the text and the tool each
  // render once.
  idle('duplicate-part-ids', [
    user('ue5', (m) => [text(m, 'ue5t', 'go')]),
    assistant('ae5', 'ue5', (m) => [
      text(m, 'DUP', 'first text'),
      readTool(m, 'DUP'),
      text(m, 'ae5t', 'final'),
    ]),
  ]),

  // ── intended divergences (golden = the new render) ───────────────────────

  // ASSISTANT-ONLY turn: the session's first message is an orphan assistant
  // message and there is no user message at all. Legacy painted the head
  // message as a USER bubble; the row model renders it as assistant content.
  idle('assistant-only-text', [
    orphanAssistant('oe6', (m) => [text(m, 'oe6t', 'Session init: I am here.')]),
  ]),
  // Same, a failed init with NO parts: legacy drew an empty user bubble and no
  // error; now the error text renders (and nothing else).
  idle('assistant-only-error', [
    orphanAssistant('oe7', () => [], {
      error: { name: 'APIError', data: { message: 'init exploded' } },
    }),
  ]),
  // Same, the head plus a second orphan with tools: legacy put the head text in
  // a user bubble above the steps; now it is the first text step.
  idle('assistant-only-head-orphan', [
    orphanAssistant('oe8', (m) => [text(m, 'oe8t', 'first orphan')]),
    orphanAssistant('oe8b', (m) => [readTool(m, 'oe8br'), text(m, 'oe8bt', 'second orphan prose')]),
  ]),
  // WORKING, the active message holds only a whitespace text part: legacy
  // mounted an empty streaming markdown container; a blank text part has no
  // row, so the response block waits for the first non-blank character.
  busy('working-whitespace-text', [
    user('ue9', (m) => [text(m, 'ue9t', 'go')]),
    streamingAssistant('ae9', 'ue9', (m) => [
      bookkeeping(m, 'ae9s', 'step-start'),
      text(m, 'ae9t', '  '),
    ]),
  ]),

  // ── WORKING-state variants ───────────────────────────────────────────────
  // An IDLE multi-step burst collapses to its "Completed N steps" summary, so
  // a golden of it never asserts the step CONTENT. Each scenario below holds
  // the active assistant message BUSY with a trailing running tool: the burst
  // stays OPEN and every step renders in full. A content regression inside a
  // burst (a step swapped, dropped or re-typed) shows up here.

  // Step 2 (aborted by Stop, runtime still busy) opens with reasoning then a
  // running tool: the merged burst, open, every step visible.
  busy('abort-step2-reasoning-head-WORKING', [
    user('ue10', (m) => [text(m, 'ue10t', 'Find all TODOs and fix them')]),
    assistant('ae10s1', 'ue10', (m) => [
      bookkeeping(m, 'ae10s1ss', 'step-start'),
      text(m, 'ae10s1t', 'Let me look.'),
      readTool(m, 'ae10s1r'),
      tool(m, 'ae10s1g', 'grep', {
        ...done(4),
        input: { pattern: 'TODO', path: '/workspace' },
        output: 'a.ts:1:TODO',
        title: 'TODO',
      }),
      bookkeeping(m, 'ae10s1sf', 'step-finish'),
    ]),
    streamingAssistant(
      'ae10s2',
      'ue10',
      (m) => [
        bookkeeping(m, 'ae10s2ss', 'step-start'),
        reasoning(m, 'ae10s2r', 'I should edit a.ts'),
        bashTool(m, 'ae10s2b', true),
      ],
      { error: USER_ABORT },
    ),
  ]),

  // The failed orphan preamble's tool leads the open burst of the streaming
  // reply: the error row between them still splits nothing.
  busy('preamble-error-tools-WORKING', [
    orphanAssistant('pe11', (m) => [readTool(m, 'pe11r')], {
      error: { name: 'APIError', data: { message: 'init failed' } },
    }),
    user('ue11', (m) => [text(m, 'ue11t', 'hello')]),
    streamingAssistant('ae11', 'ue11', (m) => [readTool(m, 'ae11r'), bashTool(m, 'ae11b', true)]),
  ]),

  // An answered question FOLLOWED by a read that shares its id: the question
  // step shows "1 answered", the read step stays a read — the answered
  // substitute replaces the question part only, never its id-twin.
  busy('duplicate-part-ids-WORKING', [
    user('ue12', (m) => [text(m, 'ue12t', 'ask')]),
    streamingAssistant('ae12', 'ue12', (m) => [
      answeredQuestion(m, 'QDUPW'),
      readTool(m, 'QDUPW'),
      bashTool(m, 'ae12b', true),
    ]),
  ]),

  // A read with an EMPTY id leads the open burst; the prose after it is a text
  // step, the running tool the open tail.
  busy('empty-part-ids-WORKING', [
    user('ue13', (m) => [text(m, 'ue13t', 'go')]),
    streamingAssistant('ae13', 'ue13', (m) => [
      part(m, '', {
        type: 'tool',
        tool: 'read',
        callID: 'call_noid_w',
        state: {
          ...done(1),
          input: { filePath: '/workspace/a.ts' },
          output: 'export {}',
          title: 'a.ts',
        },
      }),
      text(m, 'ae13t', 'done'),
      bashTool(m, 'ae13b', true),
    ]),
  ]),

  // The mirror: a read FOLLOWED by an answered question that shares its id.
  busy('dup-id-question-tool-WORKING', [
    user('ue14', (m) => [text(m, 'ue14t', 'ask')]),
    streamingAssistant('ae14', 'ue14', (m) => [
      readTool(m, 'QDUPY'),
      answeredQuestion(m, 'QDUPY'),
      bashTool(m, 'ae14b', true),
    ]),
  ]),

  // Inline mode (no steps): a trailing text part that shares the answered
  // question's id renders as prose after the answered card.
  idle('inline-dup-id-question-text', [
    user('ue15', (m) => [text(m, 'ue15t', 'ask')]),
    assistant('ae15', 'ue15', (m) => [
      text(m, 'ae15t1', 'Q time'),
      answeredQuestion(m, 'IDUP'),
      text(m, 'IDUP', 'after the answer'),
    ]),
  ]),

  // ── intended divergences, continued (golden = the new render) ────────────
  // Appended AFTER the goldens above: the fixture clock ticks per message, so
  // a scenario inserted earlier would re-stamp every golden captured after it.

  // Same, a head holding only a TOOL part, then a second orphan aborted by
  // Stop: legacy put the head in the user bubble, which renders nothing for a
  // tool part, so the head's tool vanished and the one remaining step rendered
  // as an open single-step burst; now both tools are the steps of one burst.
  idle('assistant-only-head-tool-abort', [
    orphanAssistant('oe16', (m) => [readTool(m, 'oe16r')]),
    orphanAssistant('oe16b', (m) => [readTool(m, 'oe16br')], { error: USER_ABORT }),
  ]),
  // N15 (round-3 verifier): an assistant-only head holding an ANSWERED QUESTION
  // then prose. Legacy painted the head as a user bubble, which renders nothing
  // for a tool part, so the answered question vanished and only the prose
  // showed; now the head is assistant content — the answered card, then prose.
  // Same root as the three assistant-only entries above. Appended LAST: the
  // fixture clock ticks per message, so an earlier insertion re-stamps every
  // golden captured after it.
  idle('assistant-only-head-question', [
    orphanAssistant('oe17', (m) => [answeredQuestion(m, 'oe17q'), text(m, 'oe17t', 'then prose')]),
  ]),
];

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

export interface TimelineScenario {
  /** `idle` and `working` are the two broad transcripts; every other name is
   *  one edge case — see the `edge` block below. */
  name: string;
  messages: MessageWithParts[];
  sessionStatus: SessionStatus;
  lastTurnWorking: boolean;
  rewindDisabled: boolean;
  commandMessages: Map<string, { name: string; args?: string }>;
  inboxRowsByMessageId: Map<string, SessionPrompt>;
}

export const scenarios: TimelineScenario[] = [
  {
    name: 'idle',
    messages: idleMessages,
    sessionStatus: { type: 'idle' } as SessionStatus,
    lastTurnWorking: false,
    rewindDisabled: false,
    commandMessages: idleCommandMessages,
    inboxRowsByMessageId: new Map(),
  },
  {
    name: 'working',
    messages: workingMessages,
    sessionStatus: { type: 'busy' } as SessionStatus,
    lastTurnWorking: true,
    rewindDisabled: true,
    commandMessages: new Map(),
    inboxRowsByMessageId: workingInboxRowsByMessageId,
  },
  ...edgeScenarios,
];

export const FIXTURE_AGENT_NAMES = ['build'];
