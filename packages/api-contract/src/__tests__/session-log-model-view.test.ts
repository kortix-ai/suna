import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionLogSchema,
  canonicalizeView,
  compareOptionsFor,
  compareViews,
  modelView,
  normalizeAnthropic,
  normalizeOpenAIChat,
  normalizeRequest,
  normalizeResponses,
  threadView,
  type CompactionBlock,
  type ModelView,
  type ModelViewItem,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type ViewTarget,
} from '../session-log';

const FIXTURES = join(import.meta.dir, 'fixtures', 'session-log');
const read = <T>(name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
const load = (name: string) => read<SessionLog>(`${name}.v2.json`);
const clone = <T>(value: T): T => structuredClone(value);

// ─── the 7 fixtures against the prototype's expected views ───────────────────

const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const;
type Expected = { next_prompts: Record<string, string>; views: Record<string, ModelView> };
/** A model no fixture used: no reasoning is replayed to it, so the view equals the prototype's, which has none. */
const OTHER: ViewTarget = { provider: 'nobody', model: 'nothing' };

describe('modelView of the 7 fixtures equals the recorded expected view', () => {
  for (const name of NAMES) {
    const log = load(name);
    const expected = read<Expected>(`${name}.expected-view.json`);
    test(`${name}: every thread, exactly (target without reasoning)`, () => {
      expect(Object.keys(expected.views).sort()).toEqual(log.threads.map((t) => t.thread_id).sort());
      for (const t of log.threads) {
        expect(threadView(log, t.thread_id, OTHER, { next_prompt: expected.next_prompts[t.thread_id] })).toEqual(expected.views[t.thread_id]);
      }
    });
    test(`${name}: every thread, after the normalizer (target = the model of the session)`, () => {
      const model = log.selection.model ?? { provider: OTHER.provider, model: OTHER.model };
      for (const t of log.threads) {
        const own = threadView(log, t.thread_id, model, { next_prompt: expected.next_prompts[t.thread_id] });
        expect(canonicalizeView(own)).toEqual(canonicalizeView(expected.views[t.thread_id]));
      }
    });
  }

  test('the golden fixtures carry the compaction summary and the child thread view', () => {
    const golden = read<Expected>('golden.expected-view.json');
    const views = Object.values(golden.views);
    expect(views.some((v) => v[0]?.role === 'summary')).toBe(true);
    expect(views.length).toBe(2);
  });
});

// ─── the 65 recorded next requests ───────────────────────────────────────────

type RecordedCase = { target: string; api: 'openai-chat' | 'anthropic-messages' | 'openai-responses'; source: string; thread_id: string; next_prompt: string; body: unknown };

describe('the next request a restored harness sent equals modelView plus the prompt', () => {
  const cases = read<RecordedCase[]>('recorded-requests.json');
  test('the matrix has 65 cases: 5 target harnesses, 7 sources, root and sub-agent threads', () => {
    expect(cases.length).toBe(65);
    expect(new Set(cases.map((c) => c.target)).size).toBe(5);
    expect(new Set(cases.map((c) => c.source)).size).toBe(7);
  });
  for (const c of cases) {
    test(`${c.target} <- ${c.source} ${c.thread_id.slice(-10)} (${c.api})`, () => {
      const log = load(c.source);
      const expected = threadView(log, c.thread_id, OTHER, { next_prompt: c.next_prompt });
      const result = compareViews(expected, normalizeRequest(c.api, c.body), compareOptionsFor(c.target, log, c.thread_id));
      expect(result.diffs).toEqual([]);
      expect(result.pass).toBe(true);
    });
  }
});

// ─── builders for the synthetic records ──────────────────────────────────────

const AT = '2026-01-01T00:00:00.000Z';
const A: ViewTarget = { provider: 'prov', model: 'model-a' };
const B: ViewTarget = { provider: 'prov', model: 'model-b' };
const text = (value: string, patch: Partial<Extract<SessionLogBlock, { type: 'text' }>> = {}): SessionLogBlock => ({ type: 'text', id: 'b', text: value, ...patch });
const reasoning = (value: string, redacted?: boolean): SessionLogBlock => ({ type: 'reasoning', id: 'b', text: value, ...(redacted ? { redacted } : {}) });
const attachment = (patch: Partial<Extract<SessionLogBlock, { type: 'attachment' }>>): SessionLogBlock => ({ type: 'attachment', id: 'b', ref: 'blob:abc', mime: 'image/png', bytes: 1, ...patch });
const toolCall = (patch: Partial<Extract<SessionLogBlock, { type: 'tool_call' }>>): SessionLogBlock => ({ type: 'tool_call', id: 'b', call_id: 'c1', name: 'read', kind: 'read', input: { path: 'a' }, status: 'complete', ...patch });
const compaction = (patch: Partial<CompactionBlock>): SessionLogBlock => ({ type: 'compaction', id: 'b', summary: 'SUM', first_kept_message_id: null, ...patch });

let counter = 0;
/** Builds one message; `blocks` get unique ids. */
const msg = (message_id: string, seq: number, role: SessionLogMessage['role'], blocks: SessionLogBlock[], patch: Partial<SessionLogMessage> = {}): SessionLogMessage => ({
  v: 0,
  schema: 'kortix.session/2',
  message_id,
  thread_id: 'root',
  seq,
  role,
  kind: 'turn',
  status: 'complete',
  in_context: true,
  model: role === 'assistant' ? { provider: A.provider, model: A.model } : null,
  usage: null,
  finish: null,
  error: null,
  created_at: AT,
  completed_at: AT,
  producer: { harness: 'test', harness_version: '0', adapter_version: '0' },
  blocks: blocks.map((b) => ({ ...b, id: `b${counter++}` })),
  ...patch,
} as SessionLogMessage);
const user = (id: string, seq: number, value: string, patch: Partial<SessionLogMessage> = {}) => msg(id, seq, 'user', [text(value)], patch);
const assistant = (id: string, seq: number, value: string, patch: Partial<SessionLogMessage> = {}) => msg(id, seq, 'assistant', [text(value)], patch);
const compactionMsg = (id: string, seq: number, block: Partial<CompactionBlock>) => msg(id, seq, 'assistant', [compaction(block)], { kind: 'compaction' });

const thread = (thread_id: string, messages: SessionLogMessage[], patch: Partial<SessionLogThread> = {}): SessionLogThread => ({
  v: 0,
  schema: 'kortix.session/2',
  thread_id,
  parent_thread_id: null,
  spawned_by: null,
  agent: null,
  title: null,
  created_at: AT,
  messages: messages.map((m) => ({ ...m, thread_id })),
  ...patch,
});
const logOf = (...threads: SessionLogThread[]): SessionLog => build(true, threads);
/** A record the validator rejects (a record bug), for the tests that pin what the view does with one. */
const invalidLogOf = (...threads: SessionLogThread[]): SessionLog => build(false, threads);
const build = (valid: boolean, threads: SessionLogThread[]): SessionLog => {
  const record: SessionLog = {
    v: 0,
    schema: 'kortix.session/2',
    session_id: 'root',
    title: null,
    created_at: AT,
    restore_grade: 'native',
    harness: { current: 'test', history: [] },
    selection: { agent: null, model: null },
    todos: [],
    pending: { questions: [], permissions: [] },
    threads,
  };
  expect(SessionLogSchema.safeParse(record).success).toBe(valid);
  return record;
};
const rootView = (log: SessionLog, target: ViewTarget = A) => threadView(log, 'root', target);
const textsOf = (view: ModelView) => view.map((it) => (it.role === 'summary' ? `S:${it.text}` : it.role === 'tool' ? `T:${it.content}` : `${it.role[0]}:${it.text.join('|')}`));

// ─── context membership and order ────────────────────────────────────────────

describe('which messages the model sees', () => {
  test('only in_context turn messages, in seq order whatever the array order', () => {
    const log = logOf(
      thread('root', [
        assistant('m3', 3, 'third'),
        user('m1', 1, 'first'),
        assistant('m2', 2, 'dropped', { in_context: false, hidden_reason: 'failed_attempt' }),
        msg('m4', 4, 'system', [text('injected')], { kind: 'context' }),
        user('m5', 5, 'fifth'),
      ]),
    );
    expect(textsOf(rootView(log))).toEqual(['u:first', 'a:third', 'u:fifth']);
  });

  test('modelView returns every thread, keyed by thread_id; a child thread has only its own messages', () => {
    const log = logOf(
      thread('root', [user('m1', 1, 'root prompt'), assistant('m2', 2, 'root answer')]),
      thread('child', [user('c1', 1, 'child prompt'), assistant('c2', 2, 'child answer')], { parent_thread_id: 'root', spawned_by: { message_id: 'm2', call_id: 'c1' } }),
    );
    const views = modelView(log, A);
    expect(Object.keys(views)).toEqual(['root', 'child']);
    expect(textsOf(views.root)).toEqual(['u:root prompt', 'a:root answer']);
    expect(textsOf(views.child)).toEqual(['u:child prompt', 'a:child answer']);
  });

  test('next_prompt is a final user item, and an unknown thread throws', () => {
    const log = logOf(thread('root', [user('m1', 1, 'hi')]));
    expect(textsOf(threadView(log, 'root', A, { next_prompt: 'next' }))).toEqual(['u:hi', 'u:next']);
    expect(() => threadView(log, 'nope', A)).toThrow('no thread nope');
  });
});

// ─── compaction ──────────────────────────────────────────────────────────────

describe('compaction', () => {
  const history = [user('m1', 1, 'old question'), assistant('m2', 2, 'old answer'), user('m3', 3, 'kept question'), assistant('m4', 4, 'kept answer')];

  test('without layout: the summary, the messages from first_kept_message_id up to the marker, then the later messages', () => {
    const log = logOf(thread('root', [...history, compactionMsg('m5', 5, { summary: ' SUMMARY ', first_kept_message_id: 'm3' }), user('m6', 6, 'after')]));
    expect(textsOf(rootView(log))).toEqual(['S:SUMMARY', 'u:kept question', 'a:kept answer', 'u:after']);
  });

  test('without layout and without a kept message: the summary alone, then the later messages', () => {
    const log = logOf(thread('root', [...history, compactionMsg('m5', 5, { first_kept_message_id: null }), user('m6', 6, 'after')]));
    expect(textsOf(rootView(log))).toEqual(['S:SUM', 'u:after']);
  });

  test('a kept message that is out of context stays out', () => {
    const log = logOf(thread('root', [user('m1', 1, 'a'), assistant('m2', 2, 'gone', { in_context: false }), compactionMsg('m3', 3, { first_kept_message_id: 'm1' })]));
    expect(textsOf(rootView(log))).toEqual(['S:SUM', 'u:a']);
  });

  test('with layout: exactly the listed entries in order, even summary last and out-of-order messages', () => {
    const log = logOf(
      thread('root', [
        ...history,
        compactionMsg('m5', 5, {
          first_kept_message_id: 'm3',
          layout: [{ message_id: 'm4' }, { text: 'literal tail' }, { message_id: 'm3' }, { summary: true }],
        }),
        user('m6', 6, 'after'),
      ]),
    );
    expect(textsOf(rootView(log))).toEqual(['a:kept answer', 'u:literal tail', 'u:kept question', 'S:SUM', 'u:after']);
  });

  test('with layout: text_only drops the attachments of a user entry; a summary:true entry with a null summary adds nothing', () => {
    const withImage = msg('m1', 1, 'user', [text('look'), attachment({ sha256: 'f'.repeat(64) })]);
    const keep = clone(withImage);
    const log = logOf(
      thread('root', [
        withImage,
        { ...keep, message_id: 'm2', seq: 2 },
        compactionMsg('m3', 3, { summary: null, opaque: true, layout: [{ message_id: 'm1', text_only: true }, { message_id: 'm2' }, { summary: true }] }),
      ]),
    );
    const view = rootView(log);
    expect(view).toEqual([
      { role: 'user', text: ['look'], images: [] },
      { role: 'user', text: ['look'], images: ['f'.repeat(64)] },
    ]);
  });

  test('a message that a layout entry names is shown even when it is out of context (C1: exactly the listed entries)', () => {
    const log = logOf(
      thread('root', [
        user('m1', 1, 'hidden by the log', { in_context: false }),
        compactionMsg('m2', 2, { layout: [{ message_id: 'm1' }, { summary: true }] }),
      ]),
    );
    expect(textsOf(rootView(log))).toEqual(['u:hidden by the log', 'S:SUM']);
  });

  test('the last in-context compaction wins; an earlier or out-of-context marker is ignored', () => {
    const log = logOf(
      thread('root', [
        user('m1', 1, 'one'),
        compactionMsg('m2', 2, { summary: 'FIRST', first_kept_message_id: 'm1' }),
        user('m3', 3, 'two'),
        compactionMsg('m4', 4, { summary: 'SECOND', first_kept_message_id: 'm3' }),
        user('m5', 5, 'three'),
        { ...compactionMsg('m6', 6, { summary: 'REVERTED', first_kept_message_id: 'm5' }), in_context: false },
      ]),
    );
    expect(textsOf(rootView(log))).toEqual(['S:SECOND', 'u:two', 'u:three']);
  });
});

// ─── text, tool calls, attachments ───────────────────────────────────────────

describe('what a message contributes', () => {
  test('model_text wins over text; several text blocks stay separate segments that the comparison concatenates', () => {
    const log = logOf(thread('root', [msg('m1', 1, 'user', [text('display', { model_text: ' seen ' }), text('second'), text('third')])]));
    const view = rootView(log);
    expect(view).toEqual([{ role: 'user', text: ['seen', 'second', 'third'], images: [] }]);
    expect(canonicalizeView(view)).toEqual([{ role: 'user', t: 'seensecondthird', att: [] }]);
    expect(compareViews(view, [{ role: 'user', text: ['seen\nsecond\nthird'], images: [] }]).pass).toBe(true);
    expect(compareViews(view, [{ role: 'user', text: ['display second third'], images: [] }]).pass).toBe(false);
  });

  test('an empty model_text hides the text', () => {
    const log = logOf(thread('root', [msg('m1', 1, 'user', [text('display', { model_text: '' })])]));
    expect(rootView(log)).toEqual([{ role: 'user', text: [], images: [] }]);
  });

  test('a synthetic assistant text is dropped; a synthetic user text stays', () => {
    const log = logOf(thread('root', [msg('m1', 1, 'user', [text('caveat', { synthetic: true })]), msg('m2', 2, 'assistant', [text('reminder', { synthetic: true }), text('real')])]));
    expect(textsOf(rootView(log))).toEqual(['u:caveat', 'a:real']);
  });

  test('a tool call gives call_id, name, input and the result; model_content wins over content', () => {
    const log = logOf(
      thread('root', [
        msg('m1', 1, 'assistant', [
          toolCall({ call_id: 'c1', name: 'read', input: { path: 'a' }, result: { content: [{ type: 'text', text: 'raw output' }], model_content: [{ type: 'text', text: 'pruned' }], is_error: false } }),
          toolCall({ call_id: 'c2', name: 'bash', input: { cmd: 'false' }, result: { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }], is_error: true } }),
        ]),
      ]),
    );
    expect(rootView(log)).toEqual([
      { role: 'assistant', text: [], calls: [{ id: 'c1', name: 'read', input: { path: 'a' } }, { id: 'c2', name: 'bash', input: { cmd: 'false' } }] },
      { role: 'tool', call_id: 'c1', content: 'pruned', is_error: false },
      { role: 'tool', call_id: 'c2', content: 'line1\nline2', is_error: true },
    ]);
  });

  test('an in-context call without a result gives the assistant call and no tool item (the at-rest closure rule makes this a record bug)', () => {
    const log = invalidLogOf(thread('root', [msg('m1', 1, 'assistant', [toolCall({ call_id: 'c9', status: 'pending' })])]));
    expect(rootView(log)).toEqual([{ role: 'assistant', text: [], calls: [{ id: 'c9', name: 'read', input: { path: 'a' } }] }]);
  });

  test('an attachment gives its content id: sha256, else the hash in a blob: ref; a tool-result attachment rides on the tool item', () => {
    const sha = 'a'.repeat(64);
    const log = logOf(
      thread('root', [
        msg('m1', 1, 'user', [text('see'), attachment({ sha256: sha, ref: 'obj/1' }), attachment({ ref: `blob:${'b'.repeat(64)}` })]),
        msg('m2', 2, 'assistant', [toolCall({ result: { content: [{ type: 'attachment', ref: `blob:${'c'.repeat(64)}`, mime: 'image/png' }], is_error: false } })]),
      ]),
    );
    const view = rootView(log);
    expect(view[0]).toEqual({ role: 'user', text: ['see'], images: [sha, 'b'.repeat(64)] });
    expect(view[2]).toEqual({ role: 'tool', call_id: 'c1', content: '', is_error: false, images: ['c'.repeat(64)] });
  });

  test('an attachment with neither sha256 nor ref (F13, bytes missing) adds nothing', () => {
    const log = logOf(thread('root', [msg('m1', 1, 'user', [text('see'), attachment({ ref: undefined, bytes: undefined })])]));
    expect(rootView(log)).toEqual([{ role: 'user', text: ['see'], images: [] }]);
  });

  test('a text stored by reference needs resolve_text', () => {
    const log = logOf(thread('root', [msg('m1', 1, 'user', [text('preview', { ref: 'obj/big', bytes: 999999 })])]));
    expect(() => rootView(log)).toThrow('stored by reference');
    expect(threadView(log, 'root', A, { resolve_text: (ref) => `full of ${ref}` })).toEqual([{ role: 'user', text: ['full of obj/big'], images: [] }]);
  });
});

