import { createClient } from '@supabase/supabase-js';
import { ArtifactCommentScreenshotError, ARTIFACT_SCREENSHOT_LIMITS } from './comment-screenshot-validation';

const BUCKET = 'session-attachments';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT = new RegExp(`^(${UUID})/artifact-comments/(${UUID})[.](png|webp)$`);
const unavailable = () => new ArtifactCommentScreenshotError(503, 'screenshot_storage_unavailable', 'Screenshot storage is unavailable. Retry this request.');
export const screenshotNotFound = () => new ArtifactCommentScreenshotError(404, 'screenshot_not_found', 'Screenshot not found');
const missing = (error: unknown) => ['404', 'not_found', 'NoSuchKey', 'NoSuchBucket'].includes(String((error as { statusCode?: string; status?: number; code?: string } | null)?.statusCode ?? (error as { status?: number } | null)?.status ?? (error as { code?: string } | null)?.code));

export function screenshotObjectKey(projectId: string, commentId: string, extension: 'png' | 'webp'): string {
  const key = `${projectId}/artifact-comments/${commentId}.${extension}`;
  if (!OBJECT.test(key)) throw screenshotNotFound();
  return key;
}
export function screenshotKeyMatches(key: string, projectId: string, commentId?: string): boolean {
  const match = OBJECT.exec(key);
  return !!match && match[1] === projectId && (!commentId || match[2] === commentId);
}
interface Bucket {
  upload(key: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean; cacheControl: string }): Promise<{ error: unknown }>;
  createSignedUrl(key: string, seconds: number): Promise<{ data?: { signedUrl?: string } | null; error: unknown }>;
  remove(keys: string[]): Promise<{ error: unknown }>;
}
interface Storage { from(bucket: string): Bucket }

async function boundedBytes(response: Response): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > ARTIFACT_SCREENSHOT_LIMITS.bytes) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ARTIFACT_SCREENSHOT_LIMITS.bytes) { await reader.cancel(); throw unavailable(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function createArtifactScreenshotStore(storage: Storage, origin: string, fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch) {
  const bucket = () => storage.from(BUCKET);
  return {
    async put(key: string, image: { bytes: Uint8Array; mime: 'image/png' | 'image/webp' }): Promise<void> {
      if (!OBJECT.test(key)) throw screenshotNotFound();
      try {
        const { error } = await bucket().upload(key, image.bytes, { contentType: image.mime, upsert: false, cacheControl: '0' });
        if (error) throw unavailable();
      } catch { throw unavailable(); }
    },
    async read(key: string): Promise<{ bytes: Uint8Array; mime: 'image/png' | 'image/webp' }> {
      if (!OBJECT.test(key)) throw screenshotNotFound();
      try {
        const signed = await bucket().createSignedUrl(key, 60);
        if (signed.error || !signed.data?.signedUrl) throw missing(signed.error) ? screenshotNotFound() : unavailable();
        const url = new URL(signed.data.signedUrl);
        if (url.origin !== new URL(origin).origin) throw unavailable();
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (response.status === 404) throw screenshotNotFound();
        if (!response.ok) throw unavailable();
        const bytes = await boundedBytes(response);
        const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
        if (key.endsWith('.png') ? !png : !webp) throw unavailable();
        return { bytes, mime: png ? 'image/png' : 'image/webp' };
      } catch (error) { if (error instanceof ArtifactCommentScreenshotError) throw error; throw unavailable(); }
    },
    async remove(key: string): Promise<void> {
      if (!OBJECT.test(key)) throw screenshotNotFound();
      try {
        const { error } = await bucket().remove([key]);
        if (error && !missing(error)) throw unavailable();
      } catch (error) { if (missing(error)) return; throw unavailable(); }
    },
  };
}
let store: ReturnType<typeof createArtifactScreenshotStore> | undefined;
export async function artifactScreenshotStore() {
  if (!store) {
    const { config } = await import('../config');
    const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }), { preconnect: fetch.preconnect }) },
    });
    store = createArtifactScreenshotStore(client.storage, config.SUPABASE_URL);
  }
  return store;
}
