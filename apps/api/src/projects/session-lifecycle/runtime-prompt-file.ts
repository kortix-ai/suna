import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { config } from '../../config';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';

import type { RuntimePromptFileWriteInput } from './prompt-attachment-materializer';

const DAEMON_PORT = 8000;

type Forward = typeof forwardToSandbox;

async function forwarded(
  input: RuntimePromptFileWriteInput,
  forward: Forward,
  method: string,
  route: string,
  headers: Headers,
  body: ArrayBuffer,
): Promise<Response> {
  return forward(
    input.externalId,
    DAEMON_PORT,
    {
      kind: 'principal',
      userId: input.userId,
      callerSessionId: input.sessionId,
      boundCredentialSessionId: input.sessionId,
      sandboxAuthored: false,
    },
    method,
    route,
    '',
    headers,
    body,
    config.KORTIX_URL ?? '',
  );
}

export async function writeRuntimePromptFile(
  input: RuntimePromptFileWriteInput,
  forward: Forward = forwardToSandbox,
  token: () => string = randomUUID,
): Promise<{ path: string; size: number }> {
  const directory = path.posix.dirname(input.targetPath);
  const basename = path.posix.basename(input.targetPath);
  const temporaryName = `.${basename}.kortix-prompt-${token()}`;
  const fileBytes = new Uint8Array(input.bytes);
  const form = new FormData();
  form.append('path', directory);
  form.append('filename', temporaryName);
  form.append('file', new File([fileBytes], temporaryName, { type: input.mime }), temporaryName);
  const request = new Request('http://runtime.invalid/file/upload', {
    method: 'POST',
    body: form,
  });
  const upload = await forwarded(
    input,
    forward,
    'POST',
    '/file/upload',
    new Headers(request.headers),
    await request.arrayBuffer(),
  );
  if (!upload.ok) {
    throw new Error(`runtime upload failed (${upload.status})`);
  }
  const rows = (await upload.json()) as Array<{ path?: string; size?: number }>;
  const temporaryPath = rows[0]?.path;
  if (!temporaryPath) throw new Error('runtime upload returned no file path');

  const renameBody = new TextEncoder().encode(
    JSON.stringify({ from: temporaryPath, to: input.targetPath }),
  );
  const rename = await forwarded(
    input,
    forward,
    'POST',
    '/file/rename',
    new Headers({ 'Content-Type': 'application/json' }),
    renameBody.buffer as ArrayBuffer,
  );
  if (!rename.ok) {
    const deleteBody = new TextEncoder().encode(JSON.stringify({ path: temporaryPath }));
    await forwarded(
      input,
      forward,
      'DELETE',
      '/file',
      new Headers({ 'Content-Type': 'application/json' }),
      deleteBody.buffer as ArrayBuffer,
    ).catch(() => undefined);
    throw new Error(`runtime rename failed (${rename.status})`);
  }
  return {
    path: input.targetPath,
    size: typeof rows[0]?.size === 'number' ? rows[0].size : input.bytes.byteLength,
  };
}
