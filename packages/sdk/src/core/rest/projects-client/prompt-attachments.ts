import { backendApi, ApiError } from '../../http/api-client';
import { abortableDelay } from '../../http/abort';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  PROMPT_ATTACHMENT_CHUNK_BYTES,
} from '../../attachments/limits';
import { unwrap } from './shared';

/** Private project storage metadata. No signed URL or runtime path crosses this boundary. */
export interface PromptAttachment {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  expires_at: string;
}

/** Retain this handle to resume the same upload after an ambiguous response. */
export interface PromptAttachmentUpload extends PromptAttachment {
  chunk_size: number;
  received_bytes: number;
}

export interface PromptAttachmentUploadOptions {
  signal?: AbortSignal;
  resume?: PromptAttachmentUpload;
  onUpload?: (upload: PromptAttachmentUpload) => void;
  /** Durable bytes only. 100% still requires completion before Send. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  onProcessing?: () => void;
}

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/attachments`;
const quiet = { showErrors: false };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ApiError('Request aborted', {
      name: 'AbortError',
      code: 'ABORTED',
    });
}

function retryable(error: unknown, completion: boolean): boolean {
  if (!(error instanceof ApiError) || error.code === 'ABORTED' || error.code === 'TIMEOUT')
    return false;
  if (completion && error.status === 409) return error.code === 'attachment_processing';
  return (
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504 ||
    (!completion && error.name === 'TypeError')
  );
}

async function retry<T>(
  operation: () => Promise<T>,
  completion: boolean,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + (completion ? 5 * 60_000 : 30_000);
  const attempts = completion ? 151 : 3;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      if (
        signal?.aborted ||
        !retryable(error, completion) ||
        attempt + 1 >= attempts ||
        Date.now() >= deadline
      )
        throw error;
      try {
        await abortableDelay(completion ? 2000 : 250 * 2 ** attempt, signal);
      } catch {
        throwIfAborted(signal);
        throw error;
      }
    }
  }
}

/** Starts on invocation; sequential chunks use fetch and the host's single auth seam. */
export async function uploadPromptAttachment(
  projectId: string,
  file: File,
  options: PromptAttachmentUploadOptions = {},
): Promise<PromptAttachment> {
  if (!projectId) throw new Error('A project is required to upload attachments');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_PROMPT_ATTACHMENT_BYTES)
    throw new Error('Attachment must contain 1 byte to 50 MiB');
  throwIfAborted(options.signal);
  const request = { ...quiet, signal: options.signal, timeout: 30_000 };
  let upload = options.resume
    ? { ...options.resume }
    : {
        ...unwrap(
          await backendApi.post<PromptAttachment & { chunk_size: number }>(
            path(projectId),
            {
              filename: file.name,
              mime: file.type || 'application/octet-stream',
              size: file.size,
            },
            request,
          ),
          'Failed to start attachment upload',
        ),
        received_bytes: 0,
      };
  if (
    !upload.attachment_id ||
    upload.size !== file.size ||
    !Number.isSafeInteger(upload.chunk_size) ||
    upload.chunk_size <= 0 ||
    upload.chunk_size > PROMPT_ATTACHMENT_CHUNK_BYTES ||
    !Number.isSafeInteger(upload.received_bytes) ||
    upload.received_bytes < 0 ||
    upload.received_bytes > file.size ||
    (upload.received_bytes !== file.size && upload.received_bytes % upload.chunk_size !== 0)
  )
    throw new Error('Invalid attachment upload handle');
  options.onUpload?.(upload);
  const endpoint = `${path(projectId)}/${encodeURIComponent(upload.attachment_id)}`;
  while (upload.received_bytes < file.size) {
    throwIfAborted(options.signal);
    const offset = upload.received_bytes;
    const end = Math.min(offset + upload.chunk_size, file.size);
    const chunk = file.slice(offset, end);
    const ack = await retry(
      async () =>
        unwrap(
          await backendApi.putRaw<{ received_bytes: number; size: number }>(
            `${endpoint}/chunks/${offset / upload.chunk_size}`,
            chunk,
            request,
          ),
          'Failed to upload attachment chunk',
        ),
      false,
      options.signal,
    );
    if (ack.size !== file.size || ack.received_bytes !== end)
      throw new Error('Invalid attachment chunk acknowledgment');
    upload = { ...upload, received_bytes: ack.received_bytes };
    options.onUpload?.(upload);
    options.onProgress?.(upload.received_bytes, file.size);
  }
  options.onProcessing?.();
  return retry(
    async () =>
      unwrap(
        await backendApi.post<PromptAttachment>(`${endpoint}/complete`, {}, request),
        'Failed to complete attachment upload',
      ),
    true,
    options.signal,
  );
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
