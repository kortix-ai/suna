import { expect, test } from 'bun:test';
import { captureDocComment } from './doc-comment-capture';

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('selection capture starts synchronously and publishes before its finisher', async () => {
  const snapshot = pending<string | undefined>();
  const events: string[] = [];
  const operation = captureDocComment(() => { events.push('start'); return () => events.push('finish'); }, () => snapshot.promise, (anchor) => events.push(anchor));
  expect(events).toEqual(['start']);
  snapshot.resolve('anchor');
  await operation.done;
  expect(events).toEqual(['start', 'anchor', 'finish']);
  operation.cancel();
  expect(events).toEqual(['start', 'anchor', 'finish']);
});

test('save or snapshot failure always finishes once without publishing an anchor', async () => {
  for (const reason of ['save', 'snapshot']) {
    const events: string[] = [];
    const operation = captureDocComment(() => { events.push('start'); return () => events.push('finish'); }, async () => { throw new Error(reason); }, () => events.push('anchor'));
    await expect(operation.done).rejects.toThrow(reason);
    operation.cancel();
    expect(events).toEqual(['start', 'finish']);
  }
});

test('selection changes finish without publishing and cancellation blocks a late snapshot', async () => {
  const events: string[] = [];
  const changed = captureDocComment(() => { events.push('start'); return () => events.push('finish'); }, async () => undefined, () => events.push('anchor'));
  await changed.done;
  expect(events).toEqual(['start', 'finish']);
  const snapshot = pending<string | undefined>();
  const cancelled = captureDocComment(() => { events.push('start'); return () => events.push('finish'); }, () => snapshot.promise, () => events.push('anchor'));
  cancelled.cancel();
  cancelled.cancel();
  expect(events).toEqual(['start', 'finish', 'start', 'finish']);
  snapshot.resolve('stale anchor');
  await cancelled.done;
  expect(events).toEqual(['start', 'finish', 'start', 'finish']);
});

test('unsupported selection intent clears the prior anchor before preflight and finishes without publishing', async () => {
  let previousAnchor: string | null = 'previous selection';
  const events: string[] = [];
  const operation = captureDocComment(() => {
    previousAnchor = null;
    events.push('start');
    return () => events.push('finish');
  }, async () => {
    expect(previousAnchor).toBeNull();
    events.push('preflight');
    return undefined;
  }, () => events.push('publish'));
  expect(events).toEqual(['start', 'preflight']);
  await operation.done;
  expect(events).toEqual(['start', 'preflight', 'finish']);
});

test('unmount finishes immediately even when the pending request later rejects', async () => {
  const snapshot = pending<string | undefined>();
  let finishes = 0;
  let publishes = 0;
  const operation = captureDocComment(() => () => { finishes++; }, () => snapshot.promise, () => { publishes++; });
  operation.cancel();
  expect(finishes).toBe(1);
  snapshot.reject(new Error('request failed after unmount'));
  await expect(operation.done).rejects.toThrow('request failed after unmount');
  expect(finishes).toBe(1);
  expect(publishes).toBe(0);
});

test('a publish failure still finishes and an optional lifecycle keeps capture usable', async () => {
  let finishes = 0;
  const failed = captureDocComment(() => () => { finishes++; }, async () => 'anchor', () => { throw new Error('publish failed'); });
  await expect(failed.done).rejects.toThrow('publish failed');
  expect(finishes).toBe(1);
  const anchors: string[] = [];
  await captureDocComment(undefined, async () => 'anchor', (value) => anchors.push(value)).done;
  expect(anchors).toEqual(['anchor']);
});
