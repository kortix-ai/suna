import { expect, test } from 'bun:test';

import { createHeldSendGuard } from './held-send-guard';

function unloadIsBlocked(target: EventTarget): boolean {
  return !target.dispatchEvent(new Event('beforeunload', { cancelable: true }));
}

test('beforeunload warns only while at least one held send exists', async () => {
  const target = new EventTarget();
  const hold = createHeldSendGuard(target);
  expect(unloadIsBlocked(target)).toBe(false);

  let finishFirst!: () => void;
  let failSecond!: (error: Error) => void;
  const first = hold(new Promise<void>((resolve) => (finishFirst = resolve)));
  const second = hold(new Promise<void>((_resolve, reject) => (failSecond = reject)));
  expect(unloadIsBlocked(target)).toBe(true);

  finishFirst();
  await first;
  expect(unloadIsBlocked(target)).toBe(true);

  failSecond(new Error('upload failed'));
  await expect(second).rejects.toThrow('upload failed');
  expect(unloadIsBlocked(target)).toBe(false);
});

test('a host without a window holds nothing and returns the work unchanged', async () => {
  const hold = createHeldSendGuard(undefined);
  await expect(hold(Promise.resolve('sent'))).resolves.toBe('sent');
});
