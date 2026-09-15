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

test('tool results with an exact legacy assistant link become native tool parts',()=>{
 const assistant=row(2,'assistant',{content:'answer'});
 const tool=row(3,'tool',{role:'tool',content:'raw'}, {assistant_message_id:assistant.message_id,frontend_content:{tool_execution:{function_name:'legacy_search',arguments:{query:'bond'},result:{items:2}}}});
 const result=projectThread({ref,thread,rows:[row(1,'user',{content:'find bonds'}),assistant,tool],runtimeVersion:'1.18.23'});
 expect(result.audit.unresolved).toEqual([]);
 expect(result.audit.dispositions.find(x=>x.source_id===tool.message_id)?.disposition).toBe('native-tool-result-anchored');
 const part=result.runtime.messages[1]!.parts.find(x=>x.type==='tool')!;
 expect(part.tool).toBe('legacy_search');
 expect((part.state as any).output).toBe('{"items":2}');
 expect((part.state as any).metadata.legacy_source_message_id).toBe(tool.message_id);
});

test('legacy metadata tool results retain exact assistant links and result bytes',()=>{
 const assistant=row(2,'assistant',{role:'assistant',content:'answer',tool_calls:[]});
 const tool=row(3,'tool',{role:'tool',content:'raw'}, {assistant_message_id:assistant.message_id,function_name:'legacy_search',tool_call_id:'legacy-call',result:{items:2},return_format:'json'});
 const result=projectThread({ref,thread,rows:[row(1,'user',{content:'find bonds'}),assistant,tool],runtimeVersion:'1.18.23'});
 expect(result.audit.unresolved).toEqual([]);
 expect(result.audit.dispositions.find(x=>x.source_id===tool.message_id)?.disposition).toBe('native-tool-result-anchored');
 const part=result.runtime.messages[1]!.parts.find(x=>x.type==='tool')!;
 expect(part.callID).toBe('legacy-call');
 expect(part.tool).toBe('legacy_search');
 expect((part.state as any).output).toBe('{"items":2}');
 expect((part.state as any).input).toEqual({});
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

test('projects captured image bytes as a native file part and verifies their digest', () => {
  const bytes = Buffer.from('captured image bytes');
  const url = 'https://source.invalid/image.png';
  const rows = [row(1, 'user', { content: [{ type: 'image_url', image_url: { url } }] })];
  const attachment = { mime: 'image/png', filename: 'image.png', base64: bytes.toString('base64'), sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
  const result = projectThread({ ref, thread, rows, runtimeVersion: '1.18.23', attachments: { [url]: attachment } });
  expect(result.runtime.messages[0]!.parts[0]).toMatchObject({ type: 'file', mime: 'image/png', filename: 'image.png', url: 'data:image/png;base64,' + attachment.base64 });
  expect(result.audit.unresolved).toEqual([]);
  expect(() => projectThread({ ref, thread, rows, runtimeVersion: '1.18.23', attachments: { [url]: { ...attachment, sha256: '0'.repeat(64) } } })).toThrow('digest');
});

test('preserves an explicitly empty assistant message without inventing text', () => {
  const result = projectThread({ ref, thread, rows: [row(1, 'user', { content: 'hello' }), row(2, 'assistant', { role: 'assistant', content: null })], runtimeVersion: '1.18.23' });
  expect(result.runtime.messages[1]!.parts).toEqual([{ ...result.runtime.messages[1]!.parts[0], type: 'text', text: '' }]);
  expect(result.audit.unresolved).toEqual([]);
});


test('uses the legacy project title when the thread name is absent', () => {
  const t = { ...thread, project_id: 'legacy-project', name: null };
  const project = { project_id: 'legacy-project', name: 'Original project title' };
  const input = { ref, thread: t, project, rows: [], runtimeVersion: '1.18.23' };
  expect(projectThread(input).runtime.info.title).toBe('Original project title');
  expect(projectThread({ ...input, thread: { ...t, name: '  ' } }).runtime.info.title).toBe('Original project title');
  expect(projectThread({ ...input, thread: { ...t, name: 'Thread title' } }).runtime.info.title).toBe('Thread title');
  expect(() => projectThread({ ...input, project: { ...project, project_id: 'another-project' } })).toThrow('Project does not belong to thread');
});
