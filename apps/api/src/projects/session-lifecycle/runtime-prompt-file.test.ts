import { afterEach, expect, setSystemTime, test } from 'bun:test';

import {
  importRuntimePromptAttachment,
  RUNTIME_PROMPT_CHUNK_BYTES,
  writeRuntimePromptFile,
} from './runtime-prompt-file';

const input = {
  externalId: 'sbx_1',
  sessionId: 'session_1',
  userId: 'user_1',
  targetPath: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
  filename: 'bundle.zip',
  mime: 'application/zip',
  bytes: new Uint8Array([80, 75, 3, 4]),
};

afterEach(() => setSystemTime());

test('imports a staged attachment with identifiers only when the daemon advertises file.import', async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const result = await importRuntimePromptAttachment(
    {
      externalId: 'sbx_import',
      sessionId: 'session_1',
      userId: 'user_1',
      commandId: '11111111-1111-4111-8111-111111111111',
      attachmentId: '22222222-2222-4222-8222-222222222222',
      partIndex: 3,
    },
    async (_externalId, _port, _access, _method, route, _query, _headers, body) => {
      calls.push({
        route,
        body: body?.byteLength ? JSON.parse(new TextDecoder().decode(body)) : null,
      });
      if (route === '/kortix/health') {
        return Response.json({ capabilities: ['file.import', 'file.append'] });
      }
      return Response.json({
        path: '/workspace/uploads/.kortix-inbox/command/3-proof.txt',
        size: 19,
        sha256: 'a'.repeat(64),
      });
    },
  );

  expect(result).toEqual({
    path: '/workspace/uploads/.kortix-inbox/command/3-proof.txt',
    size: 19,
    sha256: 'a'.repeat(64),
  });
  expect(calls).toEqual([
    { route: '/kortix/health', body: null },
    {
      route: '/file/import',
      body: {
        command_id: '11111111-1111-4111-8111-111111111111',
        attachment_id: '22222222-2222-4222-8222-222222222222',
        part_index: 3,
      },
    },
  ]);
});

test('returns null without sending bytes when a legacy daemon does not advertise file.import', async () => {
  const routes: string[] = [];
  const result = await importRuntimePromptAttachment(
    {
      externalId: 'sbx_import_legacy',
      sessionId: 'session_1',
      userId: 'user_1',
      commandId: '11111111-1111-4111-8111-111111111111',
      attachmentId: '22222222-2222-4222-8222-222222222222',
      partIndex: 3,
    },
    async (_externalId, _port, _access, _method, route) => {
      routes.push(route);
      return Response.json({ capabilities: ['file.append'] });
    },
  );

  expect(result).toBeNull();
  expect(routes).toEqual(['/kortix/health']);
});

test('marks the runtime stale when file.import is advertised but the route is absent', async () => {
  const result = await importRuntimePromptAttachment(
    {
      externalId: 'sbx_import_stale',
      sessionId: 'session_1',
      userId: 'user_1',
      commandId: '11111111-1111-4111-8111-111111111111',
      attachmentId: '22222222-2222-4222-8222-222222222222',
      partIndex: 3,
    },
    async (_externalId, _port, _access, _method, route) =>
      route === '/kortix/health'
        ? Response.json({ capabilities: ['file.import'] })
        : new Response('<html>old daemon</html>', {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          }),
  ).catch((error) => error);

  expect(result).toBeInstanceOf(Error);
  expect(result.name).toBe('RuntimeStaleDaemonError');
  expect(result.message).toBe('runtime stale daemon does not support /file/import for 0 bytes');
});

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
      if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
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
        if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
        if (route === '/file/append') return new Response(null, { status: 503 });
        return Response.json(true);
      },
      () => 'fixed',
    ),
  ).rejects.toThrow(/append failed \(503\)/);
});

