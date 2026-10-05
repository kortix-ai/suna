import { expect, test } from 'bun:test';
import { abortable, abortableDelay } from './abort';

/** React Native (Hermes) has no global `DOMException`. */
async function withoutDomException(run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMException');
  Object.defineProperty(globalThis, 'DOMException', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'DOMException', original);
  }
}

test('abort helpers reject with an AbortError on hosts without DOMException', async () => {
  await withoutDomException(async () => {
    const controller = new AbortController();
    controller.abort();
    const delayed = await abortableDelay(1_000, controller.signal).catch((error: unknown) => error);
    const waited = await abortable(new Promise(() => {}), controller.signal).catch(
      (error: unknown) => error,
    );
    expect(delayed).toBeInstanceOf(Error);
    expect(delayed).toMatchObject({ name: 'AbortError' });
    expect(waited).toMatchObject({ name: 'AbortError' });
  });
});

test('abort helpers keep the DOMException shape where the host has one', async () => {
  const controller = new AbortController();
  controller.abort();
  const delayed = await abortableDelay(1_000, controller.signal).catch((error: unknown) => error);
  expect(delayed).toBeInstanceOf(DOMException);
  expect(delayed).toMatchObject({ name: 'AbortError' });
});
