import { describe, expect, test } from 'bun:test';

import { readRuntimeFileWithRetry } from './runtime-file-read';

describe('readRuntimeFileWithRetry', () => {
  test('recovers any file read from a transient HTML response', async () => {
    const expected = { content: 'hello', encoding: 'utf-8' };
    const delays: number[] = [];
    let attempts = 0;

    const result = await readRuntimeFileWithRetry(
      '/workspace/report.pdf',
      async () => {
        attempts += 1;
        if (attempts < 3) throw new SyntaxError("Unexpected token '<'");
        return expected;
      },
      async (delayMs) => {
        delays.push(delayMs);
      },
    );

    expect(result).toBe(expected);
    expect(attempts).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  test('stops after three automatic retries for ordinary files', async () => {
    let attempts = 0;

    await expect(
      readRuntimeFileWithRetry(
        '/workspace/report.txt',
        async () => {
          attempts += 1;
          throw new Error('Sandbox is starting');
        },
        async () => {},
      ),
    ).rejects.toThrow('Sandbox is starting');

    expect(attempts).toBe(4);
  });

  test('does not retry permanent file errors', async () => {
    const error = Object.assign(new Error('File not found'), { status: 404 });
    let attempts = 0;

    await expect(
      readRuntimeFileWithRetry(
        '/workspace/missing.docx',
        async () => {
          attempts += 1;
          throw error;
        },
        async () => {},
      ),
    ).rejects.toBe(error);

    expect(attempts).toBe(1);
  });

  test('uses the uploaded-file startup retry window for every file type', async () => {
    const expected = new Blob(['image']);
    const delays: number[] = [];
    let attempts = 0;

    const result = await readRuntimeFileWithRetry(
      '/workspace/uploads/image.png',
      async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error('Upload is still copying');
        return expected;
      },
      async (delayMs) => {
        delays.push(delayMs);
      },
    );

    expect(result).toBe(expected);
    expect(attempts).toBe(4);
    expect(delays).toEqual([2_000, 2_000, 2_000]);
  });

  test('stops scheduled retries when the caller aborts', async () => {
    const abortController = new AbortController();
    let attempts = 0;

    await expect(
      readRuntimeFileWithRetry(
        '/workspace/video.mp4',
        async () => {
          attempts += 1;
          throw new Error('Sandbox is starting');
        },
        async (_delayMs, signal) => {
          abortController.abort();
          signal?.throwIfAborted();
        },
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(attempts).toBe(1);
  });

  test('does not wait when a read finishes after cancellation', async () => {
    const abortController = new AbortController();
    let waits = 0;

    await expect(
      readRuntimeFileWithRetry(
        '/workspace/report.pdf',
        async () => {
          abortController.abort();
          throw new Error('Request failed after abort');
        },
        async (_delayMs, signal) => {
          waits += 1;
          signal?.throwIfAborted();
        },
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(waits).toBe(1);
  });

  test('rejects a successful read that resolves after cancellation', async () => {
    const abortController = new AbortController();

    await expect(
      readRuntimeFileWithRetry(
        '/workspace/report.pdf',
        async () => {
          abortController.abort();
          return 'stale data';
        },
        async () => {},
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
