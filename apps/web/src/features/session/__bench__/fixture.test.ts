import { describe, expect, test } from 'bun:test';

import {
  APPEND_TEXT_CHARS,
  DELTA_CHARS,
  appendTextPart,
  buildSession,
  fingerprint,
  growTrailingText,
  imagePlacement,
  pipelineFrame,
} from './fixture';

/**
 * The pure half of the transcript benchmark, run on every `bun test`:
 * the synthetic session is deterministic, and one streaming step through the
 * real host pipeline (`groupMessagesIntoTurns` → `stabilizeTurns` →
 * `planAnchorMessageId`) yields exactly ONE new turn object. That identity
 * fact is what every memo boundary in `session-chat.tsx` stands on.
 *
 * The committing-renderer half (first render ms, append-one-part ms, rendered
 * turn counts) lives in `transcript-render.bench.ts`, which registers a DOM and
 * therefore runs as its own process — never inside the shared `bun test` one.
 */
describe('transcript bench fixture', () => {
  test('is deterministic: two builds of the same shape are byte-identical', () => {
    const a = buildSession({ turns: 10, images: 2, imageBytes: 8 * 1024 });
    const b = buildSession({ turns: 10, images: 2, imageBytes: 8 * 1024 });
    expect(fingerprint(a.messages)).toBe(fingerprint(b.messages));
    expect(a.messages.length).toBe(20);
    expect(a.imageChars).toBe(b.imageChars);
    // 8 KiB → 10924 base64 chars (no padding for a multiple of 3? 8192 % 3 = 2 → 10924 with '=' ).
    expect(a.imageChars).toBe(2 * Math.ceil(8192 / 3) * 4);
  });

  test('ids match the wire shape and ascend', () => {
    const s = buildSession({ turns: 3, images: 0 });
    for (const m of s.messages) expect(m.info.id).toMatch(/^msg_[0-9a-f]{12}$/);
    const partIds = s.messages.flatMap((m) => m.parts.map((p) => p.id));
    for (const id of partIds) expect(id).toMatch(/^prt_[0-9a-f]{12}$/);
    expect([...partIds].sort()).toEqual(partIds);
    // The last assistant message is live (no `completed`), every other one is settled.
    const assistants = s.messages.filter((m) => m.info.role === 'assistant');
    for (const m of assistants.slice(0, -1)) expect((m.info as any).time.completed).toBeNumber();
    expect((assistants.at(-1)!.info as any).time.completed).toBeUndefined();
  });

  test('images land on user messages as data-URL file parts, spread one per turn', () => {
    const s = buildSession({ turns: 10, images: 5, imageBytes: 3 * 1024 });
    const withImages = s.messages.filter((m) => m.parts.some((p) => p.type === 'file'));
    expect(withImages.length).toBe(5);
    for (const m of withImages) {
      expect(m.info.role).toBe('user');
      const file = m.parts.find((p) => p.type === 'file')!;
      expect(file.type === 'file' && file.mime).toBe('image/png');
      expect(file.type === 'file' && file.url.startsWith('data:image/png;base64,')).toBe(true);
    }
    expect([...imagePlacement({ turns: 10, images: 5, imageBytes: 1, imagesOnOneTurn: false }).keys()]).toEqual([0, 2, 4, 6, 8]);
    const one = buildSession({ turns: 4, images: 8, imageBytes: 1024, imagesOnOneTurn: true });
    const last = one.messages.at(-2)!;
    expect(last.info.role).toBe('user');
    expect(last.parts.filter((p) => p.type === 'file').length).toBe(8);
  });

  test('each turn segments as text + one burst (bash, read)', () => {
    const s = buildSession({ turns: 2, images: 0 });
    const { turns } = pipelineFrame(s.messages, []);
    expect(turns.length).toBe(2);
    for (const t of turns) {
      expect(t.assistantMessages.length).toBe(1);
      expect(t.assistantMessages[0].parts.map((p) => p.type)).toEqual(['text', 'tool', 'tool']);
    }
  });

  test('a streaming step changes ONE message and ONE turn object', () => {
    const s0 = buildSession({ turns: 10, images: 2, imageBytes: 4096 });
    const f0 = pipelineFrame(s0.messages, []);
    expect(f0.newTurnObjects).toBe(10);

    // b1: part.updated (create)
    const { session: s1, changedMessageId } = appendTextPart(s0, 1);
    expect(changedMessageId).toBe(s0.messages.at(-1)!.info.id);
    expect(s1.messages).not.toBe(s0.messages);
    for (let i = 0; i < s0.messages.length; i++) {
      // New wrapper object for every message (buildSessionMessages), same info ref.
      expect(s1.messages[i]).not.toBe(s0.messages[i]);
      expect(s1.messages[i].info).toBe(s0.messages[i].info);
      if (i < s0.messages.length - 1) expect(s1.messages[i].parts).toBe(s0.messages[i].parts);
    }
    expect(s1.messages.at(-1)!.parts.length).toBe(4);
    expect((s1.messages.at(-1)!.parts.at(-1) as any).text.length).toBe(APPEND_TEXT_CHARS);
    const f1 = pipelineFrame(s1.messages, f0.turns);
    expect(f1.newTurnObjects).toBe(1);
    expect(f1.turns.at(-1)).not.toBe(f0.turns.at(-1));
    for (let i = 0; i < 9; i++) expect(f1.turns[i]).toBe(f0.turns[i]);
    expect(f1.planAnchorId).toBe(f0.planAnchorId);

    // b2: part.delta
    const { session: s2 } = growTrailingText(s1, 1);
    const before = s1.messages.at(-1)!.parts.at(-1) as any;
    const after = s2.messages.at(-1)!.parts.at(-1) as any;
    expect(after.id).toBe(before.id);
    expect(after.text.length).toBe(before.text.length + DELTA_CHARS);
    const f2 = pipelineFrame(s2.messages, f1.turns);
    expect(f2.newTurnObjects).toBe(1);

    // Idempotent: the same messages again yield the SAME turns array.
    const f3 = pipelineFrame(s2.messages, f2.turns);
    expect(f3.turns).toBe(f2.turns);
    expect(f3.newTurnObjects).toBe(0);
  });
});
