import { describe, expect, test } from 'bun:test';

import {
  INLINE_ATTACHMENT_MAX_BYTES,
  stripInlineAttachmentBytes,
} from './inline-attachments';

const ref = (m: string, p: string) => `/blob/${m}/${p}`;
const bigDataUrl = `data:image/jpeg;base64,${'A'.repeat(INLINE_ATTACHMENT_MAX_BYTES + 1)}`;

function messagePage(parts: unknown[]) {
  return [{ info: { id: 'msg_1', role: 'assistant' }, parts }];
}

describe('stripInlineAttachmentBytes', () => {
  test('swaps an oversized data url for a reference and reports the saving', () => {
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'file', mime: 'image/jpeg', url: bigDataUrl }]),
      ref,
    );

    const part = (result.value as any)[0].parts[0];
    expect(part.url).toBe('/blob/msg_1/prt_1');
    expect(result.stripped).toBe(1);
    expect(result.savedBytes).toBe(bigDataUrl.length);
  });

  test('keeps everything else about the part — type, mime, filename, id', () => {
    const result = stripInlineAttachmentBytes(
      messagePage([
        { id: 'prt_1', type: 'file', mime: 'image/png', filename: 'shot.png', url: bigDataUrl },
      ]),
      ref,
    );

    expect((result.value as any)[0].parts[0]).toEqual({
      id: 'prt_1',
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      url: '/blob/msg_1/prt_1',
    });
  });

  test('a small data url is left inline — a round trip would cost more', () => {
    const small = 'data:image/gif;base64,R0lGOD';
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'file', url: small }]),
      ref,
    );

    expect((result.value as any)[0].parts[0].url).toBe(small);
    expect(result.stripped).toBe(0);
  });

  test('a remote url is not a payload and is never touched', () => {
    const remote = 'https://files.example.test/a.png';
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'file', url: remote }]),
      ref,
    );

    expect((result.value as any)[0].parts[0].url).toBe(remote);
    expect(result.stripped).toBe(0);
  });

  test('text parts are untouched however large', () => {
    const text = 'x'.repeat(INLINE_ATTACHMENT_MAX_BYTES * 2);
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'text', text }]),
      ref,
    );

    expect((result.value as any)[0].parts[0].text).toBe(text);
    expect(result.stripped).toBe(0);
  });

  test('strips across many messages and reports the total', () => {
    const page = [
      { info: { id: 'msg_1' }, parts: [{ id: 'p1', type: 'file', url: bigDataUrl }] },
      { info: { id: 'msg_2' }, parts: [{ id: 'p2', type: 'file', url: bigDataUrl }] },
    ];
    const result = stripInlineAttachmentBytes(page, ref);

    expect((result.value as any)[0].parts[0].url).toBe('/blob/msg_1/p1');
    expect((result.value as any)[1].parts[0].url).toBe('/blob/msg_2/p2');
    expect(result.stripped).toBe(2);
    expect(result.savedBytes).toBe(bigDataUrl.length * 2);
  });

  test('a v2-style envelope is handled too', () => {
    const result = stripInlineAttachmentBytes(
      { data: messagePage([{ id: 'prt_1', type: 'file', url: bigDataUrl }]), cursor: {} },
      ref,
    );
    expect((result.value as any).data[0].parts[0].url).toBe('/blob/msg_1/prt_1');
  });

  /**
   * This runs in the proxy for EVERY response on the message path. An unknown
   * or malformed payload must come back unchanged, never mangled and never
   * thrown on.
   */
  test('an unrecognised payload survives untouched', () => {
    for (const payload of [null, 42, 'hello', [], {}, { weird: [1, 2, 3] }]) {
      const result = stripInlineAttachmentBytes(payload, ref);
      expect(result.value).toEqual(payload as never);
      expect(result.stripped).toBe(0);
    }
  });

  test('a file part with no id cannot be referenced, so it is left alone', () => {
    const result = stripInlineAttachmentBytes(
      messagePage([{ type: 'file', url: bigDataUrl }]),
      ref,
    );
    expect((result.value as any)[0].parts[0].url).toBe(bigDataUrl);
    expect(result.stripped).toBe(0);
  });
});
