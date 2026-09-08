import { afterEach, expect, test } from 'bun:test';
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import { usePromptAttachments } from './use-prompt-attachments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});
const metadata = {
  attachment_id: 'attachment-1',
  filename: 'a.txt',
  mime: 'text/plain',
  size: 3,
  expires_at: '2099-01-01T00:00:00Z',
};
let current!: ReturnType<typeof usePromptAttachments>;
function Composer({ projectId }: { projectId: string }) {
  current = usePromptAttachments(projectId);
  return null;
}

test('hook survives StrictMode, blocks immediate Send, and forget avoids upload on submit', async () => {
  let chunks = 0,
    deletes = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (_url, init) => {
      if (init?.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'PUT') {
        chunks++;
        return Response.json({ received_bytes: 3, size: 3 });
      }
      return Response.json({ ...metadata, chunk_size: 65536 });
    },
  });
  await act(async () => {
    renderer = create(createElement(StrictMode, {}, createElement(Composer, { projectId: 'p' })));
  });
  await act(async () => {
    current.add(new File(['abc'], 'a.txt'));
    expect(() => current.getReadyParts()).toThrow();
  });
  expect(current.canSend).toBe(true);
  expect(current.getReadyParts()[0]?.attachment_id).toBe('attachment-1');
  await act(async () => current.forget());
  expect(current.attachments).toHaveLength(0);
  expect({ chunks, deletes }).toEqual({ chunks: 1, deletes: 0 });
});

test('project switch aborts old pending work and cannot publish stale success', async () => {
  let signal: AbortSignal | null | undefined;
  let finish!: (response: Response) => void;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (_url, init) => {
      signal = init?.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await act(async () => {
    renderer = create(createElement(Composer, { projectId: 'old' }));
  });
  await act(async () => {
    current.add(new File(['abc'], 'a.txt'));
  });
  await act(async () => {
    renderer!.update(createElement(Composer, { projectId: 'new' }));
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ ...metadata, chunk_size: 65536 })));
  expect(current.attachments).toHaveLength(0);
});

test('unmount preserves completed storage objects', async () => {
  const methods: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (_url, init) => {
      methods.push(init?.method ?? '');
      return Response.json(metadata);
    },
  });
  await act(async () => {
    renderer = create(createElement(Composer, { projectId: 'p' }));
  });
  await act(async () => {
    current.restore(metadata);
  });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(methods).toEqual([]);
});
