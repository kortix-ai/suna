/**
 * Deterministic synthetic session for the transcript render benchmark.
 *
 * Everything here is pure and DOM-free, so it is importable from both the bench
 * script (`transcript-render.bench.ts`) and ordinary `bun test` files
 * (`fixture.test.ts`). Two calls with the same `BenchShape` produce
 * byte-identical data: fixed ids, fixed timestamps, fixed text, and image bytes
 * from a seeded xorshift32 PRNG.
 *
 * FIXED INPUTS (change = new baseline):
 * - Shape: T turns; each turn = 1 user message + 1 assistant message, so N = 2T.
 * - User message parts: 1 `text` part (`USER_PROMPT_TEXT` + turn index) and
 *   `images` file parts spread one per turn at every floor(T/images)-th turn
 *   (or all on the last turn when `imagesOnOneTurn` is set).
 * - Image part: `type: 'file'`, `mime: 'image/png'`, `url: data:image/png;base64,…`,
 *   payload `imageBytes` bytes (default 512 KiB) from xorshift32(seed 1). The bytes
 *   are not a decodable PNG — nothing decodes them in SSR or happy-dom.
 *   This is the ONLY path where image bytes sit inside the transcript data that
 *   is re-sorted and re-propagated per frame (composer attachments ride as
 *   data-URL file parts on the USER message; see uploaded-file-refs.ts).
 * - Assistant message parts, in order: 1 `text` (ASSISTANT_TEXT, 600 chars of
 *   markdown: one fenced code block, one 3-row table, one list), 1 `tool`
 *   bash (completed, 2 KiB output), 1 `tool` read (completed, 1 KiB output).
 *   With segmentTurn that is exactly: text, burst(bash, read).
 * - Ids: `msg_` + 12-hex counter (matches WIRE_DISPLAY_ID so sorting takes the
 *   placed-segment path); `prt_` + 12-hex counter, ascending across the whole
 *   session and across streaming steps (upsertPart binary-searches by id).
 * - `time.created` = BASE_EPOCH + index × 1000. `sessionID` constant.
 * - The LAST assistant message has no `time.completed` (it is the live one).
 *
 * STREAMING STEPS mirror `sync-store.ts` exactly: a step produces a new `parts`
 * array for ONE message, a new `{ info, parts }` wrapper for EVERY message (as
 * `buildSessionMessages` does), the same `info` / `parts` refs everywhere else,
 * and a new `messages` array.
 * - `appendTextPart` = `message.part.updated` (create): one new `text` part of
 *   APPEND_TEXT_CHARS chars on the last assistant message.
 * - `growTrailingText` = `message.part.delta`: the trailing text part of the last
 *   assistant message is replaced by a copy whose text is DELTA_CHARS longer.
 */
import {
  type AssistantMessage,
  type FilePart,
  type MessageWithParts,
  type Part,
  type TextPart,
  type ToolPart,
  type Turn,
  type UserMessage,
  groupMessagesIntoTurns,
} from '@/ui';

import { planAnchorMessageId } from '../turn/plan-anchor';
import { stabilizeTurns } from '../turn/stable-turns';

export const SESSION_ID = 'ses_bench000000';
export const BASE_EPOCH = 1_700_000_000_000;
export const PRNG_SEED = 1;
export const DEFAULT_IMAGE_BYTES = 512 * 1024;
export const APPEND_TEXT_CHARS = 80;
export const DELTA_CHARS = 40;
export const TOOL_OUTPUT_CHARS = 2048;
export const READ_OUTPUT_CHARS = 1024;

export const USER_PROMPT_TEXT =
  'Please refactor the session transcript so long sessions stay smooth.';

/** 600 chars of markdown: a fenced code block, a 3-row table, a list. */
export const ASSISTANT_TEXT = [
  'Here is the plan for the transcript refactor. It keeps every turn stable and',
  'moves the per-frame work to the single message that changed.',
  '',
  '```ts',
  'const turns = stabilizeTurns(groupMessagesIntoTurns(messages), prev);',
  'const anchor = planAnchorMessageId(messages);',
  '```',
  '',
  '| step | cost | note |',
  '| --- | --- | --- |',
  '| group | O(N log N) | copy + sort |',
  '| stabilize | O(N) | identity |',
  '| render | O(changed) | memo |',
  '',
  '- group once per frame',
  '- stabilize against the previous turns',
  '- render only the working turn',
  '',
  'Next: measure the append-one-part frame and the first render.',
].join('\n');

export interface BenchShape {
  /** Turns (user + assistant pairs). N = 2 × turns messages. */
  turns: number;
  /** Total image file parts across the session. */
  images: number;
  /** Bytes per image payload before base64. */
  imageBytes?: number;
  /** Put every image on the last turn (exercises ATTACHMENT_TILE_CAP). */
  imagesOnOneTurn?: boolean;
}

