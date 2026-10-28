/**
 * One in-memory store of loaded images, keyed by path AND by the sha256 of
 * their bytes, so every surface that shows a picture (the image card, the
 * full-screen viewer, a `show` card, a file preview) draws the one already
 * loaded instead of fetching it again. The same bytes saved at two paths (a
 * generated image and its Drive copy) are one entry.
 *
 * Framework-free: the value is whatever the host draws from (a `blob:` URL on
 * the web, a `{ uri, headers }` source on React Native). Bounded: past
 * `maxEntries` or `maxBytes`, the least recently used entry that nothing
 * holds (`retain`) is evicted and handed to `dispose` (the web revokes its
 * object URL there). Path keys are the host's: it scopes them to a sandbox.
 */

/** Where an image lives: its path key, its bytes' sha256, or both. */
export interface ImageCacheRef {
  path?: string | null;
  sha256?: string | null;
}

export interface ImageCacheEntry<V> {
  readonly value: V;
  /** The bytes the value holds in memory; 0 when the host does not know. */
  readonly bytes: number;
  /** The image's natural size, once a host measured it. */
  width: number | null;
  height: number | null;
}

export interface ImageCache<V> {
  /** The entry for `ref`: by sha256 first, then by path. */
  get(ref: ImageCacheRef): ImageCacheEntry<V> | undefined;
  /**
   * Stores `value` under the ref's path and sha256. When the sha256 is already
   * stored, that entry wins: the path is linked to it and `value` is disposed.
   */
  put(ref: ImageCacheRef, value: V, bytes?: number): ImageCacheEntry<V>;
  /** Points `path` at `entry` (the same bytes at another path). */
  link(path: string, entry: ImageCacheEntry<V>): void;
  setSize(entry: ImageCacheEntry<V>, width: number, height: number): void;
  /** Holds `entry` so it is never evicted; returns the release (idempotent). */
  retain(entry: ImageCacheEntry<V>): () => void;
  /** Drops the entry at `path` (a manual refresh); a held entry is disposed on its last release. */
  forget(path: string): void;
  subscribe(listener: () => void): () => void;
}

export interface ImageCacheOptions<V> {
  maxEntries: number;
  maxBytes?: number;
  dispose?: (value: V) => void;
}

interface Slot<V> extends ImageCacheEntry<V> {
  refs: number;
  dead: boolean;
  paths: Set<string>;
  sha256: string | null;
}

export function createImageCache<V>({ maxEntries, maxBytes = Number.POSITIVE_INFINITY, dispose }: ImageCacheOptions<V>): ImageCache<V> {
  // Insertion order is recency: a touched slot moves to the end.
  const slots = new Set<Slot<V>>();
  const byPath = new Map<string, Slot<V>>();
  const bySha = new Map<string, Slot<V>>();
  const listeners = new Set<() => void>();
  let total = 0;
  const emit = () => listeners.forEach((listener) => listener());

  const touch = (slot: Slot<V>) => {
    slots.delete(slot);
    slots.add(slot);
  };
  const drop = (slot: Slot<V>) => {
    if (slot.dead) return;
    slot.dead = true;
    slots.delete(slot);
    total -= slot.bytes;
    for (const path of slot.paths) if (byPath.get(path) === slot) byPath.delete(path);
    if (slot.sha256 && bySha.get(slot.sha256) === slot) bySha.delete(slot.sha256);
    if (slot.refs === 0) dispose?.(slot.value);
  };
  const trim = () => {
    for (const slot of [...slots]) {
      if (slots.size <= maxEntries && total <= maxBytes) return;
      if (slot.refs === 0) drop(slot);
    }
  };
  const linkPath = (path: string, slot: Slot<V>) => {
    const previous = byPath.get(path);
    if (previous && previous !== slot) previous.paths.delete(path);
    byPath.set(path, slot);
    slot.paths.add(path);
  };

  return {
    get: ({ path, sha256 }) => (sha256 && bySha.get(sha256)) || (path ? byPath.get(path) : undefined),
    put({ path, sha256 }, value, bytes = 0) {
      const known = sha256 ? bySha.get(sha256) : undefined;
      if (known) {
        if (path) linkPath(path, known);
        touch(known);
        dispose?.(value);
        emit();
        return known;
      }
      const slot: Slot<V> = { value, bytes, width: null, height: null, refs: 0, dead: false, paths: new Set(), sha256: sha256 ?? null };
      if (path) {
        const previous = byPath.get(path);
        // The path now holds other bytes: the old entry goes once nothing else names it.
        if (previous && previous.paths.size === 1 && !previous.sha256) drop(previous);
        linkPath(path, slot);
      }
      if (sha256) bySha.set(sha256, slot);
      slots.add(slot);
      total += bytes;
      trim();
      emit();
      return slot;
    },
    link(path, entry) {
      const slot = entry as Slot<V>;
      if (slot.dead || byPath.get(path) === slot) return;
      linkPath(path, slot);
      emit();
    },
    setSize(entry, width, height) {
      entry.width = width;
      entry.height = height;
      emit();
    },
    retain(entry) {
      const slot = entry as Slot<V>;
      slot.refs++;
      if (!slot.dead) touch(slot);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        slot.refs--;
        if (slot.refs === 0 && slot.dead) dispose?.(slot.value);
        else trim();
      };
    },
    forget(path) {
      const slot = byPath.get(path);
      if (!slot) return;
      drop(slot);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
