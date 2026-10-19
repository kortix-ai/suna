import { describe, expect, test } from 'bun:test';
import { type AssistantMessage, type MessageWithParts, type SessionLogMessage, type SessionLogPage, type SessionLogPageQuery, type ToolCallBlock, sessionLogOfV1Rows } from '@kortix/sdk';
import { logHeaderState, printLogMessage, printMessage, readStoredSessionLog, withLiveTurn } from './sessions-chat.ts';

/** `printMessage` writes straight to stdout; swap the writer for the test. */
function render(msg: MessageWithParts): string {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    printMessage(msg);
  } finally {
    process.stdout.write = original;
  }
  return out.join('');
}

/** A failed assistant turn: no text parts, the error on `info.error`. */
const failedTurn = (error: AssistantMessage['error']): MessageWithParts => ({
  info: {
    id: 'msg_test',
    sessionID: 'ses_test',
    role: 'assistant',
    time: { created: 1_759_500_000_000 },
    error,
    modelID: 'premium-model',
    providerID: 'kortix',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/w', root: '/w' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
});

describe('printMessage — a failed turn shows the real failure reason', () => {
  test('an APIError carries the gateway body in responseBody; its message wins over the status text', () => {
    const out = render(
      failedTurn({
        name: 'APIError',
        data: {
          message: 'Bad Request',
          statusCode: 402,
          isRetryable: false,
          responseBody:
            '{"error":"plan_upgrade_required","code":402,"message":"\\"premium-model\\" requires a paid plan.","provider":"kortix","suggestion":"Upgrade your plan or pick a free model."}',
        },
      }),
    );
    expect(out).toContain('error: APIError: "premium-model" requires a paid plan.');
    expect(out).not.toContain('Bad Request');
    expect(out).not.toContain('error: unknown');
  });

  test('an UnknownError whose data.message is a JSON body unwraps to the sentence', () => {
    const out = render(
      failedTurn({
        name: 'UnknownError',
        data: { message: '{"message":"Provided authentication token is expired.","code":401}' },
      }),
    );
    expect(out).toContain('error: UnknownError: Provided authentication token is expired.');
    expect(out).not.toContain('error: unknown');
  });

  test('a ProviderAuthError shows its plain message', () => {
    const out = render(
      failedTurn({
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic', message: 'No API key found for provider "anthropic".' },
      }),
    );
    expect(out).toContain('error: ProviderAuthError: No API key found for provider "anthropic".');
    expect(out).not.toContain('error: unknown');
  });

  test('an error with no recoverable text degrades to the generic sentence, never "unknown"', () => {
    const out = render(failedTurn({ name: 'MessageOutputLengthError', data: {} }));
    expect(out).toContain('error: MessageOutputLengthError: An error occurred');
    expect(out).not.toContain('error: unknown');
  });
});

// ── P5.5: `sessions log` reads the session log and renders blocks ────────────

const AT = 1_790_000_000_000;
const REF = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
const v1Info = (id: string, role: 'user' | 'assistant', over: Record<string, unknown> = {}) =>
  role === 'user'
    ? { id, sessionID: 'ses_root', role, time: { created: AT }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' }, ...over }
    : { id, sessionID: 'ses_root', role, parentID: 'msg_u1', time: { created: AT + 1000, completed: AT + 2000 }, providerID: 'kortix', modelID: 'm', mode: 'build', agent: 'build', path: { cwd: '/w', root: '/w' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...over };
const v1Part = (mid: string, i: number, p: Record<string, unknown>) => ({ id: `prt_${mid}_${i}`, sessionID: 'ses_root', messageID: mid, ...p });
/** A turn as the v1 transcript holds it: a prompt with a file and a synthetic text, a step with reasoning and two calls, the answer, a failed reply. */
const CONVERSATION = [
  { info: v1Info('msg_u1', 'user'), parts: [v1Part('msg_u1', 0, { type: 'text', text: 'List the files.' }), v1Part('msg_u1', 1, { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: REF }), v1Part('msg_u1', 2, { type: 'text', text: 'hidden', synthetic: true })] },
  { info: v1Info('msg_a1', 'assistant'), parts: [
    v1Part('msg_a1', 0, { type: 'step-start' }),
    v1Part('msg_a1', 1, { type: 'reasoning', text: 'Use ls.', time: { start: AT, end: AT + 1 } }),
    v1Part('msg_a1', 2, { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt\nb.txt', title: 'ls', metadata: {}, time: { start: AT, end: AT + 1 } } }),
    v1Part('msg_a1', 3, { type: 'tool', callID: 'call_2', tool: 'read', state: { status: 'error', input: { filePath: '/w/x' }, error: 'File not found', time: { start: AT, end: AT + 1 } } }),
    v1Part('msg_a1', 4, { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ] },
  { info: v1Info('msg_a2', 'assistant'), parts: [v1Part('msg_a2', 0, { type: 'text', text: 'Two files: a.txt, b.txt.' })] },
  { info: v1Info('msg_a3', 'assistant', { error: { name: 'APIError', data: { message: 'Bad Request', statusCode: 402, isRetryable: false, responseBody: '{"error":"plan_upgrade_required","code":402,"message":"Pick a free model.","provider":"kortix"}' } } }), parts: [] },
] as unknown as MessageWithParts[];

function capture(run: () => void): string {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return out.join('');
}

const V2 = { schema: 'kortix.session/2', v: 1 } as const;
const record = (message_id: string, seq: number, over: Partial<SessionLogMessage> = {}): SessionLogMessage => ({
  ...V2, message_id, thread_id: 'ses_root', seq, role: 'user', kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
  finish: null, error: null, created_at: new Date(AT + seq * 1000).toISOString(), completed_at: null,
  producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks: [], ...over,
});
const head = (thread_id: string, parent: string | null) => ({ ...V2, thread_id, parent_thread_id: parent, spawned_by: null, agent: null, title: null, created_at: '' });

describe('printLogMessage — the human output is rendered from blocks', () => {
  test('a converted conversation prints as printMessage printed its v1 rows, apart from the listed differences', () => {
    const log = sessionLogOfV1Rows('S', 'ses_root', CONVERSATION as never);
    const out = capture(() => log.threads[0]!.messages.forEach((m) => printLogMessage(m)));
    const user = new Date(AT).toLocaleTimeString();
    const reply = new Date(AT + 1000).toLocaleTimeString();
    expect(out).toBe(
      `\nuser ${user}\n  List the files.\n  [file · notes.txt]\n` +
        // Differences: the schema's call status (`complete`, not `completed`), and a failed call shows its error text.
        `\nassistant ${reply}\n  [reasoning] Use ls.\n  [bash · complete]\n  a.txt\n  b.txt\n  [read · error]\n  File not found\n` +
        `\nassistant ${reply}\n  Two files: a.txt, b.txt.\n` +
        `\nassistant ${reply}\n  error: APIError: Pick a free model.\n`,
    );
  });

  test('printMessage (sessions chat) prints a v1 reply through the same block renderer', () => {
    expect(capture(() => printMessage(CONVERSATION[2]!))).toBe(`\nassistant ${new Date(AT + 1000).toLocaleTimeString()}\n  Two files: a.txt, b.txt.\n`);
  });

  test('a call the closure rule closed reads interrupted on a settled message, running on a streaming one', () => {
    const closed: ToolCallBlock = {
      type: 'tool_call', id: 'b1', call_id: 'c1', name: 'bash', kind: 'shell', input: { command: 'sleep 60' }, status: 'error',
      result: { content: [{ type: 'text', text: '[Tool execution was interrupted]' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: '[Tool execution was interrupted]' } },
    };
    expect(capture(() => printLogMessage(record('m1', 1, { role: 'assistant', blocks: [closed] })))).toContain('[bash · interrupted]\n  [Tool execution was interrupted]');
    const open: ToolCallBlock = { ...closed, status: 'running', result: undefined };
    expect(capture(() => printLogMessage(record('m2', 2, { role: 'assistant', status: 'streaming', blocks: [open] })))).toContain('[bash · running]');
  });

  test('a failed call prints its error text: the result error, else the result text', () => {
    const failed = (result: ToolCallBlock['result']): ToolCallBlock => ({
      type: 'tool_call', id: 'b2', call_id: 'c2', name: 'bash', kind: 'shell', input: { command: 'cat /w/missing.txt' }, status: 'error', result,
    });
    const text = 'cat: /w/missing.txt: No such file or directory\n\nCommand exited with code 1';
    const print = (block: ToolCallBlock) => capture(() => printLogMessage(record('m4', 4, { role: 'assistant', blocks: [block] })));
    const shown = '[bash · error]\n  cat: /w/missing.txt: No such file or directory\n  \n  Command exited with code 1\n';
    // The error only on `result.error`, no result text: this printed `[bash · error]` and nothing else.
    expect(print(failed({ content: [], is_error: true, error: { message: text } }))).toContain(shown);
    // A native export closes a failed call with `is_error` and the tool's text only.
    expect(print(failed({ content: [{ type: 'text', text }], is_error: true }))).toContain(shown);
  });

  test('a compaction is one message: its header says compaction, its body is the summary', () => {
    const out = capture(() => printLogMessage(record('m3', 3, { kind: 'compaction', blocks: [{ type: 'compaction', id: 'c', summary: 'SUMMARY of turns 0-2.', first_kept_message_id: null, trigger: 'manual' }] })));
    expect(out).toBe(`\ncompaction ${new Date(AT + 3000).toLocaleTimeString()}\n  SUMMARY of turns 0-2.\n`);
  });
});

describe('readStoredSessionLog — every thread of the stored log, newest `limit` messages each', () => {
  test('pages the root thread back by before_seq to the limit, then reads each other thread', async () => {
    const asked: SessionLogPageQuery[] = [];
    const root = Array.from({ length: 7 }, (_, i) => record(`r${i}`, i));
    const child = [record('c0', 0, { thread_id: 'ses_child' })];
    const threads = [head('ses_root', null), head('ses_child', 'ses_root')];
    const log = async (q: SessionLogPageQuery = {}): Promise<SessionLogPage | null> => {
      asked.push(q);
      const pool = q.thread === 'ses_child' ? child : root;
      const older = pool.filter((m) => q.before_seq === undefined || m.seq < q.before_seq);
      const messages = older.slice(-(q.limit ?? 40));
      return { session: { ...V2, session_id: 'S', title: 'T' }, generation: 2, threads, thread_id: q.thread ?? 'ses_root', messages, has_more: older.length > messages.length };
    };
    const stored = await readStoredSessionLog(log, 5, 3);
    expect(asked).toEqual([{ limit: 3 }, { limit: 2, before_seq: 4 }, { thread: 'ses_child', limit: 3 }]);
    expect(stored!.threads.map((t) => [t.thread_id, t.messages.map((m) => m.message_id), t.has_more])).toEqual([
      ['ses_root', ['r2', 'r3', 'r4', 'r5', 'r6'], true],
      ['ses_child', ['c0'], false],
    ]);
    expect(stored!.session).toMatchObject({ session_id: 'S', title: 'T' });
  });

  test('a session without a stored log is null', async () => {
    expect(await readStoredSessionLog(async () => null, 10)).toBeNull();
  });
});

describe('withLiveTurn — a running session shows the turn the log does not hold yet', () => {
  const root = (messages: SessionLogMessage[], has_more = false) => ({ ...head('ses_root', null), messages, has_more });
  const child = { ...head('ses_child', 'ses_root'), messages: [record('c0', 1, { thread_id: 'ses_child' })], has_more: false };
  /** The live read as `sessionLogOfV1Rows` gives it: one thread, seqs by position from 1. */
  const live = (...ids: string[]) => ({ ...head('ses_root', null), messages: ids.map((id, i) => record(id, i + 1, { role: i % 2 ? 'assistant' : 'user' })) });
  const shape = (threads: Array<{ thread_id: string; messages: SessionLogMessage[]; has_more: boolean }>) =>
    threads.map((t) => [t.thread_id, t.messages.map((m) => [m.message_id, m.seq, (m.ext?.kortix?.data as { provisional?: boolean } | undefined)?.provisional ?? false]), t.has_more]);

  test('a live message carries both marks (top-level `provisional`, deprecated, and `ext.kortix.data.provisional`); a stored one neither', () => {
    const own = { pi: { version: '1', data: { cwd: '/w' } }, kortix: { version: '1', data: { origin: 'x' } } };
    const window = { ...head('ses_root', null), messages: [record('m1', 1), { ...record('m2', 2, { role: 'assistant' }), ext: own }] };
    const [thread] = withLiveTurn([root([record('m1', 1)])], window, 10);
    const [stored, tail] = thread!.messages as Array<SessionLogMessage & { provisional?: boolean }>;
    expect(tail!.provisional).toBe(true);
    expect(tail!.ext).toEqual({ pi: own.pi, kortix: { version: '1', data: { origin: 'x', provisional: true } } });
    expect('provisional' in stored!).toBe(false);
    expect(stored!.ext?.kortix).toBeUndefined();
  });

  test('an `ext.kortix.data` that is not a plain object is left as it is; the top-level mark still says provisional', () => {
    for (const data of ['text', [1, 2], null]) {
      const ext = { kortix: { version: '1', data } };
      const window = { ...head('ses_root', null), messages: [record('m1', 1), { ...record('m2', 2, { role: 'assistant' }), ext }] };
      const [thread] = withLiveTurn([root([record('m1', 1)])], window, 10);
      const tail = thread!.messages[1] as SessionLogMessage & { provisional?: boolean };
      expect(tail.provisional).toBe(true);
      expect(tail.ext).toEqual(ext);
    }
  });

  test("the live seqs agree with the stored ones: the tail keeps fromV1's seqs, marked provisional", () => {
    const threads = withLiveTurn([root([record('m1', 1), record('m2', 2)]), child], live('m1', 'm2', 'm3', 'm4'), 10);
    expect(shape(threads)).toEqual([
      ['ses_root', [['m1', 1, false], ['m2', 2, false], ['m3', 3, true], ['m4', 4, true]], false],
      ['ses_child', [['c0', 1, false]], false],
    ]);
  });

  test('a live window that does not start at the thread start numbers the tail above the newest stored seq', () => {
    // The stored thread holds seqs 5 and 6; the live window's positions (1, 2, 3) disagree.
    const window = { ...head('ses_root', null), messages: ['m5', 'm6', 'm7'].map((id, i) => ({ ...record(id, i + 5), seq: i + 1 })) };
    const threads = withLiveTurn([root([record('m5', 5), record('m6', 6)], true)], window, 10);
    expect(shape(threads)).toEqual([['ses_root', [['m5', 5, false], ['m6', 6, false], ['m7', 7, true]], true]]);
  });

  test('a tombstoned last message (seq 3, not served): the tail goes above the newest stored seq, provisional', () => {
    const threads = withLiveTurn([root([record('m1', 1), record('m2', 2)])], live('m1', 'm2', 'm4'), 10);
    expect(shape(threads)).toEqual([['ses_root', [['m1', 1, false], ['m2', 2, false], ['m4', 3, true]], false]]);
  });

  test('an empty stored root thread takes the live read with its fromV1 seqs', () => {
    expect(shape(withLiveTurn([root([])], live('m1', 'm2'), 10))).toEqual([['ses_root', [['m1', 1, true], ['m2', 2, true]], false]]);
  });

  test('no stored root thread: the live thread comes first', () => {
    expect(shape(withLiveTurn([], live('m1', 'm2'), 10))).toEqual([['ses_root', [['m1', 1, true], ['m2', 2, true]], false]]);
  });

  test('keeps the newest `limit` messages and says older ones exist', () => {
    const threads = withLiveTurn([root([record('m1', 1), record('m2', 2)])], live('m1', 'm2', 'm3'), 2);
    expect(shape(threads)).toEqual([['ses_root', [['m2', 2, false], ['m3', 3, true]], true]]);
    expect(shape(withLiveTurn([], live('m1', 'm2', 'm3'), 2))).toEqual([['ses_root', [['m2', 2, true], ['m3', 3, true]], true]]);
  });

  test('a live read of another runtime session changes nothing; nothing new changes nothing', () => {
    const threads = [root([record('m1', 1)])];
    expect(withLiveTurn(threads, { ...live('x1', 'x2'), thread_id: 'ses_other' }, 10)).toBe(threads);
    expect(withLiveTurn(threads, live('m1'), 10)).toBe(threads);
  });
});

describe('readStoredSessionLog — a credential the log route refuses', () => {
  test('a 403 (an older API refusing a session-bound token) reads as no stored log; another error rejects', async () => {
    const refused = Object.assign(new Error('The session sandbox credential cannot read the session log'), { status: 403 });
    expect(await readStoredSessionLog(async () => { throw refused; }, 10)).toBeNull();
    const broken = Object.assign(new Error('boom'), { status: 500 });
    await expect(readStoredSessionLog(async () => { throw broken; }, 10)).rejects.toThrow('boom');
  });
});

describe('logHeaderState — the `sessions log` header names the sandbox and, when read live, the agent', () => {
  const row = (role: 'user' | 'assistant', completed?: number) =>
    ({ info: { id: `m_${role}_${completed ?? 'open'}`, role, sessionID: 's', time: { created: 1, ...(completed ? { completed } : {}) } }, parts: [] }) as unknown as MessageWithParts;

  test('a running sandbox whose agent finished its turn reads idle, not just "running"', () => {
    expect(logHeaderState('running', [row('user'), row('assistant', 2)])).toBe('sandbox running · idle');
  });

  test('a running sandbox whose agent is mid-turn reads working', () => {
    expect(logHeaderState('running', [row('user'), row('assistant')])).toBe('sandbox running · working');
  });

  test('a sandbox not read live names only its status', () => {
    expect(logHeaderState('stopped', null)).toBe('sandbox stopped');
    expect(logHeaderState('running', null)).toBe('sandbox running');
  });
});

describe('roomMessageHeader', () => {
  test('a delivered room message prints where it came from and who sent it, never the reply footer', async () => {
    const { roomMessageHeader } = await import('./sessions-chat.ts');
    const { roomPromptText } = await import('@kortix/shared');
    const text = roomPromptText({
      kind: 'room', room: 'dev', roomId: 'r1', seq: 4, senderKind: 'session', sender: '3f2a1b9c (builder)', replyTo: 2, text: 'dev is clear',
    });
    expect(roomMessageHeader(text)).toEqual({ header: 'room dev #4 · from agent session 3f2a1b9c (builder) ↳#2', body: 'dev is clear' });
    const direct = roomPromptText({ kind: 'direct', room: null, roomId: 'r2', seq: 1, senderKind: 'member', sender: 'Ada', replyTo: null, text: 'yes' });
    expect(roomMessageHeader(direct)).toEqual({ header: 'direct message #1 · from Ada', body: 'yes' });
    expect(roomMessageHeader('hello')).toBeNull();
  });
});

describe('roomMessageHeader digest', () => {
  test('a batched digest prints the room, the range and one line per message', async () => {
    const { roomMessageHeader } = await import('./sessions-chat.ts');
    const { roomDigestText } = await import('@kortix/shared');
    const text = roomDigestText({ room: 'dev', fromSeq: 4, toSeq: 5, more: 0, lines: [{ seq: 4, sender: 'Ada', text: 'deploy at 5' }, { seq: 5, sender: 'Bob', text: 'ok' }] });
    expect(roomMessageHeader(text)).toEqual({ header: 'room dev #4–#5 · 2 new messages', body: '#4 Ada: deploy at 5\n#5 Bob: ok' });
  });
});
