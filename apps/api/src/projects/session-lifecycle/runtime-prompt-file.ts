import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { config } from '../../config';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';

import type { RuntimePromptFileWriteInput } from './prompt-attachment-materializer';

const DAEMON_PORT = 8000;

/**
 * The most bytes one request to the box may carry.
 *
 * NOT a guess. Measured 2026-09-04 against a live Platinum box by sweeping a
 * single attachment's size through the real route: a ~104 KB body arrives,
 * ~115 KB does not, and the drop is SILENT — the edge discards the body and
 * its retry answers `200` for a request the runtime never saw. 64 KiB leaves
 * room for the multipart envelope and headers on top of the payload, and keeps
 * a comfortable margin under a ceiling that lives outside this repo and can
 * therefore move without warning.
 */
export const RUNTIME_PROMPT_CHUNK_BYTES = 64 * 1024;

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


async function uploadWhole(
  input: RuntimePromptFileWriteInput,
  forward: Forward,
  directory: string,
  temporaryName: string,
  fileBytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const form = new FormData();
  form.append('path', directory);
  form.append('filename', temporaryName);
  form.append('file', new File([fileBytes], temporaryName, { type: input.mime }), temporaryName);
  const request = new Request('http://runtime.invalid/file/upload', { method: 'POST', body: form });
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
  return temporaryPath;
}

/**
 * Send a file the edge would otherwise drop, one bounded chunk at a time.
 *
 * The FIRST chunk truncates so a retry can never append onto a half-written
 * attempt; the rest extend. The daemon answers each chunk with the file's
 * CUMULATIVE size, and the final one is checked against the bytes we meant to
 * send — a short file here would otherwise become a corrupt attachment the
 * agent silently reads as truncated.
 */
async function appendInChunks(
  input: RuntimePromptFileWriteInput,
  forward: Forward,
  directory: string,
  temporaryName: string,
  fileBytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  let landedPath: string | undefined;
  let landedSize = 0;

  for (let offset = 0; offset < fileBytes.byteLength; offset += RUNTIME_PROMPT_CHUNK_BYTES) {
    const chunk = fileBytes.subarray(offset, offset + RUNTIME_PROMPT_CHUNK_BYTES);
    const form = new FormData();
    form.append('path', directory);
    form.append('filename', temporaryName);
    form.append('first', offset === 0 ? 'true' : 'false');
    form.append('offset', String(offset));
    form.append('file', new File([chunk], temporaryName, { type: input.mime }), temporaryName);
    const request = new Request('http://runtime.invalid/file/append', {
      method: 'POST',
      body: form,
    });
    const response = await forwarded(
      input,
      forward,
      'POST',
      '/file/append',
      new Headers(request.headers),
      await request.arrayBuffer(),
    );
    if (!response.ok) {
      throw new Error(`runtime append failed (${response.status})`);
    }
    const row = (await response.json()) as { path?: string; size?: number };
    if (!row?.path) throw new Error('runtime append returned no file path');
    landedPath = row.path;
    landedSize = typeof row.size === 'number' ? row.size : landedSize;
  }

  if (!landedPath) throw new Error('runtime append wrote nothing');
  if (landedSize !== fileBytes.byteLength) {
    throw new Error(
      `runtime append landed ${landedSize} of ${fileBytes.byteLength} bytes`,
    );
  }
  return landedPath;
}

export async function writeRuntimePromptFile(
  input: RuntimePromptFileWriteInput,
  forward: Forward = forwardToSandbox,
  token: () => string = randomUUID,
): Promise<{ path: string; size: number }> {
  const directory = path.posix.dirname(input.targetPath);
  const temporaryName = `.kortix-prompt-${token()}`;
  const fileBytes = new Uint8Array(input.bytes);
  let temporaryPath: string;
  if (fileBytes.byteLength > RUNTIME_PROMPT_CHUNK_BYTES) {
    try {
      temporaryPath = await appendInChunks(input, forward, directory, temporaryName, fileBytes);
    } catch (error) {
      // A chunk that failed mid-way leaves a truncated temp file in the
      // workspace — junk the agent can trip over. Only the chunked path can
      // leave one (a whole-file upload either lands or writes nothing). Best
      // effort, never masks the real error.
      const deleteBody = new TextEncoder().encode(
        JSON.stringify({ path: path.posix.join(directory, temporaryName) }),
      );
      await forwarded(
        input,
        forward,
        'DELETE',
        '/file',
        new Headers({ 'Content-Type': 'application/json' }),
        deleteBody.buffer as ArrayBuffer,
      ).catch(() => undefined);
      throw error;
    }
  } else {
    temporaryPath = await uploadWhole(input, forward, directory, temporaryName, fileBytes);
  }

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
  // The bytes we sent ARE the size: the chunked path proves the landed total
  // against this before returning, and the whole-file path writes it in one
  // request. Reading it back off the upload response added nothing but a way
  // for the two numbers to disagree.
  return { path: input.targetPath, size: fileBytes.byteLength };
}
