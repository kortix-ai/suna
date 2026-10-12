/**
 * Kortix Capture rules shared by the API, the web, the desktop page and the
 * CLI: one owner for each, framework-free (also `@kortix/sdk/capture-rules`,
 * which the API imports). The engine keeps its own copy of the matching side.
 */

/** What a device records, in display order. */
export const CAPTURE_LAYERS = ['screen', 'actions', 'audio'] as const;
export type CaptureLayer = (typeof CAPTURE_LAYERS)[number];

/** The engine's built-in exclusion categories, in display order. */
export const CAPTURE_EXCLUSION_GROUPS = ['password_managers', 'messaging', 'banking'] as const;
export type CaptureExclusionGroup = (typeof CAPTURE_EXCLUSION_GROUPS)[number];

/** Upper bounds of the account's retention settings. */
export const CAPTURE_RETENTION_LIMITS = { localHours: 24 * 365, remoteDays: 3650 } as const;

/**
 * The screen frame intervals an organization can set (`recording.interval_ms`),
 * shortest first. A device saves a frame only when the screen changed, and an
 * unchanged screen every 30 s.
 */
export const CAPTURE_FRAME_INTERVALS_MS = [500, 1000, 2000, 5000, 10000] as const;

/** The resolutions an organization can set (`recording.max_height`): the frame height in pixels, at most. */
export const CAPTURE_MAX_HEIGHTS = [720, 1080, 1440, 2160] as const;
export type CaptureMaxHeight = (typeof CAPTURE_MAX_HEIGHTS)[number];

/** What a device uses while the policy sets no interval or resolution (`null`). */
export const CAPTURE_DEVICE_DEFAULTS = { intervalMs: 2000, maxHeight: 1440 } as const;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A website as Capture stores it: the host, lowercase, without scheme, port,
 * path, `www.` or a trailing dot. `https://www.Bank.example/login` →
 * `bank.example`. Null when the input names no website.
 */
export function normalizeCaptureDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return HOST.test(host) ? host : null;
}

/**
 * An app as Capture stores it: a macOS bundle id or a Windows/Linux program
 * name. Spaces only in a Windows program (`proton pass.exe`), as the engine
 * allows. Null for an empty, over-long or flag-like (`-x`) value, or one with
 * control characters.
 */
export function normalizeCaptureAppId(input: string): string | null {
  const id = input.trim();
  // eslint-disable-next-line no-control-regex
  if (!id || id.length > 255 || id.startsWith('-') || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return /\s/.test(id) && !id.toLowerCase().endsWith('.exe') ? null : id;
}
