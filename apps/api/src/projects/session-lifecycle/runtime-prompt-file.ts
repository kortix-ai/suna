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

/** Largest legacy whole-file request that can safely cross the runtime edge. */
export const RUNTIME_WHOLE_UPLOAD_CEILING_BYTES = 96 * 1024;

const RUNTIME_CAPABILITY_CACHE_TTL_MS = 60_000;

export class RuntimeRouteUnsupportedError extends Error {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly contentType: string;

  constructor(input: { method: string; route: string; status: number; contentType: string }) {
    super(
      `runtime route unsupported: ${input.method} ${input.route} returned ${input.status} ${input.contentType}`,
    );
    this.name = 'RuntimeRouteUnsupportedError';
    this.method = input.method;
    this.route = input.route;
    this.status = input.status;
    this.contentType = input.contentType;
  }
}

export class RuntimeStaleDaemonError extends Error {
  readonly route: string;
  readonly byteCount: number;

  constructor(route: string, byteCount: number) {
    super(`runtime stale daemon does not support ${route} for ${byteCount} bytes`);
    this.name = 'RuntimeStaleDaemonError';
    this.route = route;
    this.byteCount = byteCount;
  }
}

class RuntimeFirstAppendRouteUnsupportedError extends RuntimeRouteUnsupportedError {}

type Forward = typeof forwardToSandbox;

interface RuntimeAppendCapability {
  supportsAppend: boolean;
  expiresAt: number;
}

const runtimeAppendCapabilities = new WeakMap<Forward, Map<string, RuntimeAppendCapability>>();

function runtimeCapabilityCache(forward: Forward): Map<string, RuntimeAppendCapability> {
  const existing = runtimeAppendCapabilities.get(forward);
  if (existing) return existing;
  const created = new Map<string, RuntimeAppendCapability>();
  runtimeAppendCapabilities.set(forward, created);
  return created;
}

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

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

async function readRuntimeJson<T>(input: {
  response: Response;
  method: string;
  route: string;
  operation: string;
}): Promise<T> {
  if (!input.response.ok) {
    throw new Error(`runtime ${input.operation} failed (${input.response.status})`);
  }
  const contentType = input.response.headers.get('content-type') ?? 'missing content-type';
  if (!isJsonContentType(contentType)) {
    throw new RuntimeRouteUnsupportedError({
      method: input.method,
      route: input.route,
      status: input.response.status,
      contentType,
    });
  }
  try {
    return (await input.response.json()) as T;
  } catch {
    throw new RuntimeRouteUnsupportedError({
      method: input.method,
      route: input.route,
      status: input.response.status,
      contentType,
    });
  }
}

async function runtimeSupportsAppend(
  input: RuntimePromptFileWriteInput,
  forward: Forward,
): Promise<boolean> {
  const cache = runtimeCapabilityCache(forward);
  const cached = cache.get(input.externalId);
  if (cached && cached.expiresAt > Date.now()) return cached.supportsAppend;

  const health = await forwarded(
    input,
    forward,
    'GET',
    '/kortix/health',
    new Headers(),
    new ArrayBuffer(0),
  );
  const body = await readRuntimeJson<{ capabilities?: unknown }>({
    response: health,
    method: 'GET',
    route: '/kortix/health',
    operation: 'health',
  });
  const supportsAppend = Array.isArray(body.capabilities) && body.capabilities.includes('file.append');
  cache.set(input.externalId, {
    supportsAppend,
    expiresAt: Date.now() + RUNTIME_CAPABILITY_CACHE_TTL_MS,
  });
  return supportsAppend;
}

function markRuntimeAppendUnsupported(input: RuntimePromptFileWriteInput, forward: Forward): void {
  runtimeCapabilityCache(forward).set(input.externalId, {
    supportsAppend: false,
    expiresAt: Date.now() + RUNTIME_CAPABILITY_CACHE_TTL_MS,
  });
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
  const rows = await readRuntimeJson<Array<{ path?: string; size?: number }>>({
    response: upload,
    method: 'POST',
    route: '/file/upload',
    operation: 'upload',
  });
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
    let row: { path?: string; size?: number };
    try {
      row = await readRuntimeJson<{ path?: string; size?: number }>({
        response,
        method: 'POST',
        route: '/file/append',
        operation: 'append',
      });
    } catch (error) {
      if (offset === 0 && error instanceof RuntimeRouteUnsupportedError) {
        throw new RuntimeFirstAppendRouteUnsupportedError(error);
      }
      throw error;
    }
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
    const supportsAppend = await runtimeSupportsAppend(input, forward);
    if (!supportsAppend) {
      if (fileBytes.byteLength <= RUNTIME_WHOLE_UPLOAD_CEILING_BYTES) {
        temporaryPath = await uploadWhole(input, forward, directory, temporaryName, fileBytes);
      } else {
        throw new RuntimeStaleDaemonError('/file/append', fileBytes.byteLength);
      }
    } else {
      try {
        temporaryPath = await appendInChunks(input, forward, directory, temporaryName, fileBytes);
      } catch (error) {
        if (
          error instanceof RuntimeFirstAppendRouteUnsupportedError
        ) {
          markRuntimeAppendUnsupported(input, forward);
          if (fileBytes.byteLength <= RUNTIME_WHOLE_UPLOAD_CEILING_BYTES) {
            temporaryPath = await uploadWhole(input, forward, directory, temporaryName, fileBytes);
          } else {
            throw new RuntimeStaleDaemonError('/file/append', fileBytes.byteLength);
          }
        } else {
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
      }
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
  try {
    await readRuntimeJson<unknown>({
      response: rename,
      method: 'POST',
      route: '/file/rename',
      operation: 'rename',
    });
  } catch (error) {
    const deleteBody = new TextEncoder().encode(JSON.stringify({ path: temporaryPath }));
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
  // The bytes we sent ARE the size: the chunked path proves the landed total
  // against this before returning, and the whole-file path writes it in one
  // request. Reading it back off the upload response added nothing but a way
  // for the two numbers to disagree.
  return { path: input.targetPath, size: fileBytes.byteLength };
}
