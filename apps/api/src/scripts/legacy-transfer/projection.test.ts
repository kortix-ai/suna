import { expect, test } from 'bun:test';
import { projectThread } from './projection';

const ref = 'abcdefghijklmnopqrst';
const thread = { thread_id: '11111111-1111-4111-8111-111111111111', name: 'Original title', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:01:00Z' };
const row = (n: number, type: string, content: unknown, metadata = {}) => ({ message_id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`, thread_id: thread.thread_id, type, content, metadata, created_at: '2025-01-01T00:00:00Z' });

test('accounts for every record and preserves text, reasoning, and tool results', () => {
  const rows = [row(1, 'user', { content: 'Original question' }), row(2, 'assistant', { content: 'Answer', thinking_blocks: [{ thinking: 'Reasoning' }], tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{"path":"a"}' } }] }), row(3, 'tool', { tool_call_id: 'call', content: 'Exact output' }), row(4, 'status', { status_type: 'running' }), row(5, 'task_list', { todos: ['original'] })];
  const result = projectThread({ ref, thread, rows, runtimeVersion: '1.18.23' });
  expect(result.audit.dispositions).toHaveLength(5);
  expect(result.audit.unresolved).toEqual([]);
  expect(result.runtime.info.title).toBe('Original title');
  expect(result.runtime.messages[1]!.parts.find(p => p.type === 'reasoning')!.text).toBe('Reasoning');
  expect((result.runtime.messages[1]!.parts.find(p => p.type === 'tool')!.state as any).output).toBe('Exact output');
  expect(result.audit.dispositions.filter(d => d.disposition === 'raw-archive-event')).toHaveLength(2);
  expect(result.audit.ready_for_apply).toBe(false);
});

test('IDs preserve equal-timestamp ordering and survive later inserted records', () => {
  const rows = [row(2, 'user', { content: 'second' }), row(1, 'user', { content: 'first' })];
  const first = projectThread({ ref, thread, rows, runtimeVersion: '1.18.23' });
  const second = projectThread({ ref, thread, rows: [...rows, row(3, 'assistant', { content: 'third' })], runtimeVersion: '1.18.23' });
  const ids = first.runtime.messages.map(m => m.info.id);
  expect(ids).toEqual([...ids].sort());
  expect(second.runtime.messages.slice(0, 2).map(m => m.info.id)).toEqual(ids);
});

test('ambiguous tool IDs stay in the archive and block readiness', () => {
  const rows = [row(1, 'user', { content: 'hi' }), row(2, 'assistant', { tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{}' } }] }), row(3, 'tool', { tool_call_id: 'call', content: 'a' }), row(4, 'tool', { tool_call_id: 'call', content: 'b' })];
  const result = projectThread({ ref, thread, rows, runtimeVersion: '1.18.23' });
  expect(result.audit.unresolved).toHaveLength(2);
  expect(result.audit.dispositions).toHaveLength(4);
});

test('unknown content blocks are retained and flagged rather than discarded', () => {
  const result = projectThread({ ref, thread, rows: [row(1, 'user', { content: [{ type: 'image_url', image_url: { url: 'https://source.invalid/a.png' } }] })], runtimeVersion: '1.18.23' });
  expect(result.runtime.messages[0]!.parts[0]!.text).toContain('https://source.invalid/a.png');
  expect(result.audit.unresolved).toHaveLength(1);
});

test('invalid timestamps and duplicate source IDs fail', () => {
  const good = row(1, 'user', { content: 'hi' });
  expect(() => projectThread({ ref, thread, rows: [{ ...good, created_at: 'bad' }], runtimeVersion: '1.18.23' })).toThrow('timestamp');
  expect(() => projectThread({ ref, thread, rows: [good, good], runtimeVersion: '1.18.23' })).toThrow('Duplicate');
});
