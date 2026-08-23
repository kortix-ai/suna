import { describe, expect, test } from 'bun:test';
import {
  IDB_FLUSH_INTERVAL_LARGE_MS,
  IDB_FLUSH_INTERVAL_MS,
  IDB_LARGE_TRANSCRIPT_MESSAGES,
  idbFlushIntervalMs,
  transcriptSignature,
} from './idb-write-policy';

const msg = (id: string) => ({ id });

describe('idbFlushIntervalMs', () => {
  test('an ordinary session keeps the original cadence', () => {
    expect(idbFlushIntervalMs(0)).toBe(IDB_FLUSH_INTERVAL_MS);
    expect(idbFlushIntervalMs(IDB_LARGE_TRANSCRIPT_MESSAGES - 1)).toBe(IDB_FLUSH_INTERVAL_MS);
  });

  test('a large transcript writes less often — the clone is the expense', () => {
    expect(idbFlushIntervalMs(IDB_LARGE_TRANSCRIPT_MESSAGES)).toBe(IDB_FLUSH_INTERVAL_LARGE_MS);
    expect(idbFlushIntervalMs(5_000)).toBe(IDB_FLUSH_INTERVAL_LARGE_MS);
  });
});

describe('transcriptSignature', () => {
  test('identical transcripts share a signature — that write can be skipped', () => {
    const messages = [msg('a'), msg('b')];
    const parts = { a: [1], b: [1, 2] };
    expect(transcriptSignature(messages, parts)).toBe(transcriptSignature([...messages], { ...parts }));
  });

  test('a streamed part on the tail moves it', () => {
    const messages = [msg('a'), msg('b')];
    expect(transcriptSignature(messages, { a: [1], b: [1] })).not.toBe(
      transcriptSignature(messages, { a: [1], b: [1, 2] }),
    );
  });

  test('a new message moves it', () => {
    expect(transcriptSignature([msg('a')], { a: [1] })).not.toBe(
      transcriptSignature([msg('a'), msg('b')], { a: [1] }),
    );
  });

  test('a rewind that removes messages moves it', () => {
    expect(transcriptSignature([msg('a'), msg('b')], { a: [1], b: [1] })).not.toBe(
      transcriptSignature([msg('a')], { a: [1] }),
    );
  });

  test('a different tail with the same counts still moves it', () => {
    expect(transcriptSignature([msg('a'), msg('b')], { a: [1], b: [1] })).not.toBe(
      transcriptSignature([msg('a'), msg('c')], { a: [1], c: [1] }),
    );
  });

  test('never touches the payload — a message with no id or no parts is safe', () => {
    expect(() =>
      transcriptSignature([{ id: undefined }, msg('a')] as Array<{ id?: string }>, {}),
    ).not.toThrow();
  });
});
