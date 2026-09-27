import { describe, expect, test } from 'bun:test';

import { readLocalBlob, toUploadFile } from './attachment-file';
import type { AttachedFile } from './attachments';

function stubRead(bytes: number[], mimeType = 'image/jpeg') {
  return async (_uri: string) => new Blob([new Uint8Array(bytes)], { type: mimeType });
}

const picked: AttachedFile = {
  uri: 'file:///cache/photo_1.jpg',
  name: 'photo_1.jpg',
  mimeType: 'image/jpeg',
  isImage: true,
};

describe('toUploadFile', () => {
  test('keeps the picked name and mime type', async () => {
    const file = await toUploadFile(picked, stubRead([1, 2, 3]));
    expect(file.name).toBe('photo_1.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(3);
  });

  test('falls back to application/octet-stream', async () => {
    const file = await toUploadFile({ ...picked, mimeType: '' }, stubRead([1, 2, 3], ''));
    expect(file.type).toBe('application/octet-stream');
  });

  test('rejects an empty file', async () => {
    await expect(toUploadFile(picked, stubRead([]))).rejects.toThrow(/photo_1\.jpg/);
  });
});

/** A fake XMLHttpRequest that answers the way React Native's does for a local URI. */
function fakeXhr(outcome: { status: number; response?: Blob } | 'error') {
  const opened: { method?: string; url?: string; responseType?: string } = {};
  class FakeXhr {
    responseType = '';
    status = 0;
    response: Blob | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(method: string, url: string) {
      opened.method = method;
      opened.url = url;
    }
    send() {
      opened.responseType = this.responseType;
      queueMicrotask(() => {
        if (outcome === 'error') return this.onerror?.();
        this.status = outcome.status;
        this.response = outcome.response ?? null;
        this.onload?.();
      });
    }
  }
  return { Xhr: FakeXhr as unknown as typeof XMLHttpRequest, opened };
}

describe('readLocalBlob', () => {
  test('reads the URI as a blob with GET', async () => {
    const body = new Blob([new Uint8Array([1, 2])]);
    const { Xhr, opened } = fakeXhr({ status: 0, response: body });
    const blob = await readLocalBlob('content://media/photo_1', Xhr);
    expect(blob).toBe(body);
    expect(opened).toEqual({ method: 'GET', url: 'content://media/photo_1', responseType: 'blob' });
  });

  test('accepts a 200 answer', async () => {
    const body = new Blob([new Uint8Array([1])]);
    const { Xhr } = fakeXhr({ status: 200, response: body });
    expect(await readLocalBlob('file:///cache/photo_1.jpg', Xhr)).toBe(body);
  });

  test('rejects a network error', async () => {
    const { Xhr } = fakeXhr('error');
    await expect(readLocalBlob('file:///cache/photo_1.jpg', Xhr)).rejects.toThrow(/Couldn't read/);
  });

  test('rejects an HTTP error status', async () => {
    const { Xhr } = fakeXhr({ status: 404 });
    await expect(readLocalBlob('file:///cache/photo_1.jpg', Xhr)).rejects.toThrow(/404/);
  });
});
