import { expect, test } from 'bun:test';
import { afterPushCompletion } from './push-completion';

test('streams progress immediately and starts warming only after the upstream finishes', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let completed = 0;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const reader = afterPushCompletion(body, () => { completed++; }).getReader();
  controller.enqueue(new TextEncoder().encode('progress'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('progress');
  expect(completed).toBe(0);
  controller.enqueue(new TextEncoder().encode('accepted'));
  controller.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('accepted');
  expect((await reader.read()).done).toBe(true);
  expect(completed).toBe(1);
});

test('an upstream stream failure does not start warming', async () => {
  let completed = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('lost upstream')); } });
  await expect(new Response(afterPushCompletion(body, () => { completed = true; })).text()).rejects.toThrow('lost upstream');
  expect(completed).toBe(false);
});

test('client cancellation reaches the upstream and does not start warming', async () => {
  let canceled: unknown;
  let completed = false;
  const body = new ReadableStream<Uint8Array>({ cancel(reason) { canceled = reason; } });
  const reader = afterPushCompletion(body, () => { completed = true; }).getReader();
  await reader.cancel('client left');
  expect(canceled).toBe('client left');
  expect(completed).toBe(false);
});

test('artifact warming does not delay the completed push response', async () => {
  const release = Promise.withResolvers<void>();
  let started = false;
  let finished = false;
  try {
    const response = new Response(afterPushCompletion(new Response('accepted').body!, async () => {
      started = true;
      await release.promise;
      finished = true;
    }));
    expect(await response.text()).toBe('accepted');
    expect(started).toBe(true);
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
});
