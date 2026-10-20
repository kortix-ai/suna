/**
 * The newest published Kortix Capture version, read from the release's
 * `capture-update.json` (.agents/skills/kortix-capture/references/release-runbook.md).
 * Fleet health flags a computer older than it. An unreachable or malformed
 * manifest answers the last known version, else null: no computer is then
 * flagged for its version.
 */
import { config } from '../config';
import { logger } from '../lib/logger';

const TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

// replica-local: a cache of one public manifest; every replica fetches it on its own.
const cache: { version: string | null; at: number } = { version: null, at: 0 };
let inflight: Promise<string | null> | null = null;

/** The `version` of a `capture-update.json` body, or null. */
export function manifestVersion(body: unknown): string | null {
  const version = (body as { version?: unknown } | null)?.version;
  return typeof version === 'string' && /^v?\d+\.\d+\.\d+/.test(version) ? version.replace(/^v/, '') : null;
}

export async function latestCaptureVersion(now = Date.now()): Promise<string | null> {
  const url = config.KORTIX_CAPTURE_UPDATE_MANIFEST_URL;
  if (!url) return null;
  if (cache.at && now - cache.at < TTL_MS) return cache.version;
  inflight ??= (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache.version = manifestVersion(await res.json()) ?? cache.version;
    } catch (error) {
      logger.warn('[capture] update manifest unavailable', { error: String(error) });
    }
    cache.at = Date.now();
    return cache.version;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
