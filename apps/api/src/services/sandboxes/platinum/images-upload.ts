import { config } from '../../../lib/config';
import { assertSafePresignedUploadUrl, parseUploadHostAllowlist, sanitizeUrlForLog } from '../../snapshots/providers/upload-url-guard';

const UPLOAD_ATTEMPTS = 3;
const UPLOAD_MIN_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS_PER_GIB = 60_000;

/** 408 (S3 idle-timeout), our own AbortSignal timeout, and 5xx are transient
 *  — worth a fresh presign + retry. Anything else (400/401/403/404/...) is a
 *  real error and must NOT be retried. */
function isRetryableUploadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number(err.message.match(/-> (\d{3})\b/)?.[1]);
  return status === 408 || status >= 500;
}

/**
 * Presigned-PUT build-context uploader, hardened against Scaleway S3's idle
 * timeout on large (100s-of-MB) contexts: a mid-transfer stall used to trip a
 * bare 408 with no retry, forcing a full re-upload (or failing the build
 * outright) further up in `isRetryablePlatinumBuildError`'s BUILD_ATTEMPTS
 * loop. Two things fix that here instead: (1) a per-attempt timeout scaled to
 * file size, so a genuinely-large upload isn't cut off before it could ever
 * finish; (2) on a transient failure (408 / timeout / 5xx), RE-PRESIGN for a
 * fresh `upload_url` + `context_s3_key` rather than retrying the same
 * (possibly already-consumed) presigned URL. The returned `context_s3_key` is
 * whichever attempt actually succeeded — callers MUST register that key, not
 * the one from their original presign call, or they'll upload to key A and
 * tell `from-build`/`from-patch` to look for key B.
 *
 * `presignFn()` itself is called INSIDE the try/catch (not before it): a
 * transient failure of the presign call (e.g. a 500/timeout from Platinum's
 * own `/v1/templates/from-build/presign`) is a real-world possibility, same
 * transport as the PUT, and must go through the same isRetryableUploadError
 * decision + retry loop — not bypass it and fail the whole upload on attempt 1.
 */
/**
 * Guard options for the presigned upload URL, derived from deployment env:
 *  - local-dev (`INTERNAL_KORTIX_ENV=dev`) allows http + loopback (MinIO),
 *  - `KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST` pins the object-storage origin(s).
 * Exported so the uploader default and tests share one source of truth.
 */
export function uploadUrlGuardOptsFromEnv(): { allowLocal: boolean; allowedHosts: string[] } {
  return {
    allowLocal: config.INTERNAL_KORTIX_ENV === 'dev',
    allowedHosts: parseUploadHostAllowlist(process.env.KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST),
  };
}

export async function uploadWithRetry(
  presignFn: () => Promise<{ upload_url: string; context_s3_key: string }>,
  tarPath: string,
  guardOpts: { allowLocal: boolean; allowedHosts: string[] } = uploadUrlGuardOptsFromEnv(),
): Promise<string> {
  const sizeBytes = Bun.file(tarPath).size;
  const timeoutMs = Math.max(UPLOAD_MIN_TIMEOUT_MS, Math.ceil((sizeBytes / 1024 ** 3) * UPLOAD_TIMEOUT_MS_PER_GIB));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const { upload_url, context_s3_key } = await presignFn();
      // PHASE 2: validate the presigned URL BEFORE streaming the context —
      // https-only outside local-dev, no loopback/link-local/private/multicast
      // SSRF targets, and origin-pinned when an allowlist is configured. An
      // invalid URL is NOT retryable (a fresh presign returns the same origin).
      let safeUrl: URL;
      try {
        safeUrl = assertSafePresignedUploadUrl(upload_url, guardOpts);
      } catch (guardErr) {
        // Wrap as a terminal (non-retryable) error — the sanitized message
        // never carries the presign signature.
        throw new UploadUrlRejectedError(guardErr instanceof Error ? guardErr.message : String(guardErr));
      }
      const put = await fetch(safeUrl, {
        method: 'PUT',
        body: Bun.file(tarPath),
        signal: AbortSignal.timeout(timeoutMs),
        // Refuse a 30x bounce of the signed PUT to a different origin.
        redirect: 'error',
      });
      if (put.ok) return context_s3_key;
      // Log only the sanitized URL (query/signature stripped).
      throw new Error(
        `build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)} (${sanitizeUrlForLog(upload_url)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryableUploadError(err) || attempt === UPLOAD_ATTEMPTS) {
        throw new Error(`build-context upload failed after ${attempt}/${UPLOAD_ATTEMPTS} attempt(s): ${msg}`);
      }
      console.warn(`[snapshots] platinum build-context upload attempt ${attempt}/${UPLOAD_ATTEMPTS} failed — re-presigning + retrying: ${msg.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  // Unreachable: the loop above always returns or throws by UPLOAD_ATTEMPTS.
  throw new Error('build-context upload failed');
}

/** A presigned upload URL that failed the security guard — terminal, never
 *  retried (a re-presign returns the same rejected origin/scheme). */
export class UploadUrlRejectedError extends Error {
  constructor(message: string) {
    super(`presigned upload URL rejected: ${message}`);
    this.name = 'UploadUrlRejectedError';
  }
}

/** Parse Platinum's 409 template_in_use refusal into a sandbox count. */
export function templateInUseCount(message: string): number | null {
  if (!/ -> 409(?:\s|$)/.test(message) || !message.includes('template_in_use')) return null;
  const count = Number(/"in_use"\s*:\s*(\d+)/.exec(message)?.[1]);
  return Number.isFinite(count) && count > 0 ? count : 1;
}
