/**
 * One automatic reload recovers a stale-deploy chunk-load failure.
 *
 * A deploy replaces the hashed `_next/static/chunks` assets. A tab that holds
 * stale HTML or a stale client bundle then requests chunk URLs the current
 * deployment no longer serves, the import fails, and the nearest error
 * boundary renders the crash card — while a reload re-fetches the current
 * deploy and heals the page. Reported on dev as a full-page crash on a direct
 * navigation to /settings/profile right after a deploy (KRTX-1613).
 *
 * The reload happens exactly once: a second sighting inside the window renders
 * the real error card instead, so a persistent failure (bad deploy, blocked
 * network) can never reload-loop. sessionStorage holds the mark because it
 * survives a reload and dies with the tab. Without storage (disabled in some
 * webviews) there is no guard, so there is no unguarded reload either.
 *
 * Telemetry already filters this class (`sentry.client.config.ts` ignores
 * `ChunkLoadError` and `Failed to fetch`; `browser-noise/rules/chunk-load.ts`
 * classifies the stale runtime shape), so a recovered throw stays silent and
 * the recurring failure only ever shows the card.
 */

/** How long one reload mark suppresses further automatic reloads. */
export const CHUNK_RELOAD_WINDOW_MS = 10_000;

const CHUNK_RELOAD_MARK = 'kortix:chunk-reload-at';

/** The stale webpack runtime lookup, already classified for Sentry in `browser-noise/rules/chunk-load.ts`. */
const STALE_RUNTIME_MESSAGE = "Cannot read properties of undefined (reading 'call')";
const WEBPACK_RUNTIME_CHUNK = /\/_next\/static\/chunks\/webpack-/;

/** Native dynamic-import failure spellings per engine: Chrome, Safari, Firefox. */
const DYNAMIC_IMPORT_PATTERNS = [
  'Failed to fetch dynamically imported module',
  'Importing a module script failed',
  'error loading dynamically imported module',
];

/**
 * Whether the boundary's error is a failed script-chunk load: webpack's
 * `ChunkLoadError` (`Loading chunk <n> failed.`), a native dynamic-import
 * failure, or the stale webpack runtime lookup whose stack points at the
 * runtime chunk. A genuine app error that happens to contain one of these
 * substrings outside a chunk-load context is not matched.
 */
export function isChunkLoadError(error: unknown): boolean {
  const err = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';
  if (name === 'ChunkLoadError' || message.includes('ChunkLoadError')) return true;
  if (/Loading chunk [\s\S]* failed\./.test(message)) return true;
  if (DYNAMIC_IMPORT_PATTERNS.some((pattern) => message.includes(pattern))) return true;
  // The stale runtime TypeError is only a chunk-load failure when the throwing
  // frame is the webpack runtime chunk; the error object carries that in its
  // stack text. A real `.call()` TypeError inside app code has an app stack.
  if (message === STALE_RUNTIME_MESSAGE) {
    return typeof err.stack === 'string' && WEBPACK_RUNTIME_CHUNK.test(err.stack);
  }
  return false;
}

export interface ChunkReloadDeps {
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
}

function browserSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Classify `error` and, on the first chunk-load failure inside the window,
 * trigger one document reload. Returns whether a reload was triggered — the
 * caller renders nothing while it lands, and the plain error card when it
 * returns false.
 */
export function reloadForChunkLoadError(error: unknown, deps: ChunkReloadDeps = {}): boolean {
  if (!isChunkLoadError(error)) return false;
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage !== undefined ? deps.storage : browserSessionStorage();
  if (!storage) return false;
  const reload = deps.reload ?? (() => window.location.reload());
  let mark: string | null = null;
  try {
    mark = storage.getItem(CHUNK_RELOAD_MARK);
  } catch {
    return false;
  }
  const last = mark === null ? null : Number(mark);
  if (last !== null && Number.isFinite(last) && now() - last < CHUNK_RELOAD_WINDOW_MS) {
    return false;
  }
  try {
    storage.setItem(CHUNK_RELOAD_MARK, String(now()));
  } catch {
    return false;
  }
  reload();
  return true;
}
