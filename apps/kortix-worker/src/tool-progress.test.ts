import { expect, test } from 'bun:test';
import { ChatEventAdapter } from './chat-events';
import { RuntimeSurface } from './runtime-surface';

function fixture() {
  const surface = new RuntimeSurface({ sessionId: 'progress' });
  const adapter = new ChatEventAdapter({ sessionID: surface.rootId, messageId: () => 'msg_progress', now: () => 123 });
  const emit = (event: any) => {
    const frames = adapter.translate(event);
    for (const frame of frames) surface.publishWire(frame);
    return frames;
  };
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'progress', args: { job: 'first' } });
  const part = () => surface.transcript.messageById('msg_progress')!.parts.find(p => p.type === 'tool') as any;
  return { emit, part, surface };
}

test('running tool snapshots stream text and details without appending duplicate output', () => {
  const f = fixture();
  const states: any[] = [];
  f.surface.bus.subscribe(event => { states.push((event.payload as any).part.state); }, { since: null, epoch: null });
  for (const output of ['first', 'first\nsecond', '']) {
    f.emit({ type: 'tool_execution_update', toolCallId: 'call_1', partialResult: {
      content: [{ type: 'text', text: output }], details: { progress: 50, output: 'must not override content' },
    } });
    expect(f.part().state).toEqual({ status: 'running', input: { job: 'first' }, metadata: { progress: 50, output }, time: { start: 123 } });
  }
  expect(states.map(state => state.metadata.output)).toEqual(['first', 'first\nsecond', '']);
});

test('a finished tool ignores late progress and retains final output and timing', () => {
  const f = fixture();
  f.emit({ type: 'tool_execution_end', toolCallId: 'call_1', result: { content: [{ type: 'text', text: 'final' }], details: { done: true } }, isError: false });
  const settled = structuredClone(f.part());
  expect(f.emit({ type: 'tool_execution_update', toolCallId: 'call_1', partialResult: { content: [{ type: 'text', text: 'late' }] } })).toEqual([]);
  expect(f.part()).toEqual(settled);
});

test('a failed tool ignores late progress and retains its terminal error', () => {
  const f = fixture();
  f.emit({ type: 'tool_execution_end', toolCallId: 'call_1', result: { content: [{ type: 'text', text: 'cancelled' }] }, isError: true });
  expect(f.emit({ type: 'tool_execution_update', toolCallId: 'call_1', partialResult: { content: [{ type: 'text', text: 'late' }] } })).toEqual([]);
  expect(f.part().state).toMatchObject({ status: 'error', error: 'cancelled' });
});

test('progress includes only text content and remains scoped to the executing call', () => {
  const f = fixture();
  expect(f.emit({ type: 'tool_execution_update', toolCallId: 'unknown', partialResult: {} })).toEqual([]);
  f.emit({ type: 'tool_execution_update', toolCallId: 'call_1', partialResult: {
    content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'private-binary', mimeType: 'image/png' }, { type: 'text', text: 'two' }],
    details: null,
  } });
  expect(f.part().state.metadata).toEqual({ output: 'onetwo' });
  expect(JSON.stringify(f.part())).not.toContain('private-binary');
});
