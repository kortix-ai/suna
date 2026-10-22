import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Test-only: the zod schemas the API validates with. The SDK never imports api-contract at runtime.
import { SessionLogMessageSchema } from '../../../../api-contract/src/session-log/schema';
import { isSessionLogMessage, isSessionLogPage, isSessionLogThreadHead } from './guard';
import type { SessionLog, SessionLogMessage } from './types';

const CONTRACT_FIXTURES = join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log');
const fixtures: SessionLog[] = readdirSync(CONTRACT_FIXTURES)
  .filter((name) => name.endsWith('.v2.json'))
  .map((name) => JSON.parse(readFileSync(join(CONTRACT_FIXTURES, name), 'utf8')));
const log: SessionLog = JSON.parse(readFileSync(join(CONTRACT_FIXTURES, 'golden21.v2.json'), 'utf8'));
const message = (): SessionLogMessage => structuredClone(log.threads[0]!.messages[0]!);

describe('isSessionLogMessage', () => {
  test('accepts every message of every api-contract fixture', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    let count = 0;
    for (const fixture of fixtures) {
      for (const thread of fixture.threads) {
        for (const m of thread.messages) {
          expect(isSessionLogMessage(m)).toBe(true);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(100);
  });

  // Each mutation is one the zod schema rejects too; the guard must agree.
  const broken: Array<[string, (m: Record<string, any>) => void]> = [
    ['another schema', (m) => { m.schema = 'kortix.session/3'; }],
    ['a missing message_id', (m) => { delete m.message_id; }],
    ['a numeric thread_id', (m) => { m.thread_id = 7; }],
    ['a fractional seq', (m) => { m.seq = 1.5; }],
    ['an unknown role', (m) => { m.role = 'tool'; }],
    ['an unknown kind', (m) => { m.kind = 'chat'; }],
    ['an unknown status', (m) => { m.status = 'done'; }],
    ['a string in_context', (m) => { m.in_context = 'yes'; }],
    ['blocks that are not an array', (m) => { m.blocks = {}; }],
    ['a block without an id', (m) => { delete m.blocks[0].id; }],
    ['a block of an unknown type', (m) => { m.blocks[0].type = 'image'; }],
    ['a text block without text', (m) => { delete m.blocks[0].text; }],
    ['two blocks with one id', (m) => { m.blocks.push({ ...m.blocks[0] }); }],
    ['a producer without a harness', (m) => { m.producer = {}; }],
    ['a missing created_at', (m) => { delete m.created_at; }],
    ['an error without a code', (m) => { m.error = { message: 'x' }; }],
    ['an unknown finish', (m) => { m.finish = 'done'; }],
    ['an array', () => {}],
  ];
  for (const [name, mutate] of broken) {
    test(`rejects ${name}, as the zod schema does`, () => {
      const m = message() as unknown as Record<string, any>;
      mutate(m);
      const input = name === 'an array' ? [m] : m;
      expect(SessionLogMessageSchema.safeParse(input).success).toBe(false);
      expect(isSessionLogMessage(input)).toBe(false);
    });
  }

  // The review's probe set: fields `toV1` and the store read, and the message-level rules (F3, F13, C2).
  const all = () => fixtures.flatMap((f) => f.threads.flatMap((t) => t.messages));
  const withBlock = (type: string) => structuredClone(all().find((m) => m.blocks.some((b) => b.type === type))!) as unknown as Record<string, any>;
  const blockOf = (m: Record<string, any>, type: string) => m.blocks.find((b: { type: string }) => b.type === type);
  const probes: Array<[string, () => unknown]> = [
    ['model: {}', () => ({ ...message(), model: {} })],
    ['usage: {}', () => ({ ...message(), usage: {} })],
    ['a producer without its versions', () => ({ ...message(), producer: { harness: 'pi' } })],
    ['an unknown hidden_reason', () => ({ ...message(), hidden_reason: 'gone' })],
    ['an unknown origin', () => ({ ...message(), origin: 'robot' })],
    ['agent: 5', () => ({ ...message(), agent: 5 })],
    ['reply_to: 5', () => ({ ...message(), reply_to: 5 })],
    ['context_ref: 5', () => ({ ...message(), context_ref: 5 })],
    ["ext: 'x'", () => ({ ...message(), ext: 'x' })],
    ['a tool result content of [1]', () => { const m = withBlock('tool_call'); blockOf(m, 'tool_call').result = { content: [1], is_error: false }; return m; }],
    ["a text block with bytes: 'x'", () => { const m = message() as unknown as Record<string, any>; m.blocks[0].bytes = 'x'; return m; }],
    ['F3: a text ref without bytes', () => { const m = message() as unknown as Record<string, any>; m.blocks[0].ref = 'blob:1'; return m; }],
    ['F13: an attachment with ref and no bytes', () => { const m = withBlock('attachment'); const a = blockOf(m, 'attachment'); a.ref = 'blob:1'; delete a.bytes; return m; }],
    ['C2: an open tool call in an in-context message at rest', () => { const m = withBlock('tool_call'); m.status = 'complete'; m.in_context = true; const b = blockOf(m, 'tool_call'); b.status = 'running'; delete b.result; return m; }],
  ];
  for (const [name, build] of probes) {
    test(`rejects ${name}, as the zod schema does`, () => {
      const input = build();
      expect(SessionLogMessageSchema.safeParse(input).success).toBe(false);
      expect(isSessionLogMessage(input)).toBe(false);
    });
  }

  test('accepts a streaming message with an open tool call (C2 applies at rest only)', () => {
    const m = withBlock('tool_call');
    m.status = 'streaming';
    const b = blockOf(m, 'tool_call');
    b.status = 'running';
    delete b.result;
    expect(SessionLogMessageSchema.safeParse(m).success).toBe(true);
    expect(isSessionLogMessage(m)).toBe(true);
  });

  test('rejects a tool call with an unknown status and an attachment without a mime', () => {
    const tool = structuredClone(fixtures.flatMap((f) => f.threads.flatMap((t) => t.messages)).find((m) => m.blocks.some((b) => b.type === 'tool_call'))!);
    (tool.blocks.find((b) => b.type === 'tool_call') as Record<string, unknown>).status = 'done';
    expect(isSessionLogMessage(tool)).toBe(false);
    const att = structuredClone(fixtures.flatMap((f) => f.threads.flatMap((t) => t.messages)).find((m) => m.blocks.some((b) => b.type === 'attachment'))!);
    delete (att.blocks.find((b) => b.type === 'attachment') as Record<string, unknown>).mime;
    expect(isSessionLogMessage(att)).toBe(false);
  });
});

describe('isSessionLogThreadHead', () => {
  test('accepts a thread without its messages and rejects a broken one', () => {
    const { messages: _messages, ...head } = log.threads[1]!;
    expect(isSessionLogThreadHead(head)).toBe(true);
    expect(isSessionLogThreadHead({ ...head, thread_id: '' })).toBe(false);
    expect(isSessionLogThreadHead({ ...head, parent_thread_id: 3 })).toBe(false);
    expect(isSessionLogThreadHead({ ...head, schema: 'kortix.transcript.v1' })).toBe(false);
  });
});

describe('isSessionLogPage', () => {
  const page = () => {
    const { threads, ...session } = structuredClone(log);
    return {
      session,
      generation: 2,
      threads: threads.map(({ messages: _m, ...head }) => head),
      thread_id: threads[0]!.thread_id,
      messages: threads[0]!.messages,
      has_more: false,
    };
  };
  test('accepts a page whose session record is partial (the journal has not sent every field), and an empty page', () => {
    const a = page();
    a.session = { title: 'only a title' } as never;
    expect(isSessionLogPage(a)).toBe(true);
    expect(isSessionLogPage({ ...page(), thread_id: null, messages: [] })).toBe(true);
  });
  test('rejects a page whose message belongs to another thread, or a non-string thread_id', () => {
    const a = page();
    a.messages[0] = { ...a.messages[0]!, thread_id: 'ses_other' };
    expect(isSessionLogPage(a)).toBe(false);
    expect(isSessionLogPage({ ...page(), thread_id: 5 })).toBe(false);
    expect(isSessionLogPage({ ...page(), thread_id: null })).toBe(false);
  });
  test('accepts a well-formed page', () => {
    expect(isSessionLogPage(page())).toBe(true);
  });
  test('rejects a page with a broken message, thread, session or generation', () => {
    const a = page();
    (a.messages[2] as Record<string, unknown>).seq = 'x';
    expect(isSessionLogPage(a)).toBe(false);
    const b = page();
    (b.threads[0] as Record<string, unknown>).thread_id = null;
    expect(isSessionLogPage(b)).toBe(false);
    const c = page();
    (c.session as Record<string, unknown>).session_id = 1;
    expect(isSessionLogPage(c)).toBe(false);
    expect(isSessionLogPage({ ...page(), generation: -1 })).toBe(false);
    expect(isSessionLogPage({ ...page(), has_more: 'no' })).toBe(false);
    expect(isSessionLogPage(null)).toBe(false);
  });
});
