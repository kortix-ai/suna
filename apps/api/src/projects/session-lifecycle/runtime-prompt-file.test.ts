import { expect, test } from 'bun:test';

import { writeRuntimePromptFile } from './runtime-prompt-file';

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
