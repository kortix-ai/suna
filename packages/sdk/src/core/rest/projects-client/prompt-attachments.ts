import { backendApi, ApiError } from '../../http/api-client';
import { abortableDelay } from '../../http/abort';
import { platformConfig } from '../../http/config';
import { MAX_PROMPT_ATTACHMENT_BYTES } from '../../attachments/limits';
import { unwrap } from './shared';

/** Private project storage metadata. It carries no storage URL and no runtime path. */
export interface PromptAttachment {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  expires_at: string;
}

/**
 * Retain this handle to resume the same upload after an ambiguous response.
 * The server selects the transport for each upload.
 */
export interface PromptAttachmentUpload extends PromptAttachment {
  upload:
    | {
        /** One PUT of the whole file to a short-lived signed Storage URL. Send `headers` and no Authorization. */
        kind: 'direct';
        url: string;
        method: 'PUT';
        headers: Record<string, string>;
        /** The client re-signs the same attachment before this time. */
        expires_at: string;
      }
    | {
        /** Sequential authenticated API PUTs of `chunk_size` bytes. */
        kind: 'chunked';
        chunk_size: number;
      };
  /**
   * Bytes the server holds: acknowledged chunks, or `size` after the direct PUT
   * succeeded. Reset to 0 when completion answers `attachment_not_uploaded`.
   */
  received_bytes: number;
}

