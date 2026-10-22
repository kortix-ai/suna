/**
 * `useComposerAttachments` re-renders its composer only when the file list or
 * an upload's phase changes (uploading, ready, failed). A progress tick
 * reaches only the tile, through the entry's `live` source.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type Item = { id: string; status: string; receivedBytes: number; size: number };

let snapshot: { attachments: Item[] } = { attachments: [] };
const listeners = new Set<() => void>();
const retried: string[] = [];
function publish(attachments: Item[]) {
  snapshot = { attachments };
  for (const listener of listeners) listener();
}
const controller = {
  add: () => 'u1',
  remove: async () => {},
  retry: (id: string) => retried.push(id),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,
  dispose() {},
  submit() {},
  whenReady: async () => [],
  reclaim() {},
  forget() {},
};

mock.module('@kortix/sdk', () => ({ createPromptAttachmentController: () => controller }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ error() {} }) }));
mock.module('@/lib/logger', () => ({ log: { warn() {}, log() {}, error() {} } }));
mock.module('@/lib/session/attachment-file', () => ({ toUploadFile: async () => ({}) }));

let useComposerAttachments: typeof import('./useComposerAttachments').useComposerAttachments;
let uploadPhaseKey: typeof import('./useComposerAttachments').uploadPhaseKey;
let hook: ReturnType<typeof useComposerAttachments>;
let renders = 0;
let tree: ReactTestRenderer | undefined;

function Host() {
  renders++;
  hook = useComposerAttachments('project-1');
  return null;
}

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ useComposerAttachments, uploadPhaseKey } = await import('./useComposerAttachments'));
});
beforeEach(() => {
  snapshot = { attachments: [] };
  listeners.clear();
  retried.length = 0;
  renders = 0;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

const file = { uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', isImage: true } as any;
const uploading = (receivedBytes: number): Item => ({ id: 'u1', status: 'uploading', receivedBytes, size: 100 });

test('a progress tick does not re-render the composer; the tile reads it from `live`', async () => {
  await act(async () => {
    tree = create(<Host />);
  });
  await act(async () => hook.add([file]));
  expect(hook.files[0]?.uploadId).toBe('u1');

  await act(async () => publish([uploading(10)]));
  const afterStart = renders;
  const entry = hook.uploads[0];
  expect(entry?.progress).toBe(10);
  expect(entry?.live?.getProgress()).toBe(10);

  await act(async () => publish([uploading(50)]));
  await act(async () => publish([uploading(80)]));
  expect(renders).toBe(afterStart);
  expect(hook.uploads[0]).toBe(entry);
  expect(entry?.live?.getProgress()).toBe(80);
});

test('a failure and a finished upload re-render the composer, and Retry retries that id', async () => {
  await act(async () => {
    tree = create(<Host />);
  });
  await act(async () => hook.add([file]));
  await act(async () => publish([uploading(10)]));

  const before = renders;
  await act(async () => publish([{ ...uploading(10), status: 'error' }]));
  expect(renders).toBeGreaterThan(before);
  expect(hook.uploads[0]?.failed).toBe(true);
  expect(hook.uploads[0]?.live).toBeUndefined();
  hook.uploads[0]?.onRetry?.();
  expect(retried).toEqual(['u1']);

  await act(async () => publish([{ ...uploading(100), status: 'ready' }]));
  expect(hook.uploads[0]).toBeUndefined();
});

test('a file still being read shows 0% without a live source', async () => {
  await act(async () => {
    tree = create(<Host />);
  });
  // `toUploadFile` has not resolved inside this act, so the file has no upload id yet.
  act(() => hook.add([file]));
  expect(hook.uploads[0]).toEqual({ progress: 0 });
  await act(async () => {});
});

test('uploadPhaseKey ignores progress and names each phase', () => {
  expect(uploadPhaseKey({ attachments: [uploading(10)] } as any)).toBe(uploadPhaseKey({ attachments: [uploading(90)] } as any));
  expect(uploadPhaseKey({ attachments: [uploading(10)] } as any)).toBe('u1:running');
  expect(uploadPhaseKey({ attachments: [{ ...uploading(0), status: 'processing' }] } as any)).toBe('u1:running');
  expect(uploadPhaseKey({ attachments: [{ ...uploading(0), status: 'aborted' }] } as any)).toBe('u1:failed');
  expect(uploadPhaseKey({ attachments: [{ ...uploading(100), status: 'ready' }] } as any)).toBe('u1:done');
  expect(uploadPhaseKey({ attachments: [] } as any)).toBe('');
});
