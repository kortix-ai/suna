/**
 * The in-progress assistant text, mirrored into `sessionStorage`.
 *
 * Its only consumer restores a streaming prefix after a page refresh, once, and
 * already discards anything older than thirty minutes. That is the whole
 * contract, and it is what makes coalescing safe: the cache is a recovery hint,
 * not a source of truth, and the backend's hydrate replaces it moments later.
 *
 * It used to write on EVERY delta. Each write did `getItem` + `JSON.parse` +
 * `JSON.stringify` + `setItem` of the entire accumulated response — so the cost
 * of caching one answer was quadratic in its length. A 20 KB reply arriving in
 * ~30-character deltas is ~670 writes averaging 10 KB, i.e. several megabytes of
 * synchronous JSON and storage work on the main thread, per response, while the
 * page is also trying to render the stream.
 *
 * Two changes remove it:
 *
 *   1. What was last written is remembered in memory, so the read-back that
 *      guarded against regressions happens once per session key per page rather
 *      than once per delta.
 *   2. Writes are throttled leading-and-trailing. The first delta lands
 *      immediately — a refresh one second into a reply still finds text — and
 *      everything inside the window collapses into one trailing write.
 */

/**
 * How long writes coalesce. Matches the IndexedDB transcript layer next door,
 * and is three orders of magnitude below the consumer's staleness tolerance.
 */
export const STREAM_CACHE_FLUSH_MS = 500;

interface CachePayload {
	messageID: string;
	parentID?: string;
	partID: string;
	text: string;
}

interface CacheEntry {
	messageID: string;
	partID: string;
	/** Longest text accepted for this part — the regression guard, in memory. */
	latestLength: number;
	writtenAt: number;
	timer?: ReturnType<typeof setTimeout>;
	pending?: CachePayload;
}

/**
 * Keyed by the storage object itself rather than held in a bare module map.
 *
 * A page has exactly one `sessionStorage` for its lifetime, so in production
 * this is a plain per-page cache. In tests each case installs a fresh stub and
 * therefore gets fresh state for free — no reset hook, and so no test-only
 * export leaking into a published package.
 */
const STATE = new WeakMap<Storage, Map<string, CacheEntry>>();

/** The one read of real storage: what a previous page load left behind. */
function seedEntry(store: Storage, key: string): CacheEntry {
	const empty: CacheEntry = { messageID: "", partID: "", latestLength: 0, writtenAt: 0 };
	try {
		const raw = store.getItem(key);
		if (!raw) return empty;
		const prev = JSON.parse(raw) as Partial<CachePayload> | null;
		if (!prev || typeof prev.text !== "string") return empty;
		return {
			messageID: prev.messageID ?? "",
			partID: prev.partID ?? "",
			latestLength: prev.text.length,
			writtenAt: 0,
		};
	} catch {
		return empty;
	}
}

function flush(store: Storage, key: string, entry: CacheEntry, payload: CachePayload): void {
	try {
		store.setItem(key, JSON.stringify({ ...payload, updatedAt: Date.now() }));
	} catch {
		// Storage can be full or blocked; the cache is optional either way.
	}
	entry.messageID = payload.messageID;
	entry.partID = payload.partID;
	entry.writtenAt = Date.now();
}

export function writeStreamCache(
	sessionID: string,
	messageID: string,
	partID: string,
	text: string,
	parentID?: string,
) {
	if (typeof window === "undefined") return;
	if (!sessionID || !messageID || !partID || !text) return;

	let store: Storage;
	try {
		store = sessionStorage;
	} catch {
		return;
	}

	let byKey = STATE.get(store);
	if (!byKey) {
		byKey = new Map();
		STATE.set(store, byKey);
	}

	const key = `opencode_stream_cache:${sessionID}`;
	let entry = byKey.get(key);
	if (!entry) {
		entry = seedEntry(store, key);
		byKey.set(key, entry);
	}

	const samePart = entry.messageID === messageID && entry.partID === partID;

	// A stale, shorter snapshot of the SAME part must never regress the cache.
	// Measured against the longest text accepted rather than the last one
	// written, so a pending trailing write is not undone by a late short event.
	if (samePart && text.length <= entry.latestLength) return;
	entry.latestLength = text.length;

	const payload: CachePayload = { messageID, parentID, partID, text };

	// A different part is a different subject: write it now rather than let it
	// wait behind a window opened by the part it replaced.
	if (!samePart) {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.pending = undefined;
		flush(store, key, entry, payload);
		return;
	}

	const elapsed = Date.now() - entry.writtenAt;
	if (elapsed >= STREAM_CACHE_FLUSH_MS) {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.pending = undefined;
		flush(store, key, entry, payload);
		return;
	}

	// Inside the window: keep only the newest text and let one timer land it.
	// `JSON.stringify` is deliberately NOT done here — deferring it is most of
	// the saving, since it is the part that scales with the response.
	entry.pending = payload;
	if (!entry.timer) {
		const self = entry;
		self.timer = setTimeout(() => {
			self.timer = undefined;
			const queued = self.pending;
			self.pending = undefined;
			if (queued) flush(store, key, self, queued);
		}, STREAM_CACHE_FLUSH_MS - elapsed);
	}
}