export interface BenchSession {
  shape: Required<BenchShape>;
  messages: MessageWithParts[];
  /** Next `prt_` counter value; streaming steps advance it. */
  nextPartIndex: number;
  /** Total base64 characters held in image parts. */
  imageChars: number;
}

function hex12(n: number): string {
  return n.toString(16).padStart(12, '0');
}

export function msgId(index: number): string {
  return `msg_${hex12(index)}`;
}

export function partId(index: number): string {
  return `prt_${hex12(index)}`;
}

/** xorshift32, seeded. Returns a generator of uint32 values. */
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** `bytes` random bytes from the PRNG, base64-encoded. */
export function seededBase64(next: () => number, bytes: number): string {
  const buf = new Uint8Array(bytes);
  const words = new Uint32Array(buf.buffer, 0, Math.floor(bytes / 4));
  for (let i = 0; i < words.length; i++) words[i] = next();
  for (let i = words.length * 4; i < bytes; i++) buf[i] = next() & 0xff;
  return Buffer.from(buf).toString('base64');
}

function fixedText(chars: number, seedChar: string): string {
  const line = `${seedChar} line of deterministic tool output for the transcript bench. `;
  let out = '';
  while (out.length < chars) out += line;
  return out.slice(0, chars);
}

const BASH_OUTPUT = fixedText(TOOL_OUTPUT_CHARS, 'bash');
const READ_OUTPUT = fixedText(READ_OUTPUT_CHARS, 'read');

function userInfo(index: number, msgIndex: number): UserMessage {
  return {
    id: msgId(msgIndex),
    sessionID: SESSION_ID,
    role: 'user',
    time: { created: BASE_EPOCH + msgIndex * 1000 },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  };
}

