/**
 * The fixture transcript behind the timeline golden.
 *
 * Two scenarios, each a flat `messages` array in wire order plus the host
 * facts `SessionChat` derives around it (`workingTurnId`, `pendingTurnIds`,
 * `interruptedTurnIds`, `commandMessages`, the inbox rows). Every render
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
// scenarios
// ---------------------------------------------------------------------------

export interface TimelineScenario {
  name: 'idle' | 'working';
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
];

export const FIXTURE_AGENT_NAMES = ['build'];