// ─── harness blocks ──────────────────────────────────────────────────────────

describe('harness blocks', () => {
  const harnessBlock = (patch: Partial<Extract<SessionLogBlock, { type: 'harness' }>>): SessionLogBlock => ({ type: 'harness', id: 'b', harness: 'codex', kind: 'x', data: {}, model_visible: true, ...patch });

  test('model_visible: false is dropped even with fallback_text; a visible block contributes its fallback_text; one without it adds nothing', () => {
    const log = logOf(
      thread('root', [
        msg('m1', 1, 'assistant', [
          harnessBlock({ model_visible: false, fallback_text: 'hidden' }),
          harnessBlock({ model_visible: true, fallback_text: ' shown ' }),
          harnessBlock({ model_visible: true }),
          text('plain'),
        ]),
      ]),
    );
    expect(textsOf(rootView(log))).toEqual(['a:shown|plain']);
  });
});

// ─── reasoning follows the target ────────────────────────────────────────────

describe('reasoning per target', () => {
  const log = logOf(thread('root', [user('m1', 1, 'q'), msg('m2', 2, 'assistant', [reasoning('thinking'), text('answer')])]));

  test('the same provider and model keeps it', () => {
    expect(rootView(log, A)[1]).toEqual({ role: 'assistant', text: ['answer'], calls: [], reasoning: ['thinking'] });
  });

  test('another model or another provider drops it', () => {
    expect(rootView(log, B)[1]).toEqual({ role: 'assistant', text: ['answer'], calls: [] });
    expect(rootView(log, { provider: 'other', model: A.model })[1]).toEqual({ role: 'assistant', text: ['answer'], calls: [] });
  });

  test('a message with no model counts as another model', () => {
    const noModel = logOf(thread('root', [msg('m1', 1, 'assistant', [reasoning('thinking'), text('answer')], { model: null })]));
    expect(rootView(noModel, A)[0]).toEqual({ role: 'assistant', text: ['answer'], calls: [] });
  });

  test("lowers_to_text (pi, OpenCode): another model's reasoning becomes assistant text in block order; the same model keeps it as reasoning", () => {
    expect(rootView(log, { ...B, reasoning_replay: 'lowers_to_text' })[1]).toEqual({ role: 'assistant', text: ['thinking', 'answer'], calls: [] });
    expect(rootView(log, { ...A, reasoning_replay: 'lowers_to_text' })[1]).toEqual({ role: 'assistant', text: ['answer'], calls: [], reasoning: ['thinking'] });
  });

  test('none replays no reasoning at all, not even the same model', () => {
    expect(rootView(log, { ...A, reasoning_replay: 'none' })[1]).toEqual({ role: 'assistant', text: ['answer'], calls: [] });
  });

  test('empty reasoning adds nothing; the comparison ignores kept reasoning', () => {
    const empty = logOf(thread('root', [msg('m1', 1, 'assistant', [reasoning('', true), text('answer')])]));
    expect(rootView(empty, A)[0]).toEqual({ role: 'assistant', text: ['answer'], calls: [] });
    expect(compareViews(rootView(log, A), rootView(log, B)).pass).toBe(true);
  });

  test('a target the record never saw, on a real fixture: lowering puts the reasoning text in the assistant message; same_model drops it', () => {
    const v2 = load('opencode-v2');
    const root = v2.threads[0].thread_id;
    const own = threadView(v2, root, { provider: 'mock', model: 'mock-model' });
    const kept = own.find((it) => it.role === 'assistant' && it.reasoning);
    expect(kept).toBeTruthy();
    const reasoningText = (kept as Extract<ModelViewItem, { role: 'assistant' }>).reasoning![0];
    const unseen: ViewTarget = { provider: 'never-seen', model: 'never-seen' };
    const lowered = threadView(v2, root, { ...unseen, reasoning_replay: 'lowers_to_text' });
    const dropped = threadView(v2, root, unseen);
    expect(lowered.some((it) => it.role === 'assistant' && it.text.includes(reasoningText) && !it.reasoning)).toBe(true);
    expect(dropped.some((it) => it.role === 'assistant' && (it.text.includes(reasoningText) || it.reasoning))).toBe(false);
  });
});

