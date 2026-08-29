import { describe, expect, test } from 'bun:test';
import { RuntimeSurface } from './runtime-surface.ts';

const WIRE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

function restored() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: 1000 },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: 2000 },
    { role: 'user', content: [{ type: 'text', text: 'second question' }], timestamp: 3000 },
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], timestamp: 4000 },
  ];
}

// P1.8: one pi instance IS one session, so a box that comes back must come back
// with the same conversation. Before this, a restarted worker served an EMPTY
// /messages while the durable log held the whole transcript — the session
// answered with no memory of what had been said.
describe('RuntimeSurface.seedRestoredMessages', () => {
  test('rebuilds the transcript in order, with real wire ids', () => {
    const surface = new RuntimeSurface({ sessionId: 's', agentName: 'kortix' });
    expect(surface.seedRestoredMessages(restored())).toBe(4);

    const page = surface.transcript.page({ limit: 50, before: null });
    expect(page.messages.map((m) => m.info.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(page.messages.map((m) => m.parts.map((p: any) => p.text).join(''))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);

    // The id IS the transcript's sort key, and the web client splits on
    // /^msg_[0-9a-f]{12}/ — a non-conforming id sorts below the whole
    // transcript and every reply reattaches to the wrong question.
    const ids = page.messages.map((m) => m.info.id as string);
    for (const id of ids) expect(id).toMatch(WIRE_ID);
    expect(ids).toEqual([...ids].sort());
  });

  test('a reply minted after the restore sorts ABOVE the restored transcript', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    surface.seedRestoredMessages(restored());
    const ids = surface.transcript
      .page({ limit: 50, before: null })
      .messages.map((m) => m.info.id as string);
    // Otherwise the next answer lands back inside history.
    expect(surface.mintMessageId() > ids[ids.length - 1]).toBe(true);
  });

  test('skips a message with nothing renderable rather than showing an empty bubble', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seeded = surface.seedRestoredMessages([
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ]);
    expect(seeded).toBe(1);
    expect(surface.transcript.page({ limit: 10, before: null }).messages).toHaveLength(1);
  });

  test('history is not replayed onto the event bus', () => {
    // A reconnecting client already has these; republishing them would arrive
    // as a burst of "new" events for messages it is already showing.
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seen: string[] = [];
    surface.bus.subscribe((e: any) => seen.push(e.type), { since: null, epoch: null });
    surface.seedRestoredMessages(restored());
    expect(seen).toHaveLength(0);
  });
});

// Verbatim from the durable log of a real pi.kortix.com turn (session
// 3069ad04, "create number.txt containing 4417").
const toolTurn = [
  { role: 'user', content: [{ type: 'text', text: 'create number.txt with 4417' }], timestamp: 1 },
  {
    role: 'assistant',
    timestamp: 2,
    content: [
      {
        id: 'call_j4mbycnp9oK0SkGqZx39VeDn',
        name: 'write',
        type: 'toolCall',
        arguments: { path: 'number.txt', content: '4417' },
      },
    ],
  },
  {
    role: 'toolResult',
    timestamp: 3,
    isError: false,
    toolName: 'write',
    toolCallId: 'call_j4mbycnp9oK0SkGqZx39VeDn',
    content: [{ type: 'text', text: 'Successfully wrote 4 bytes to number.txt' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'SAVED' }], timestamp: 4 },
];

describe('RuntimeSurface.seedRestoredMessages — tool calls', () => {
  test('a call and its result restore as ONE completed tool part, not two bubbles', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    // 3 messages, not 4: the toolResult folds onto the call it answers.
    expect(surface.seedRestoredMessages(toolTurn)).toBe(3);

    const page = surface.transcript.page({ limit: 50, before: null });
    expect(page.messages).toHaveLength(3);
    const [, call, answer] = page.messages;

    const part = call!.parts[0] as any;
    expect(part.type).toBe('tool');
    expect(part.tool).toBe('write');
    expect(part.state.status).toBe('completed');
    expect(part.state.input).toEqual({ path: 'number.txt', content: '4417' });
    expect(part.state.output).toBe('Successfully wrote 4 bytes to number.txt');

    // The result text is NOT something the assistant said. Before this it was
    // seeded as its own text bubble and the write card vanished.
    expect(answer!.parts.map((p: any) => p.text).join('')).toBe('SAVED');
    expect(page.messages.some((m) => m.parts.some((p: any) => p.text?.startsWith('Successfully')))).toBe(
      false,
    );
  });

  test('a call whose result never came stays running — an interrupted turn is not a completed one', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    expect(surface.seedRestoredMessages(toolTurn.slice(0, 2))).toBe(2);
    const page = surface.transcript.page({ limit: 10, before: null });
    expect((page.messages[1]!.parts[0] as any).state.status).toBe('running');
  });

  test('an orphan result is dropped rather than shown as a bare string', () => {
    // Its call fell outside the restored window; alone it has nothing to attach to.
    const surface = new RuntimeSurface({ sessionId: 's' });
    expect(surface.seedRestoredMessages([toolTurn[2]!])).toBe(0);
    expect(surface.transcript.page({ limit: 10, before: null }).messages).toHaveLength(0);
  });
});
