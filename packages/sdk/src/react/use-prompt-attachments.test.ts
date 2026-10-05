import { afterEach, expect, spyOn, test } from 'bun:test';
import { createElement, StrictMode, useState } from 'react';
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

function createRenderer(element: Parameters<typeof create>[0]): ReactTestRenderer {
  const expectedWarning =
    'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer';
  const warnings: unknown[][] = [];
  const originalError = console.error;
  const capture = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.length === 1 && args[0] === expectedWarning) warnings.push(args);
    else originalError(...args);
  });
  try {
    return create(element);
  } finally {
    capture.mockRestore();
    expect(warnings).toEqual([[expectedWarning]]);
  }
}

test('hook survives StrictMode, waits for readiness, and forget avoids upload on submit', async () => {
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
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  await act(async () => {
    renderer = createRenderer(
      createElement(StrictMode, {}, createElement(Composer, { projectId: 'p' })),
    );
  });
  let id = '';
  let parts: Awaited<ReturnType<typeof current.whenReady>> | undefined;
  await act(async () => {
    id = current.add(new File(['abc'], 'a.txt'));
    const ready = current.whenReady([id]).then((value) => (parts = value));
    expect(parts).toBeUndefined();
    await ready;
  });
  expect(current.attachments[0]?.status).toBe('ready');
  expect(parts?.[0]?.attachment_id).toBe('attachment-1');
  await act(async () => current.forget());
  expect(current.attachments).toHaveLength(0);
  expect({ chunks, deletes }).toEqual({ chunks: 1, deletes: 0 });
});

test('hook result identity is stable across an unrelated re-render', async () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => new Promise<Response>(() => {}),
  });
  const seen: Array<ReturnType<typeof usePromptAttachments>> = [];
  let rerender!: () => void;
  function Parent() {
    const [, setTick] = useState(0);
    rerender = () => setTick((tick) => tick + 1);
    seen.push(usePromptAttachments('p'));
    return null;
  }
  await act(async () => {
    renderer = createRenderer(createElement(Parent));
  });
  const before = seen.length;
  await act(async () => rerender());
  expect(seen.length).toBeGreaterThan(before);
  expect(seen.at(-1)).toBe(seen[before - 1]);
  const result = seen.at(-1)!;
  // A host cannot brick the memoized controller or bypass the reactive snapshot.
  expect('dispose' in result).toBe(false);
  expect('subscribe' in result).toBe(false);
  expect('getSnapshot' in result).toBe(false);
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
    renderer = createRenderer(createElement(Composer, { projectId: 'old' }));
  });
  await act(async () => {
    current.add(new File(['abc'], 'a.txt'));
  });
  await act(async () => {
    renderer!.update(createElement(Composer, { projectId: 'new' }));
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } })));
  expect(current.attachments).toHaveLength(0);
});

test('unmount deletes a listed completed upload and keeps the one a send holds', async () => {
  const requests: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      const target = String(url);
      requests.push(`${init?.method} ${target}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      const complete = /\/attachments\/([^/]+)\/complete$/.exec(target);
      if (complete) return Response.json({ ...metadata, attachment_id: complete[1] });
      const { filename } = JSON.parse(String(init?.body)) as { filename: string };
      return Response.json({
        ...metadata,
        attachment_id: `server-${filename}`,
        upload: { kind: 'chunked', chunk_size: 65536 },
      });
    },
  });
  await act(async () => {
    renderer = createRenderer(createElement(Composer, { projectId: 'p' }));
  });
  let sent = '';
  await act(async () => {
    [, sent] = current.addMany([new File(['abc'], 'kept.txt'), new File(['abc'], 'sent.txt')]);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(current.attachments.map((item) => item.status)).toEqual(['ready', 'ready']);
  await act(async () => {
    current.submit([sent]);
  });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  // The hook disposes one microtask after unmount; the DELETE follows.
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A draft keeps no handle, so the listed upload can never be sent: it stops using the budget.
  expect(requests.filter((request) => request.startsWith('DELETE'))).toEqual([
    'DELETE https://api.test/projects/p/attachments/server-kept.txt',
  ]);
});
