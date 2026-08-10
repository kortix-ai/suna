import { fileReadRetryDelayMs, shouldRetryFileRead } from '@/features/files/hooks/file-read-retry';

type RuntimeFileRead<T> = (signal?: AbortSignal) => Promise<T>;
type Wait = (delayMs: number, signal?: AbortSignal) => Promise<void>;

const wait: Wait = (delayMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export async function readRuntimeFileWithRetry<T>(
  filePath: string,
  read: RuntimeFileRead<T>,
  waitForRetry: Wait = wait,
  signal?: AbortSignal,
): Promise<T> {
  let failureCount = 0;

  while (true) {
    signal?.throwIfAborted();
    try {
      const result = await read(signal);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (!shouldRetryFileRead(filePath, failureCount, error)) throw error;
      await waitForRetry(fileReadRetryDelayMs(failureCount, filePath), signal);
      failureCount += 1;
    }
  }
}
