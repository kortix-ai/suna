import { expect, test } from 'bun:test';

import { RUNTIME_PROMPT_CHUNK_BYTES, writeRuntimePromptFile } from './runtime-prompt-file';

const input = {
  externalId: 'sbx_1',
  sessionId: 'session_1',
  userId: 'user_1',
  targetPath: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
  filename: 'bundle.zip',
  mime: 'application/zip',
  bytes: new Uint8Array([80, 75, 3, 4]),
};

test('uploads to a temporary path and renames the returned path over the deterministic target', async () => {
  const requests: Array<{ method: string; path: string; body: ArrayBuffer }> = [];
  const result = await writeRuntimePromptFile(
    input,
    async (_externalId, _port, _access, method, path, _query, _headers, body) => {
      requests.push({ method, path, body: body ?? new ArrayBuffer(0) });
      if (path === '/file/upload') {
        return Response.json([
          {
            path: '/workspace/uploads/.kortix-inbox/command_1/.bundle.zip.kortix-prompt-fixed',
            size: 4,
          },
        ]);
      }
      return Response.json(true);
    },
    () => 'fixed',
  );

  expect(result).toEqual({
    path: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
    size: 4,
  });
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'POST /file/upload',
    'POST /file/rename',
  ]);
});

for (const [label, filename] of [
  ['215-byte ASCII', `${'a'.repeat(211)}.zip`],
  ['215-byte multibyte', `${'界'.repeat(69)}éé.zip`],
] as const) {
  test(`keeps the daemon upload filename within NAME_MAX for a ${label} target basename`, async () => {
    const uploadFilenames: string[] = [];
    const targetPath = `/workspace/uploads/.kortix-inbox/command_1/1-${filename}`;

    await writeRuntimePromptFile(
      { ...input, targetPath, filename },
      async (_externalId, _port, _access, _method, route, _query, headers, body) => {
        if (route === '/file/upload') {
          const request = new Request('http://runtime.invalid/file/upload', {
            method: 'POST',
            headers,
            body,
          });
          const form = await request.formData();
          const file = form.get('file');
          expect(file).toBeInstanceOf(File);
          if (file instanceof File) uploadFilenames.push(file.name);
          return Response.json([
            {
              path: `/workspace/uploads/.kortix-inbox/command_1/.kortix-prompt-fixed`,
              size: 4,
            },
          ]);
        }
        return Response.json(true);
      },
      () => 'fixed',
    );

    expect(new TextEncoder().encode(filename).length).toBe(215);
    expect(uploadFilenames).toEqual(['.kortix-prompt-fixed']);
    expect(new TextEncoder().encode(uploadFilenames[0]!).length).toBeLessThanOrEqual(255);
  });
}

test('rejects an upload failure without exposing an echoed file body', async () => {
  const error = await writeRuntimePromptFile(
    input,
    async () => new Response('daemon rejected upload: UEsDBA==', { status: 500 }),
    () => 'fixed',
  ).catch((value) => value);

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('runtime upload failed (500)');
  expect(error.message).not.toContain('UEsDBA==');
});

