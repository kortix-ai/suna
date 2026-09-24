import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '../opencode/types';
import type { AttachedFile } from './attachments';
import { firstPromptSeed, SEED_BUSY_WATCHDOG_MS, seedUndelivered } from './first-prompt-seed';
import { mintWireMessageId } from './wire-message-id';

const ROOT = 'ses_opencode_root';
const NOW = 1755500000000;
const PHOTO: AttachedFile = {
  uri: 'file:///cache/photo_1.jpg',
  name: 'photo_1.jpg',
  mimeType: 'image/jpeg',
  isImage: true,
};

function seed(i: Partial<Parameters<typeof firstPromptSeed>[0]> = {}) {
  return firstPromptSeed({
    text: 'hello',
    files: [],
    opencodeSessionId: ROOT,
    knownMessageIds: [],
    nowMs: NOW,
    ...i,
  });
}

function msg(id: string, role: 'user' | 'assistant'): MessageWithParts {
  return { info: { id, role, sessionID: ROOT, time: { created: NOW } }, parts: [] };
}

describe('firstPromptSeed', () => {
  test('returns null for empty text and no files', () => {
    expect(seed({ text: '   ', files: [] })).toBeNull();
  });

  test('returns null when the store already holds messages for the root', () => {
    expect(seed({ knownMessageIds: ['msg_8bbf25e40000AAAAAAAAAAAAAA'] })).toBeNull();
  });

  test('text seeds one user message under the OpenCode root with one prt_ text part', () => {
    const result = seed({ text: 'hello' })!;
    expect(result.info.role).toBe('user');
    expect(result.info.sessionID).toBe(ROOT);
    expect(result.info.time.created).toBe(NOW);
    expect(result.info.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(result.parts[0].id.startsWith('prt_')).toBe(true);
  });

  test('image only seeds one file part with the local uri', () => {
    const result = seed({ text: '', files: [PHOTO] })!;
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0] as { type: string; id: string; localUri?: string; mime?: string; filename?: string };
    expect(part.type).toBe('file');
    expect(part.localUri).toBe('file:///cache/photo_1.jpg');
    expect(part.mime).toBe('image/jpeg');
    expect(part.filename).toBe('photo_1.jpg');
    expect(part.id.startsWith('prt_')).toBe(true);
  });

  test('text and two files give three parts with distinct ids, text first', () => {
    const result = seed({ text: 'look', files: [PHOTO, { ...PHOTO, uri: 'file:///cache/b.pdf', name: 'b.pdf' }] })!;
    expect(result.parts.map((p) => p.type)).toEqual(['text', 'file', 'file']);
    expect(new Set(result.parts.map((p) => p.id)).size).toBe(3);
  });

  test('seed id sorts after known ids', () => {
    // A non-empty `knownMessageIds` returns null (the store already holds the
    // root), so "known" here is an id minted earlier elsewhere, 1 s before.
    const known = mintWireMessageId({ nowMs: NOW - 1_000, knownMessageIds: [] });
    const result = seed({ nowMs: NOW })!;
    expect(result.info.id > known).toBe(true);
  });
});

describe('seedUndelivered', () => {
  const SEED_ID = 'msg_seed';

  test('seedUndelivered is true for [seed] and [] and false once an assistant or real user message exists', () => {
    expect(seedUndelivered([msg(SEED_ID, 'user')], SEED_ID)).toBe(true);
    expect(seedUndelivered([], SEED_ID)).toBe(true);
    expect(seedUndelivered(undefined, SEED_ID)).toBe(true);
    expect(seedUndelivered([msg(SEED_ID, 'user'), msg('msg_a', 'assistant')], SEED_ID)).toBe(false);
    expect(seedUndelivered([msg('msg_real', 'user')], SEED_ID)).toBe(false);
  });

  test('the watchdog waits 30 s', () => {
    expect(SEED_BUSY_WATCHDOG_MS).toBe(30_000);
  });
});