export interface PromptAttachmentUploadOptions {
  signal?: AbortSignal;
  resume?: PromptAttachmentUpload;
  onUpload?: (upload: PromptAttachmentUpload) => void;
  /** Bytes sent so far. At 100% the upload still needs completion before it is ready. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  onProcessing?: () => void;
}

type DirectTarget = Extract<PromptAttachmentUpload['upload'], { kind: 'direct' }>;

/** The XMLHttpRequest members a direct upload uses. Browsers and React Native provide them. */
interface UploadRequest {
  upload: { onprogress: ((event: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  status: number;
  responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
}

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/attachments`;
/** The request deadline also bounds the response body: completion can stall after headers. */
const quiet = { showErrors: false, deadlineCoversBody: true };
const REQUEST_TIMEOUT_MS = 30_000;
/** Longer than the server's 90 s completion bound, so a live server answers first. */
const COMPLETE_TIMEOUT_MS = 120_000;
/** Transient failures retry with jittered exponential backoff inside this budget. */
const TRANSIENT_RETRY_BUDGET_MS = 60_000;
/** Completion also outlasts the server's 2 minute lease of a crashed chunked finalizer. */
const COMPLETION_RETRY_BUDGET_MS = 5 * 60_000;
/** A direct XHR upload with no progress for this long is abandoned as a TIMEOUT. */
const DIRECT_STALL_MS = 60_000;
/** A direct URL this close to its reported expiry is re-signed before the PUT. */
const DIRECT_URL_MARGIN_MS = 60_000;

function abortedError(): ApiError {
  return new ApiError('Request aborted', { name: 'AbortError', code: 'ABORTED' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/**
 * Timeouts, network failures, 429 and 5xx are transient. Aborts never are, and
 * neither is the per-user attachment budget: it clears only when uploads are
 * sent, removed or expire. A 402 is a `BillingError`, not an `ApiError`.
 */
function transient(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code === 'ABORTED') return false;
  if (error.code === 'attachment_budget_exceeded') return false;
  return (
    error.code === 'TIMEOUT' ||
    error.name === 'TypeError' ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

async function retry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  completion = false,
): Promise<T> {
  // The budget starts at the first failure, not at the first attempt: a direct
  // PUT of a large file can run for minutes before the network changes.
  let deadline: number | undefined;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      const processing =
        completion &&
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'attachment_processing';
      if (signal?.aborted || !(transient(error) || processing)) throw error;
      deadline ??=
        Date.now() + (completion ? COMPLETION_RETRY_BUDGET_MS : TRANSIENT_RETRY_BUDGET_MS);
      const delay = Math.min(8_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
      if (Date.now() + delay >= deadline) throw error;
      try {
        await abortableDelay(delay, signal);
      } catch {
        throwIfAborted(signal);
        throw error;
      }
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function checkedHandle(
  value: PromptAttachmentUpload,
  file: File,
  attachmentId?: string,
): PromptAttachmentUpload {
  const target = value?.upload;
  const received = value?.received_bytes;
  const receivedValid = Number.isSafeInteger(received) && received >= 0 && received <= file.size;
  const targetValid =
    target?.kind === 'direct'
      ? typeof target.url === 'string' &&
        /^https?:\/\//i.test(target.url) &&
        target.method === 'PUT' &&
        isStringRecord(target.headers) &&
        Number.isFinite(Date.parse(target.expires_at)) &&
        (received === 0 || received === file.size)
      : target?.kind === 'chunked' &&
        Number.isSafeInteger(target.chunk_size) &&
        target.chunk_size > 0 &&
        (received === file.size || received % target.chunk_size === 0);
  if (
    !value?.attachment_id ||
    (attachmentId !== undefined && value.attachment_id !== attachmentId) ||
    value.size !== file.size ||
    !receivedValid ||
    !targetValid
  )
    throw new Error('Invalid attachment upload handle');
  return value;
}

async function begin(
  projectId: string,
  file: File,
  signal: AbortSignal | undefined,
  attachmentId?: string,
): Promise<Omit<PromptAttachmentUpload, 'received_bytes'>> {
  return unwrap(
    await backendApi.post<Omit<PromptAttachmentUpload, 'received_bytes'>>(
      path(projectId),
      {
        ...(attachmentId ? { attachment_id: attachmentId } : {}),
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      },
      { ...quiet, signal, timeout: REQUEST_TIMEOUT_MS },
    ),
    'Failed to start attachment upload',
  );
}

/** Obtain a fresh upload target for the SAME attachment. The server creates no second row. */
async function resign(
  projectId: string,
  file: File,
  current: PromptAttachmentUpload,
  options: PromptAttachmentUploadOptions,
): Promise<PromptAttachmentUpload> {
  const next = checkedHandle(
    {
      ...(await retry(
        () => begin(projectId, file, options.signal, current.attachment_id),
        options.signal,
      )),
      received_bytes: 0,
    },
    file,
    current.attachment_id,
  );
  options.onUpload?.(next);
  return next;
}

function storageError(status: number, body: string): ApiError {
  let details: Record<string, unknown> | undefined;
  try {
    details = JSON.parse(body) as Record<string, unknown>;
  } catch {}
  const message =
    typeof details?.message === 'string'
      ? details.message
      : typeof details?.error === 'string'
        ? details.error
        : `HTTP ${status}`;
  return new ApiError(message, { status, details, code: String(details?.statusCode ?? status) });
}

/** Storage can answer 400 with the real status in its body (`statusCode`). */
function storageStatus(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const reported = Number(error.details?.statusCode);
  return Number.isInteger(reported) && reported >= 400 ? reported : error.status;
}

function putWithXhr(
  Request: new () => UploadRequest,
  target: DirectTarget,
  file: File,
  options: PromptAttachmentUploadOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new Request();
    let reported = 0;
    let settled = false;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ApiError) => {
      if (settled) return;
      settled = true;
      if (stall) clearTimeout(stall);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        finish(new ApiError('Attachment upload stalled', { code: 'TIMEOUT' }));
        request.abort();
      }, DIRECT_STALL_MS);
    };
    const onAbort = () => {
      finish(abortedError());
      request.abort();
    };
    request.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      armStall();
      reported = Math.min(event.loaded, file.size);
      options.onProgress?.(reported, file.size);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        if (reported < file.size) options.onProgress?.(file.size, file.size);
        finish();
      } else finish(storageError(request.status, request.responseText));
    };
    request.onerror = () =>
      finish(new ApiError('Network error during attachment upload', { name: 'TypeError' }));
    request.onabort = () => finish(abortedError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    armStall();
    request.send(file);
  });
}

async function putWithFetch(
  target: DirectTarget,
  file: File,
  options: PromptAttachmentUploadOptions,
): Promise<void> {
  const fetchImpl = platformConfig().fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: target.method,
      headers: target.headers,
      body: file,
      signal: options.signal,
      credentials: 'omit',
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
      throw abortedError();
    throw new ApiError(error instanceof Error ? error.message : String(error), {
      name: error instanceof Error ? error.name : 'TypeError',
    });
  }
  if (!response.ok)
    throw storageError(response.status, await response.text().catch(() => ''));
  options.onProgress?.(file.size, file.size);
}

/** One Storage PUT. XHR reports sent bytes; fetch reports only completion. */
function putDirect(
  target: DirectTarget,
  file: File,
  options: PromptAttachmentUploadOptions,
): Promise<void> {
  throwIfAborted(options.signal);
  const Request = (globalThis as { XMLHttpRequest?: new () => UploadRequest }).XMLHttpRequest;
  return typeof Request === 'function'
    ? putWithXhr(Request, target, file, options)
    : putWithFetch(target, file, options);
}

async function sendDirect(
  projectId: string,
  file: File,
  handle: PromptAttachmentUpload,
  options: PromptAttachmentUploadOptions,
): Promise<PromptAttachmentUpload> {
  let upload = handle;
  let resigned = false;
  options.onProgress?.(0, file.size);
  while (upload.upload.kind === 'direct') {
    const target = upload.upload;
    try {
      await retry(() => putDirect(target, file, options), options.signal);
    } catch (error) {
      const status = storageStatus(error);
      // 409: an earlier PUT whose response was lost stored the object. Completion verifies it.
      if (status !== 409) {
        if (resigned || !(status === 400 || status === 401 || status === 403)) throw error;
        // Storage refused the token (expiry or clock skew). Re-sign the same attachment once.
        resigned = true;
        upload = await resign(projectId, file, upload, options);
        continue;
      }
    }
    upload = { ...upload, received_bytes: file.size };
    options.onUpload?.(upload);
    return upload;
  }
  return sendChunks(projectId, file, upload, options);
}

async function sendChunks(
  projectId: string,
  file: File,
  handle: PromptAttachmentUpload,
  options: PromptAttachmentUploadOptions,
): Promise<PromptAttachmentUpload> {
  if (handle.upload.kind !== 'chunked') throw new Error('Invalid attachment upload handle');
  const chunkSize = handle.upload.chunk_size;
  const endpoint = `${path(projectId)}/${encodeURIComponent(handle.attachment_id)}`;
  let upload = handle;
  while (upload.received_bytes < file.size) {
    throwIfAborted(options.signal);
    const offset = upload.received_bytes;
    const end = Math.min(offset + chunkSize, file.size);
    const chunk = file.slice(offset, end);
    const ack = await retry(
      async () =>
        unwrap(
          await backendApi.putRaw<{ received_bytes: number; size: number }>(
            `${endpoint}/chunks/${offset / chunkSize}`,
            chunk,
            { ...quiet, signal: options.signal, timeout: REQUEST_TIMEOUT_MS },
          ),
          'Failed to upload attachment chunk',
        ),
      options.signal,
    );
    if (ack.size !== file.size || ack.received_bytes !== end)
      throw new Error('Invalid attachment chunk acknowledgment');
    upload = { ...upload, received_bytes: end };
    options.onUpload?.(upload);
    options.onProgress?.(end, file.size);
  }
  return upload;
}

/**
 * Starts on invocation. Platform requests use the host's single auth seam. A
 * direct Storage PUT carries only its signed URL and headers.
 */
export async function uploadPromptAttachment(
  projectId: string,
  file: File,
  options: PromptAttachmentUploadOptions = {},
): Promise<PromptAttachment> {
  if (!projectId) throw new Error('A project is required to upload attachments');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_PROMPT_ATTACHMENT_BYTES)
    throw new Error('Attachment must contain 1 byte to 50 MiB');
  throwIfAborted(options.signal);
  // A retried begin after a lost response leaves one unused row. It expires
  // after 24 hours and counts toward the per-user budget until then.
  let upload = options.resume
    ? checkedHandle({ ...options.resume }, file)
    : checkedHandle(
        {
          ...(await retry(() => begin(projectId, file, options.signal), options.signal)),
          received_bytes: 0,
        },
        file,
      );
  options.onUpload?.(upload);
  if (upload.received_bytes < file.size) {
    if (
      upload.upload.kind === 'direct' &&
      Date.parse(upload.upload.expires_at) - Date.now() < DIRECT_URL_MARGIN_MS
    )
      upload = await resign(projectId, file, upload, options);
    upload =
      upload.upload.kind === 'direct'
        ? await sendDirect(projectId, file, upload, options)
        : await sendChunks(projectId, file, upload, options);
  }
  options.onProcessing?.();
  const endpoint = `${path(projectId)}/${encodeURIComponent(upload.attachment_id)}`;
  try {
    return await retry(
      async () =>
        unwrap(
          await backendApi.post<PromptAttachment>(
            `${endpoint}/complete`,
            {},
            { ...quiet, signal: options.signal, timeout: COMPLETE_TIMEOUT_MS },
          ),
          'Failed to complete attachment upload',
        ),
      options.signal,
      true,
    );
  } catch (error) {
    // Storage holds no object, so the PUT answer did not come from Storage.
    // A resume of this handle must send the file again, not only complete it.
    if (
      upload.upload.kind === 'direct' &&
      error instanceof ApiError &&
      error.code === 'attachment_not_uploaded'
    )
      options.onUpload?.({ ...upload, received_bytes: 0 });
    throw error;
  }
}

export async function deletePromptAttachment(
  projectId: string,
  attachmentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!projectId) throw new Error('A project is required to remove attachments');
  const response = await backendApi.delete(
    `${path(projectId)}/${encodeURIComponent(attachmentId)}`,
    { ...quiet, signal: options.signal },
  );
  if (!response.success) throw response.error ?? new Error('Failed to remove attachment');
}
