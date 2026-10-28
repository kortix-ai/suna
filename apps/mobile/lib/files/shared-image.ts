/**
 * The app's one store of loaded sandbox images (R38), the mobile half of the
 * web's `useSharedImage`: the native source an image loaded from (`{ uri,
 * headers }`) and its natural size, found by its sandbox path or by the
 * sha256 of its bytes (`createImageCache` from `@kortix/sdk`). The image card
 * stores what it loaded; the file sheet and a `show` card draw that source,
 * which the native image cache already holds, instead of reading the file
 * again (the sheet read it as a blob, then a data URL). The same bytes at
 * another path (a Drive copy) are one entry. Bounded at 200 entries; nothing
 * is held in JS memory but the URL.
 */
import { createImageCache } from '@kortix/sdk';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export interface SharedImageSource {
  uri: string;
  headers?: Record<string, string>;
}

const sharedImages = createImageCache<SharedImageSource>({ maxEntries: 200 });

/** A sandbox path, scoped to its sandbox, with or without the `/workspace/` prefix. */
function pathKey(sandboxUrl: string | undefined, path: string): string {
  return `${sandboxUrl ?? ''}|${path.trim().replace(/^\/?workspace\//, '').replace(/^\/+/, '')}`;
}

/** Stores the source an image loaded from, and its natural size, under its path and sha256. */
export function rememberSharedImage(
  sandboxUrl: string | undefined,
  path: string,
  sha256: string | undefined,
  source: SharedImageSource,
  size?: { width: number; height: number },
): void {
  const ref = { path: pathKey(sandboxUrl, path), sha256 };
  const known = sharedImages.get(ref);
  // The same source with the current token is kept; a new token replaces it,
  // so a later draw never sends an expired Authorization header.
  const same = known && known.value.uri === source.uri && sameHeaders(known.value.headers, source.headers);
  // Dropped by its path: the slot goes with its digest key, and the put stores both again.
  if (known && !same) sharedImages.forget(ref.path);
  const entry = same && known ? known : sharedImages.put(ref, source);
  if (size && (entry.width !== size.width || entry.height !== size.height)) sharedImages.setSize(entry, size.width, size.height);
}

function sameHeaders(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/** Drops every stored source (a sign-out or an account switch: they carry the old Authorization header). */
export function clearSharedImages(): void {
  sharedImages.clear();
}

export interface SharedImage {
  source: SharedImageSource;
  /** Width over height, once measured. */
  ratio: number | null;
}

/**
 * The stored image at `path` or with bytes `sha256`; null on a miss. A hit by
 * sha256 links `path` too, so the copy opened later by its own path is a hit.
 */
export function useSharedImage(sandboxUrl: string | undefined, path: string | null | undefined, sha256?: string): SharedImage | null {
  const key = path ? pathKey(sandboxUrl, path) : null;
  const read = useCallback(() => sharedImages.get({ path: key, sha256 }), [key, sha256]);
  const entry = useSyncExternalStore(sharedImages.subscribe, read, read);
  useEffect(() => {
    if (entry && key) sharedImages.link(key, entry);
  }, [entry, key]);
  if (!entry) return null;
  return { source: entry.value, ratio: entry.width && entry.height ? entry.width / entry.height : null };
}