test('rejects an upload response with no authoritative temporary path', async () => {
  const requests: string[] = [];
  const error = await writeRuntimePromptFile(
    input,
    async (_externalId, _port, _access, method, route) => {
      requests.push(`${method} ${route}`);
      return Response.json([{ size: 4 }]);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('runtime upload returned no file path');
  expect(error.message).not.toContain('UEsDBA==');
  expect(requests).toEqual(['POST /file/upload']);
});

test('deletes the temporary file when rename failure echoes the file body', async () => {
  const requests: Array<{ method: string; path: string; body: ArrayBuffer }> = [];
  const temporaryPath = '/workspace/uploads/.kortix-inbox/command_1/.bundle.zip.kortix-prompt-fixed';
  const error = await writeRuntimePromptFile(
    input,
    async (_externalId, _port, _access, method, path, _query, _headers, body) => {
      requests.push({ method, path, body: body ?? new ArrayBuffer(0) });
      if (path === '/file/upload') return Response.json([{ path: temporaryPath, size: 4 }]);
      if (path === '/file/rename') return new Response('rename blocked: UEsDBA==', { status: 500 });
      return Response.json(true);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('runtime rename failed (500)');
  expect(error.message).not.toContain('UEsDBA==');
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'POST /file/upload',
    'POST /file/rename',
    'DELETE /file',
  ]);
  expect(JSON.parse(new TextDecoder().decode(requests[2]?.body))).toEqual({ path: temporaryPath });
});

// The 2026-09-04 incident's second half. The sandbox edge discards a request
// body over its size ceiling (~104 KB lands, ~115 KB does not) and answers ok,
// so a single-shot upload of a real photo or PDF never reaches the box. Files
// past the chunk budget must go up in bounded pieces instead.
test('splits a file past the chunk budget into bounded appends', async () => {
  const calls: Array<{ path: string; first?: string; offset?: string; bytes: number }> = [];
  const bytes = new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES * 2 + 17).fill(7);
  let written = 0;

  const result = await writeRuntimePromptFile(
    { ...input, bytes, filename: 'photo.jpg', targetPath: '/workspace/uploads/x/1-photo.jpg' },
    async (_externalId, _port, _access, _method, route, _query, headers, body) => {
      if (route === '/file/append') {
        const form = await new Request('http://runtime.invalid/file/append', {
          method: 'POST',
          headers,
          body,
        }).formData();
        const chunk = form.get('file') as File;
        written += chunk.size;
        calls.push({
          path: route,
          first: (form.get('first') as string) ?? undefined,
          offset: (form.get('offset') as string) ?? undefined,
          bytes: chunk.size,
        });
        return Response.json({ path: '/workspace/uploads/x/.tmp', size: written });
      }
      return Response.json(true);
    },
    () => 'fixed',
  );

  // Three appends: two full chunks and the 17-byte tail.
  expect(calls.map((call) => call.bytes)).toEqual([
    RUNTIME_PROMPT_CHUNK_BYTES,
    RUNTIME_PROMPT_CHUNK_BYTES,
    17,
  ]);
  // Only the FIRST truncates; appending onto a stale partial would corrupt it.
  expect(calls.map((call) => call.first)).toEqual(['true', 'false', 'false']);
  // Retries carry a stable byte offset, so an accepted chunk cannot duplicate.
  expect(calls.map((call) => call.offset)).toEqual([
    '0',
    String(RUNTIME_PROMPT_CHUNK_BYTES),
    String(RUNTIME_PROMPT_CHUNK_BYTES * 2),
  ]);
  // Every chunk stays under the ceiling that the edge actually enforces.
  for (const call of calls) expect(call.bytes).toBeLessThanOrEqual(RUNTIME_PROMPT_CHUNK_BYTES);
  expect(result).toEqual({ path: '/workspace/uploads/x/1-photo.jpg', size: bytes.byteLength });
});

test('a file within the chunk budget still goes up in one upload', async () => {
  const routes: string[] = [];
  await writeRuntimePromptFile(
    { ...input, bytes: new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES) },
    async (_externalId, _port, _access, _method, route) => {
      routes.push(route);
      if (route === '/file/upload') return Response.json([{ path: '/tmp/x', size: 1 }]);
      return Response.json(true);
    },
    () => 'fixed',
  );
  expect(routes).toEqual(['/file/upload', '/file/rename']);
});

// A chunk the runtime rejects must abort the whole write, not leave a
// truncated file that later reads as a corrupt attachment.
test('a failed chunk aborts the write', async () => {
  await expect(
    writeRuntimePromptFile(
      { ...input, bytes: new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES * 2) },
      async (_externalId, _port, _access, _method, route) => {
        if (route === '/file/append') return new Response(null, { status: 503 });
        return Response.json(true);
      },
      () => 'fixed',
    ),
  ).rejects.toThrow(/append failed \(503\)/);
});
