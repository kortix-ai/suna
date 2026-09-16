import { safeEgressFetch, UnsafeEgressError } from '../../shared/ssrf-guard';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../lib/session-attachment-input';

class RemoteImageError extends Error {}

function matchesImageSignature(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/jpeg':
      return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    default:
      return false;
  }
}

export async function readRemotePiImage(
  url: string,
  mime: string,
  signal: AbortSignal,
): Promise<Buffer> {
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await new Promise<Response>((resolve, reject) => {
      const abort = () =>
        reject(new RemoteImageError('remote image download cancelled or timed out'));
      signal.addEventListener('abort', abort, { once: true });
      void safeEgressFetch(url, { signal, headers: { accept: mime } })
        .then((value) => {
          if (signal.aborted) void value.body?.cancel().catch(() => {});
          resolve(value);
        }, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted();
    if (response.status !== 200) throw new RemoteImageError('remote image download failed');
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== mime)
      throw new RemoteImageError('remote image MIME type does not match the attachment');
    if (Number(response.headers.get('content-length')) > MAX_SESSION_ATTACHMENT_BYTES)
      throw new RemoteImageError('image attachment exceeds 8 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new RemoteImageError('remote image attachment is empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SESSION_ATTACHMENT_BYTES) {
          await reader.cancel().catch(() => {});
          throw new RemoteImageError('image attachment exceeds 8 MiB');
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
    if (size === 0) throw new RemoteImageError('remote image attachment is empty');
    const content = Buffer.concat(chunks, size);
    if (!matchesImageSignature(content, mime))
      throw new RemoteImageError('remote image bytes do not match the attachment MIME type');
    return content;
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (signal.aborted) throw new RemoteImageError('remote image download cancelled or timed out');
    if (error instanceof RemoteImageError) throw error;
    if (error instanceof UnsafeEgressError)
      throw new RemoteImageError('remote images require a safe public HTTPS URL');
    throw new RemoteImageError('remote image download failed');
  }
}
