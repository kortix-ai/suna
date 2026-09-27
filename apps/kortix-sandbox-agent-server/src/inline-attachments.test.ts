import { describe, expect, test } from 'bun:test';

import { OFFLOAD_PLACEHOLDER_URL } from './harness/open-code/attachment-offload';
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

  test('a remote url is not a payload and is never touched, however long', () => {
    const remote = `https://files.example.test/${'a'.repeat(INLINE_ATTACHMENT_MAX_BYTES + 1)}.png`;
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'file', url: remote }]),
      ref,
    );

    expect((result.value as any)[0].parts[0].url).toBe(remote);
    expect(result.stripped).toBe(0);
  });

  test('only a file part is swapped, even when another part carries an oversized data url', () => {
    const result = stripInlineAttachmentBytes(
      messagePage([{ id: 'prt_1', type: 'text', text: 'hi', url: bigDataUrl }]),
      ref,
    );

    expect((result.value as any)[0].parts[0].url).toBe(bigDataUrl);
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

  // An attachment the offload moved to a sidecar keeps only a 1×1 placeholder
  // inline. A read through OpenCode's API drops the daemon's marker, so the
  // placeholder URL alone must still become an on-demand ref, however small.
  test('an offload placeholder becomes a ref even though it is tiny', () => {
    const result = stripInlineAttachmentBytes(
      messagePage([
        {
          type: 'tool',
          state: { attachments: [{ type: 'file', id: 'prt_att', mime: 'image/png', url: OFFLOAD_PLACEHOLDER_URL }] },
        },
      ]),
      ref,
    );
    expect(result.stripped).toBe(1);
    expect((result.value as any)[0].parts[0].state.attachments[0].url).toBe('/blob/msg_1/prt_att');
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
