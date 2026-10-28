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
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export interface SharedImageSource {
  uri: string;
  headers?: Record<string, string>;
}

/** Entries hold the URI only: the Authorization header is the user's, one for every file (`latestHeaders`). */
const sharedImages = createImageCache<string>({ maxEntries: 200 });
/** The headers of the most recent load: a new token replaces the header of every cached file. */
let latestHeaders: Record<string, string> | undefined;

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
  // Every later draw, of any cached file, sends the newest token.
  latestHeaders = source.headers;
  const ref = { path: pathKey(sandboxUrl, path), sha256 };
  const known = sharedImages.get(ref);
  const entry = known && known.value === source.uri ? known : sharedImages.put(ref, source.uri);
  if (size && (entry.width !== size.width || entry.height !== size.height)) sharedImages.setSize(entry, size.width, size.height);
}

/** Drops every stored source (a sign-out or an account switch: they carry the old Authorization header). */
export function clearSharedImages(): void {
  sharedImages.clear();
  latestHeaders = undefined;
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
  // One source object while its URI and token hold, so a native image never sees a new source.
  const uri = entry?.value;
  const headers = latestHeaders;
  const source = useMemo(() => (uri ? { uri, headers } : null), [uri, headers]);
  if (!entry || !source) return null;
  return { source, ratio: entry.width && entry.height ? entry.width / entry.height : null };
}
