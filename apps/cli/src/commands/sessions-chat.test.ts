import { describe, expect, test } from 'bun:test';
import { type SessionLogMessage, type SessionLogPage, type SessionLogPageQuery, type ToolCallBlock } from '@kortix/sdk';
import { logHeaderState, printLogMessage, readStoredSessionLog, withLiveTurn } from './sessions-chat.ts';

const AT = 1_790_000_000_000;
const REF = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
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
/** A turn: a prompt with a file and a synthetic text, a step with reasoning and two calls, the answer, a failed reply. */
const CONVERSATION: SessionLogMessage[] = [
  record('m_u1', 0, { blocks: [
    { type: 'text', id: 'b0', text: 'List the files.' },
    { type: 'attachment', id: 'b1', mime: 'text/plain', name: 'notes.txt', url: REF },
    { type: 'text', id: 'b2', text: 'hidden', synthetic: true },
  ] }),
  record('m_a1', 1, { role: 'assistant', blocks: [
    { type: 'step', id: 'b0', phase: 'start' },
    { type: 'reasoning', id: 'b1', text: 'Use ls.' },
    { type: 'tool_call', id: 'b2', call_id: 'call_1', name: 'bash', kind: 'shell', input: { command: 'ls' }, status: 'complete', result: { content: [{ type: 'text', text: 'a.txt\nb.txt' }], is_error: false } },
    { type: 'tool_call', id: 'b3', call_id: 'call_2', name: 'read', kind: 'read', input: { filePath: '/w/x' }, status: 'error', result: { content: [{ type: 'text', text: 'File not found' }], is_error: true, error: { message: 'File not found' } } },
    { type: 'step', id: 'b4', phase: 'finish' },
  ] }),
  record('m_a2', 1, { role: 'assistant', blocks: [{ type: 'text', id: 'b0', text: 'Two files: a.txt, b.txt.' }] }),
  record('m_a3', 1, { role: 'assistant', status: 'error', finish: 'error', error: { code: 'APIError', message: 'Pick a free model.' } }),
];

describe('printLogMessage — the human output is rendered from blocks', () => {
  test('a conversation prints from its blocks', () => {
    const out = capture(() => CONVERSATION.forEach((m) => printLogMessage(m)));
    const user = new Date(AT).toLocaleTimeString();
    const reply = new Date(AT + 1000).toLocaleTimeString();
    expect(out).toBe(
      `\nuser ${user}\n  List the files.\n  [file · notes.txt]\n` +
        `\nassistant ${reply}\n  [reasoning] Use ls.\n  [bash · complete]\n  a.txt\n  b.txt\n  [read · error]\n  File not found\n` +
        `\nassistant ${reply}\n  Two files: a.txt, b.txt.\n` +
        `\nassistant ${reply}\n  error: APIError: Pick a free model.\n`,
    );
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
  /** The live read as the box's log route gives it: one thread, seqs by position from 1. */
  const live = (...ids: string[]) => ({ ...head('ses_root', null), messages: ids.map((id, i) => record(id, i + 1, { role: i % 2 ? 'assistant' : 'user' })) });
  const shape = (threads: Array<{ thread_id: string; messages: SessionLogMessage[]; has_more: boolean }>) =>
    threads.map((t) => [t.thread_id, t.messages.map((m) => [m.message_id, m.seq, (m.ext?.kortix?.data as { provisional?: boolean } | undefined)?.provisional ?? false]), t.has_more]);

  test('a live message carries `ext.kortix.data.provisional`, and no top-level `provisional`; a stored one neither', () => {
    const own = { pi: { version: '1', data: { cwd: '/w' } }, kortix: { version: '1', data: { origin: 'x' } } };
    const window = { ...head('ses_root', null), messages: [record('m1', 1), { ...record('m2', 2, { role: 'assistant' }), ext: own }] };
    const [thread] = withLiveTurn([root([record('m1', 1)])], window, 10);
    const [stored, tail] = thread!.messages;
    expect(tail!.ext).toEqual({ pi: own.pi, kortix: { version: '1', data: { origin: 'x', provisional: true } } });
    expect('provisional' in tail!).toBe(false);
    expect('provisional' in stored!).toBe(false);
    expect(stored!.ext?.kortix).toBeUndefined();
  });

  test('an `ext.kortix.data` that is not a plain object gives way to the mark', () => {
    for (const data of ['text', [1, 2], null]) {
      const window = { ...head('ses_root', null), messages: [record('m1', 1), { ...record('m2', 2, { role: 'assistant' }), ext: { kortix: { version: '1', data } } }] };
      const [thread] = withLiveTurn([root([record('m1', 1)])], window, 10);
      expect(thread!.messages[1]!.ext).toEqual({ kortix: { version: '1', data: { provisional: true } } });
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
    record(`m_${role}_${completed ?? 'open'}`, completed ?? 1, { role, status: role === 'assistant' && !completed ? 'streaming' : 'complete' });

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
      room: 'dev', seq: 4, senderKind: 'session', sender: '3f2a1b9c (builder)', replyTo: 2, text: 'dev is clear',
    });
    expect(roomMessageHeader(text)).toEqual({ header: 'room dev #4 · from agent session 3f2a1b9c (builder) ↳#2', body: 'dev is clear' });
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
