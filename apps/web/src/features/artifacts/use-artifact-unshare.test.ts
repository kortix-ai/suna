import { afterEach, expect, test } from 'bun:test';
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useArtifactUnshare } from './use-artifact-unshare';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: ReactTestRenderer | undefined;
let dialog: ReturnType<typeof useArtifactUnshare>;
function Probe({ read }: { read?: () => Promise<number> }) {
  const value = useArtifactUnshare(read);
  useLayoutEffect(() => {
    dialog = value;
  });
  return null;
}
function mount(read?: () => Promise<number>) {
  act(() => {
    root = create(createElement(Probe, { read }));
  });
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
});

test('confirmation waits for the current comment count instead of a cached value', async () => {
  let complete!: (count: number) => void;
  mount(
    () =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = dialog.prepare();
  });
  expect(dialog.open).toBe(true);
  expect(dialog.status).toBe('loading');
  await act(async () => {
    complete(8);
    await pending;
  });
  expect(dialog.status).toBe('ready');
  expect(dialog.count).toBe(8);
});

test('a failed count stays unconfirmable until a fresh retry succeeds', async () => {
  let attempts = 0;
  mount(async () => {
    if (++attempts === 1) throw new Error('offline');
    return 3;
  });
  await act(async () => {
    await dialog.prepare();
  });
  expect(dialog.status).toBe('error');
  expect(dialog.open).toBe(true);
  await act(async () => {
    await dialog.prepare();
  });
  expect(dialog.status).toBe('ready');
  expect(dialog.count).toBe(3);
  expect(attempts).toBe(2);
});

test('closing ignores an older response after the dialog is reopened', async () => {
  const completions: Array<(count: number) => void> = [];
  mount(
    () =>
      new Promise<number>((resolve) => {
        completions.push(resolve);
      }),
  );
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = dialog.prepare();
    dialog.close();
    second = dialog.prepare();
  });
  await act(async () => {
    completions[1]!(4);
    await second;
  });
  await act(async () => {
    completions[0]!(2);
    await first;
  });
  expect(dialog.open).toBe(true);
  expect(dialog.status).toBe('ready');
  expect(dialog.count).toBe(4);
  act(() => dialog.close());
  expect(dialog.open).toBe(false);
});

test('comments disabled needs no count request and malformed counts fail closed', async () => {
  mount();
  await act(async () => {
    await dialog.prepare();
  });
  expect(dialog.status).toBe('ready');
  expect(dialog.count).toBe(0);
  act(() => {
    root!.update(createElement(Probe, { read: async () => Number.NaN }));
  });
  await act(async () => {
    await dialog.prepare();
  });
  expect(dialog.status).toBe('error');
});
