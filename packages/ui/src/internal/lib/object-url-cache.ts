/**
 * A bounded cache of object URLs that revokes what it evicts.
 *
 * Both call sites this replaces kept a module-level `Map<string, string>` of
 * `URL.createObjectURL(...)` results with no cap and no `revokeObjectURL`. The
 * reasoning in each was sound as far as it went — revoking on unmount refetches
 * the same bytes every time a panel expands and collapses — but "never revoke"
 * and "never evict" are two decisions, and only the first one was needed. A
 * long session opens dozens of tool outputs and PDF pages, and every blob
 * behind those URLs is pinned for the lifetime of the tab (a session page never
 * unmounts a turn). That retention is a leading suspect for the tab discards
 * behind "my session randomly reloaded".
 *
 * Least-recently-USED, not inserted: re-reading a thumbnail keeps it warm, so
 * expanding and collapsing the same output never refetches, which is the exact
 * property the old comment was protecting.
 */
export class ObjectUrlCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries: number) {
    if (maxEntries < 1) throw new Error('ObjectUrlCache maxEntries must be >= 1');
  }

  get(key: string): string | undefined {
    const url = this.entries.get(key);
    if (url === undefined) return undefined;
    // Re-insert so this key is now the most recent.
    this.entries.delete(key);
    this.entries.set(key, url);
    return url;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Store `url` under `key`, revoking whatever it replaces or evicts. */
  set(key: string, url: string): void {
    const previous = this.entries.get(key);
    if (previous !== undefined && previous !== url) revoke(previous);
    this.entries.delete(key);
    this.entries.set(key, url);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted !== undefined) revoke(evicted);
    }
  }

  /** Visible for tests and for a caller that wants to drop everything. */
  clear(): void {
    for (const url of this.entries.values()) revoke(url);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Not an object URL, or the document is gone. Nothing to release.
  }
}