// ─── the oracle detects a change ─────────────────────────────────────────────

describe('the oracle is an oracle', () => {
  const golden = load('golden');
  const rootId = golden.session_id;
  const target: ViewTarget = { provider: 'mock', model: 'mock-model' };
  const base = threadView(golden, rootId, target);

  const messages = (log: SessionLog) => log.threads.find((t) => t.thread_id === rootId)!.messages;
  const firstTextBlock = (m: SessionLogMessage) => m.blocks.find((b) => b.type === 'text') as Extract<SessionLogBlock, { type: 'text' }>;

  test('changing the text of an in-context message after the compaction changes the view', () => {
    const copy = clone(golden);
    const cut = messages(copy).filter((m) => m.kind === 'compaction' && m.in_context).pop()!;
    const changed = messages(copy).find((m) => m.in_context && m.kind === 'turn' && m.seq > cut.seq && m.role === 'user' && firstTextBlock(m))!;
    firstTextBlock(changed).text += ' (edited)';
    const view = threadView(copy, rootId, target);
    expect(view).not.toEqual(base);
    expect(compareViews(base, view).pass).toBe(false);
  });

  test('changing a tool result the model saw changes the view', () => {
    const copy = clone(golden);
    const cut = messages(copy).filter((m) => m.kind === 'compaction' && m.in_context).pop()!;
    const call = messages(copy)
      .filter((m) => m.in_context && m.kind === 'turn' && m.seq < cut.seq && m.seq >= 9)
      .flatMap((m) => m.blocks)
      .find((b): b is Extract<SessionLogBlock, { type: 'tool_call' }> => b.type === 'tool_call' && !!b.result)!;
    call.result!.content = [{ type: 'text', text: 'something else' }];
    delete call.result!.model_content;
    expect(compareViews(base, threadView(copy, rootId, target)).pass).toBe(false);
  });

  test('changing the text of an out-of-context message does not change the view', () => {
    const copy = clone(golden);
    const out = messages(copy).find((m) => !m.in_context && firstTextBlock(m))!;
    firstTextBlock(out).text += ' (edited)';
    expect(threadView(copy, rootId, target)).toEqual(base);
  });

  test('changing a message before the compaction cut changes nothing when the cut does not keep it', () => {
    const copy = clone(golden);
    const first = messages(copy).find((m) => m.message_id === golden.threads[0].messages[0].message_id)!;
    const cut = messages(copy).filter((m) => m.kind === 'compaction' && m.in_context).pop()!;
    const block = cut.blocks.find((b): b is CompactionBlock => b.type === 'compaction')!;
    expect(block.layout).toBeUndefined();
    expect(first.seq).toBeLessThan(messages(copy).find((m) => m.message_id === block.first_kept_message_id)!.seq);
    firstTextBlock(first).text += ' (edited)';
    expect(threadView(copy, rootId, target)).toEqual(base);
  });
});