// A chunk that fails mid-way must not leave a truncated temp file behind.
test('a failed chunked upload deletes its partial temp file', async () => {
  const calls: string[] = [];
  await expect(
    writeRuntimePromptFile(
      { ...input, bytes: new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES * 2) },
      async (_e, _p, _a, method, route, _q, _h, body) => {
        calls.push(`${method} ${route}`);
        if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
        if (route === '/file/append' && calls.filter((c) => c.endsWith('/file/append')).length === 2) {
          return new Response(null, { status: 503 });
        }
        if (route === '/file/append') return Response.json({ path: '/tmp/x', size: 1 });
        if (method === 'DELETE') {
          const { path } = JSON.parse(new TextDecoder().decode(body));
          calls.push(`deleted ${path}`);
          return Response.json(true);
        }
        return Response.json(true);
      },
      () => 'fixed',
    ),
  ).rejects.toThrow(/append failed \(503\)/);
  expect(calls.some((c) => c.startsWith('deleted /workspace/uploads/.kortix-inbox/command_1/.kortix-prompt-fixed'))).toBe(true);
});

test('names an unsupported append route when a successful response is HTML', async () => {
  let appendCalls = 0;
  const error = await writeRuntimePromptFile(
    { ...input, externalId: 'sbx_append_html', bytes: new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES + 1) },
    async (_externalId, _port, _access, _method, route) => {
      if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
      if (route === '/file/append') {
        appendCalls += 1;
        if (appendCalls === 1) return Response.json({ path: '/tmp/append', size: RUNTIME_PROMPT_CHUNK_BYTES });
        return new Response('<!doctype html><title>OpenCode</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return Response.json(true);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error.constructor.name).toBe('RuntimeRouteUnsupportedError');
  expect(error.message).toContain('POST /file/append');
  expect(error.message).toContain('200');
  expect(error.message).toContain('text/html');
  expect(error.message).not.toContain('Failed to parse JSON');
});

test('names an unsupported whole-upload route when a successful response is HTML', async () => {
  const error = await writeRuntimePromptFile(
    { ...input, externalId: 'sbx_upload_html' },
    async (_externalId, _port, _access, _method, route) => {
      if (route === '/file/upload') {
        return new Response('<!doctype html><title>OpenCode</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return Response.json(true);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error.constructor.name).toBe('RuntimeRouteUnsupportedError');
  expect(error.message).toContain('POST /file/upload');
  expect(error.message).toContain('200');
  expect(error.message).toContain('text/html');
  expect(error.message).not.toContain('Failed to parse JSON');
});

test('falls back from an unsupported first append to the legacy whole upload', async () => {
  const routes: string[] = [];
  const result = await writeRuntimePromptFile(
    { ...input, externalId: 'sbx_append_fallback', bytes: new Uint8Array(RUNTIME_PROMPT_CHUNK_BYTES + 1) },
    async (_externalId, _port, _access, method, route) => {
      routes.push(`${method} ${route}`);
      if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
      if (route === '/file/append') {
        return new Response('<!doctype html><title>OpenCode</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (route === '/file/upload') return Response.json([{ path: '/tmp/fallback', size: RUNTIME_PROMPT_CHUNK_BYTES + 1 }]);
      return Response.json(true);
    },
    () => 'fixed',
  );

  expect(result).toEqual({
    path: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
    size: RUNTIME_PROMPT_CHUNK_BYTES + 1,
  });
  expect(routes).toEqual([
    'GET /kortix/health',
    'POST /file/append',
    'POST /file/upload',
    'POST /file/rename',
  ]);
});

test('stops a large upload before an unsupported append when the daemon lacks file.append', async () => {
  const routes: string[] = [];
  const error = await writeRuntimePromptFile(
    { ...input, externalId: 'sbx_legacy_large', bytes: new Uint8Array(200 * 1024) },
    async (_externalId, _port, _access, method, route) => {
      routes.push(`${method} ${route}`);
      if (route === '/kortix/health') return Response.json({ runtime: { build: 1 } });
      return Response.json(true);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error.constructor.name).toBe('RuntimeStaleDaemonError');
  expect(error.message).toContain('/file/append');
  expect(error.message).toContain('204800');
  expect(routes).toEqual(['GET /kortix/health']);
  expect(routes).not.toContain('POST /file/append');
  expect(routes).not.toContain('POST /file/upload');
});

test('marks a large upload stale when a cached append capability drifts', async () => {
  const routes: string[] = [];
  const error = await writeRuntimePromptFile(
    { ...input, externalId: 'sbx_append_drift_large', bytes: new Uint8Array(200 * 1024) },
    async (_externalId, _port, _access, method, route) => {
      routes.push(`${method} ${route}`);
      if (route === '/kortix/health') return Response.json({ capabilities: ['file.append'] });
      if (route === '/file/append') {
        return new Response('<!doctype html><title>OpenCode</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return Response.json(true);
    },
    () => 'fixed',
  ).catch((value) => value);

  expect(error.constructor.name).toBe('RuntimeStaleDaemonError');
  expect(error.message).toContain('/file/append');
  expect(error.message).toContain('204800');
  expect(routes).toEqual(['GET /kortix/health', 'POST /file/append']);
});

test('caches the legacy capability decision for one externalId', async () => {
  let healthCalls = 0;
  const forward = async (_externalId: string, _port: number, _access: unknown, method: string, route: string) => {
    if (route === '/kortix/health') {
      healthCalls += 1;
      return Response.json({ runtime: { build: 1 } });
    }
    throw new Error(`unexpected ${method} ${route}`);
  };

  for (let index = 0; index < 2; index += 1) {
    const error = await writeRuntimePromptFile(
      { ...input, externalId: 'sbx_legacy_cached', bytes: new Uint8Array(200 * 1024) },
      forward as Parameters<typeof writeRuntimePromptFile>[1],
      () => `fixed-${index}`,
    ).catch((value) => value);
    expect(error.constructor.name).toBe('RuntimeStaleDaemonError');
  }

  expect(healthCalls).toBe(1);
});

test('reuses a capability decision for 60 seconds, then probes again after expiry', async () => {
  setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
  let healthCalls = 0;
  const forward = async (_externalId: string, _port: number, _access: unknown, method: string, route: string) => {
    if (route === '/kortix/health') {
      healthCalls += 1;
      return Response.json({ runtime: { build: 1 } });
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  const write = () => writeRuntimePromptFile(
    { ...input, externalId: 'sbx_legacy_ttl', bytes: new Uint8Array(200 * 1024) },
    forward as Parameters<typeof writeRuntimePromptFile>[1],
    () => 'fixed',
  ).catch((value) => value);

  expect((await write()).constructor.name).toBe('RuntimeStaleDaemonError');
  setSystemTime(new Date('2026-09-07T00:00:59.999Z'));
  expect((await write()).constructor.name).toBe('RuntimeStaleDaemonError');
  expect(healthCalls).toBe(1);

  setSystemTime(new Date('2026-09-07T00:01:00.000Z'));
  expect((await write()).constructor.name).toBe('RuntimeStaleDaemonError');
  expect(healthCalls).toBe(2);
});

test('shares one pending health probe across concurrent writes for one externalId', async () => {
  let healthCalls = 0;
  let resolveHealth!: (response: Response) => void;
  const health = new Promise<Response>((resolve) => {
    resolveHealth = resolve;
  });
  const forward = async (_externalId: string, _port: number, _access: unknown, method: string, route: string) => {
    if (route === '/kortix/health') {
      healthCalls += 1;
      return health;
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  const write = () => writeRuntimePromptFile(
    { ...input, externalId: 'sbx_legacy_concurrent', bytes: new Uint8Array(200 * 1024) },
    forward as Parameters<typeof writeRuntimePromptFile>[1],
    () => 'fixed',
  ).catch((value) => value);

  const first = write();
  const second = write();

  expect(healthCalls).toBe(1);
  resolveHealth(Response.json({ runtime: { build: 1 } }));
  expect((await first).constructor.name).toBe('RuntimeStaleDaemonError');
  expect((await second).constructor.name).toBe('RuntimeStaleDaemonError');
});