function assistantInfo(
  msgIndex: number,
  parentID: string,
  completed: boolean,
): AssistantMessage {
  const created = BASE_EPOCH + msgIndex * 1000;
  return {
    id: msgId(msgIndex),
    sessionID: SESSION_ID,
    role: 'assistant',
    time: completed ? { created, completed: created + 900 } : { created },
    parentID,
    modelID: 'claude-sonnet-4',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function textPart(id: string, messageID: string, text: string, start: number): TextPart {
  return { id, sessionID: SESSION_ID, messageID, type: 'text', text, time: { start, end: start + 100 } };
}

function filePart(id: string, messageID: string, k: number, b64: string): FilePart {
  return {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'file',
    mime: 'image/png',
    filename: `shot-${k}.png`,
    url: `data:image/png;base64,${b64}`,
  };
}

function toolPart(
  id: string,
  messageID: string,
  tool: 'bash' | 'read',
  start: number,
): ToolPart {
  const input =
    tool === 'bash'
      ? { command: 'ls -la /workspace/src', description: 'List source files' }
      : { filePath: '/workspace/src/index.ts' };
  return {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'tool',
    callID: `call_${id.slice(4)}`,
    tool,
    state: {
      status: 'completed',
      input,
      output: tool === 'bash' ? BASH_OUTPUT : READ_OUTPUT,
      title: tool === 'bash' ? 'ls -la /workspace/src' : '/workspace/src/index.ts',
      metadata: {},
      time: { start, end: start + 120 },
    },
  };
}

/** Which turns carry an image, and how many each. Spread = one per turn at every floor(T/M)-th turn. */
export function imagePlacement(shape: Required<BenchShape>): Map<number, number> {
  const out = new Map<number, number>();
  if (shape.images <= 0) return out;
  if (shape.imagesOnOneTurn) {
    out.set(shape.turns - 1, shape.images);
    return out;
  }
  const stride = Math.max(1, Math.floor(shape.turns / shape.images));
  let placed = 0;
  for (let t = 0; t < shape.turns && placed < shape.images; t += stride) {
    out.set(t, 1);
    placed++;
  }
  // More images than turns: stack the remainder on the last turn.
  if (placed < shape.images) {
    out.set(shape.turns - 1, (out.get(shape.turns - 1) ?? 0) + (shape.images - placed));
  }
  return out;
}

export function buildSession(input: BenchShape): BenchSession {
  const shape: Required<BenchShape> = {
    turns: input.turns,
    images: input.images,
    imageBytes: input.imageBytes ?? DEFAULT_IMAGE_BYTES,
    imagesOnOneTurn: input.imagesOnOneTurn ?? false,
  };
  const rng = xorshift32(PRNG_SEED);
  const placement = imagePlacement(shape);
  const messages: MessageWithParts[] = [];
  let part = 0;
  let imageChars = 0;
  let imageK = 0;

  for (let t = 0; t < shape.turns; t++) {
    const uIndex = 2 * t;
    const aIndex = 2 * t + 1;
    const user = userInfo(t, uIndex);
    const userParts: Part[] = [
      textPart(partId(part++), user.id, `${USER_PROMPT_TEXT} (turn ${t + 1})`, user.time.created),
    ];
    const imagesHere = placement.get(t) ?? 0;
    for (let i = 0; i < imagesHere; i++) {
      const b64 = seededBase64(rng, shape.imageBytes);
      imageChars += b64.length;
      userParts.push(filePart(partId(part++), user.id, imageK++, b64));
    }
    messages.push({ info: user, parts: userParts });

    const last = t === shape.turns - 1;
    const assistant = assistantInfo(aIndex, user.id, !last);
    const start = assistant.time.created;
    const assistantParts: Part[] = [
      textPart(partId(part++), assistant.id, ASSISTANT_TEXT, start),
      toolPart(partId(part++), assistant.id, 'bash', start + 100),
      toolPart(partId(part++), assistant.id, 'read', start + 300),
    ];
    messages.push({ info: assistant, parts: assistantParts });
  }

  return { shape, messages, nextPartIndex: part, imageChars };
}

/** New wrapper for every message (what `buildSessionMessages` does), same refs inside. */
function rewrap(messages: readonly MessageWithParts[]): MessageWithParts[] {
  const out = new Array<MessageWithParts>(messages.length);
  for (let i = 0; i < messages.length; i++) {
    out[i] = { info: messages[i].info, parts: messages[i].parts };
  }
  return out;
}

/** `message.part.updated` (create): append one text part to the last assistant message. */
export function appendTextPart(
  session: BenchSession,
  step: number,
): { session: BenchSession; changedMessageId: string } {
  const messages = rewrap(session.messages);
  const idx = messages.length - 1;
  const target = messages[idx];
  const id = partId(session.nextPartIndex);
  const text = fixedText(APPEND_TEXT_CHARS, `append-${step}`);
  const next = textPart(id, target.info.id, text, target.info.time.created + 1000 + step);
  messages[idx] = { info: target.info, parts: [...target.parts, next] };
  return {
    session: { ...session, messages, nextPartIndex: session.nextPartIndex + 1 },
    changedMessageId: target.info.id,
  };
}

/** `message.part.delta`: the trailing text part of the last assistant message grows by DELTA_CHARS. */
export function growTrailingText(
  session: BenchSession,
  step: number,
): { session: BenchSession; changedMessageId: string } {
  const messages = rewrap(session.messages);
  const idx = messages.length - 1;
  const target = messages[idx];
  let trailing = -1;
  for (let i = target.parts.length - 1; i >= 0; i--) {
    if (target.parts[i].type === 'text') {
      trailing = i;
      break;
    }
  }
  if (trailing < 0) throw new Error('growTrailingText: last assistant message has no text part');
  const old = target.parts[trailing] as TextPart;
  const grown: TextPart = { ...old, text: old.text + fixedText(DELTA_CHARS, `delta-${step}`) };
  const parts = target.parts.slice();
  parts[trailing] = grown;
  messages[idx] = { info: target.info, parts };
  return { session: { ...session, messages }, changedMessageId: target.info.id };
}

export interface PipelineFrame {
  turns: Turn[];
  planAnchorId: string | null;
  /** Turn objects in `turns` that are not the same object as in `prev`. */
  newTurnObjects: number;
}

/**
 * One frame of the host pipeline exactly as `session-chat.tsx` runs it:
 * `groupMessagesIntoTurns` → `stabilizeTurns(raw, prev)` → `planAnchorMessageId`.
 */
export function pipelineFrame(messages: readonly MessageWithParts[], prev: Turn[]): PipelineFrame {
  const raw = groupMessagesIntoTurns(messages) as Turn[];
  const turns = stabilizeTurns(raw, prev);
  const planAnchorId = planAnchorMessageId(messages);
  let newTurnObjects = 0;
  for (let i = 0; i < turns.length; i++) if (turns[i] !== prev[i]) newTurnObjects++;
  return { turns, planAnchorId, newTurnObjects };
}

/** FNV-1a over the structural content, for the determinism test. */
export function fingerprint(messages: readonly MessageWithParts[]): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const m of messages) {
    mix(JSON.stringify(m.info));
    for (const p of m.parts) {
      mix(p.id);
      mix(p.type);
      if (p.type === 'text') mix(p.text);
      if (p.type === 'file') {
        mix(p.url.length.toString());
        mix(p.url.slice(0, 64));
        mix(p.url.slice(-64));
      }
      if (p.type === 'tool') mix(JSON.stringify(p.state));
    }
  }
  return h.toString(16).padStart(8, '0');
}