// ─── normalizers ─────────────────────────────────────────────────────────────

const sha = (bytes: string) => createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex');

describe('request normalizers', () => {
  const PNG = 'aGVsbG8='; // "hello"
  test('openai-chat: system dropped, JSON arguments parsed, tool-result media folds into the tool item', () => {
    const view = normalizeOpenAIChat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'x', function: { name: 'read', arguments: '{"p":1}' } }] },
        { role: 'tool', tool_call_id: 'x', content: 'out' },
        { role: 'user', content: [{ type: 'text', text: 'Attached media from tool result:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] },
      ],
    });
    expect(view).toEqual([
      { role: 'user', text: ['hi'], images: [sha(PNG)] },
      { role: 'assistant', text: ['ok'], calls: [{ id: 'x', name: 'read', input: { p: 1 } }] },
      { role: 'tool', call_id: 'x', content: 'out', images: [sha(PNG)] },
    ]);
  });

  test('anthropic-messages: tool_result becomes a tool item with is_error; non user/assistant roles are skipped', () => {
    const view = normalizeAnthropic({
      messages: [
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: [{ type: 'text', text: 'run' }, { type: 'tool_use', id: 't1', name: 'bash', input: { c: 'false' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bad', is_error: true }, { type: 'text', text: 'next' }] },
      ],
    });
    expect(view).toEqual([
      { role: 'assistant', text: ['run'], calls: [{ id: 't1', name: 'bash', input: { c: 'false' } }] },
      { role: 'tool', call_id: 't1', content: 'bad', is_error: true },
      { role: 'user', text: ['next'], images: [] },
    ]);
  });

  test('openai-responses: assistant messages and calls merge; reasoning items are ignored', () => {
    const view = normalizeResponses({
      input: [
        { type: 'message', role: 'developer', content: 'dev' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
        { type: 'function_call', call_id: 'k', name: 'read', arguments: '{"p":2}' },
        { type: 'function_call_output', call_id: 'k', output: 'done' },
      ],
    });
    expect(view).toEqual([
      { role: 'user', text: ['hi'], images: [] },
      { role: 'assistant', text: ['ok'], calls: [{ id: 'k', name: 'read', input: { p: 2 } }] },
      { role: 'tool', call_id: 'k', content: 'done' },
    ]);
  });

  test('normalizeRequest picks the normalizer by api and rejects an unknown api', () => {
    expect(normalizeRequest('openai-chat', { messages: [{ role: 'user', content: 'x' }] })).toEqual([{ role: 'user', text: ['x'], images: [] }]);
    expect(() => normalizeRequest('gemini', {})).toThrow('no request normalizer');
  });

  test('known blind spot: in segment summary mode, extra text in the segment that holds the summary is not compared; substring mode compares it', () => {
    const expected: ModelView = [{ role: 'summary', text: 'SUM' }, { role: 'user', text: ['next'], images: [] }];
    const injected: ModelView = [{ role: 'user', text: ['SUM and some injected model-visible text'], images: [] }, { role: 'user', text: ['next'], images: [] }];
    expect(compareViews(expected, injected, { summary: 'SUM' }).pass).toBe(true);
    expect(compareViews(expected, injected, { summary: 'SUM', summarySplit: 'substring' }).pass).toBe(false);
  });

  test('is_error counts only where the actual dialect carries it; call ids compare as ordinals', () => {
    const expected: ModelView = [{ role: 'assistant', text: [], calls: [{ id: 'a', name: 'bash', input: {} }] }, { role: 'tool', call_id: 'a', content: 'x', is_error: true }];
    const noChannel: ModelView = [{ role: 'assistant', text: [], calls: [{ id: 'other', name: 'bash', input: {} }] }, { role: 'tool', call_id: 'other', content: 'x' }];
    expect(compareViews(expected, noChannel).pass).toBe(true);
    const wrong: ModelView = [noChannel[0], { role: 'tool', call_id: 'other', content: 'x', is_error: false }];
    expect(compareViews(expected, wrong).pass).toBe(false);
  });

  test('tool input key order does not count (jsonb reorders keys, v1 `same`); values and array order do', () => {
    const call = (input: unknown): ModelView => [{ role: 'assistant', text: [], calls: [{ id: 'a', name: 'write', input }] }];
    const stored = call({ path: 'a.txt', content: 'x', opts: { mode: 1, flags: [{ b: 2, a: 1 }, 'z'] } });
    const sent = call({ content: 'x', opts: { flags: [{ a: 1, b: 2 }, 'z'], mode: 1 }, path: 'a.txt' });
    expect(compareViews(stored, sent).pass).toBe(true);
    expect(compareViews(stored, call({ content: 'y', opts: { flags: [{ a: 1, b: 2 }, 'z'], mode: 1 }, path: 'a.txt' })).pass).toBe(false);
    expect(compareViews(stored, call({ content: 'x', opts: { flags: ['z', { a: 1, b: 2 }], mode: 1 }, path: 'a.txt' })).pass).toBe(false);
  });
});
