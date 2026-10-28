'use client';

import { createImageCache, isRuntimeStartingError, isSessionAttachmentRef } from '@kortix/sdk';
import { binaryBlobKeys, useRuntimeStore } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { fileCaptionKey } from '../../../internal/stores/file-preview-store';
import { useBinaryBlob } from './use-binary-blob';

/**
 * The page's one store of loaded images (R38): an object URL per image, found
 * by its sandbox path or by the sha256 of its bytes. The image card, the
 * full-screen viewer and a `show` card all draw from it, so an image loaded
 * once is never fetched or decoded into a second URL. Entries nothing draws
 * are evicted least recently used past 64 images or 256 MiB, and their URLs
 * revoked.
 *
 * ponytail: a path entry is not dropped when the agent rewrites the file in
 * place (`file.edited` invalidates the blob query, not this store); the
 * viewer's Refresh drops it. Listen to the query cache if in-place image edits
 * become common.
 */
const imageCache = createImageCache<string>({
  maxEntries: 64,
  maxBytes: 256 * 1024 * 1024,
  dispose: (url) => URL.revokeObjectURL(url),
});

/** A sandbox path is scoped to its sandbox; a stored attachment ref is unique on its own. */
function pathKey(serverUrl: string, path: string): string {
  return isSessionAttachmentRef(path) ? path : `${serverUrl}|${fileCaptionKey(path)}`;
}

/** Drops the image at `path` (the viewer's Refresh), so the next draw reads the file again. */
export function forgetSharedImage(serverUrl: string, path: string): void {
  imageCache.forget(pathKey(serverUrl, path));
}

export interface SharedImage {
  /** The image's object URL; null until its bytes are in. */
  url: string | null;
  /** `"<w> / <h>"` once any surface measured the image. */
  naturalRatio: string | null;
  /**
   * The bytes are on the way: a cache miss being read, or the sandbox still
   * starting (its runtime URL not pinned yet, or a waking 503), which the read
   * polls through until the box is up.
   */
  loading: boolean;
  /** A genuine read failure. A host shows "Image unavailable" and `retry`, never this text. */
  error: string | null;
  /** Reads the file again after a genuine failure. */
  retry: () => void;
  /** Records the image's natural size for the next surface that draws it. */
  onNaturalSize: (width: number, height: number) => void;
}

/**
 * The image at `path` (a sandbox path or a stored attachment ref) or with
 * bytes `sha256`, from the shared store. A miss reads the file once
 * (`useBinaryBlob`) and stores it under both keys; a hit by sha256 links
 * `path` too, so a copy opened later by its own path is a hit.
 */
export function useSharedImage(path: string | null, sha256?: string | null): SharedImage {
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());
  const key = path ? pathKey(serverUrl, path) : null;
  const read = useCallback(() => imageCache.get({ path: key, sha256 }), [key, sha256]);
  const entry = useSyncExternalStore(imageCache.subscribe, read, read);
  const file = useBinaryBlob(entry || !path ? null : path);
  const queryClient = useQueryClient();
  // A box still starting is a wait, not a failure (R38): the read keeps polling (`sandboxWakingRefetchInterval`).
  const starting = !!file.error && isRuntimeStartingError(file.error);

  // Stored before paint, so the frame never paints the read's own URL first.
  useLayoutEffect(() => {
    if (file.blob && (key || sha256)) imageCache.put({ path: key, sha256 }, URL.createObjectURL(file.blob), file.blob.size);
  }, [file.blob, key, sha256]);

  // Held while drawn, so it is never revoked under an <img>.
  useEffect(() => {
    if (!entry) return;
    if (key) imageCache.link(key, entry);
    return imageCache.retain(entry);
  }, [entry, key]);

  const onNaturalSize = useCallback(
    (width: number, height: number) => {
      if (entry && (entry.width !== width || entry.height !== height)) imageCache.setSize(entry, width, height);
    },
    [entry],
  );

  const retry = useCallback(() => {
    if (!path) return;
    void queryClient.refetchQueries({
      queryKey: isSessionAttachmentRef(path) ? ['session-attachment', 'blob', path] : binaryBlobKeys.file(serverUrl, path),
    });
  }, [path, queryClient, serverUrl]);

  return useMemo(
    () => ({
      // The read's URL covers the one render before the store has it.
      url: entry?.value ?? file.blobUrl,
      naturalRatio: entry?.width && entry.height ? `${entry.width} / ${entry.height}` : null,
      loading: !entry && !!path && (file.isLoading || starting),
      error: entry || starting ? null : file.error,
      onNaturalSize,
      retry,
    }),
    [entry, file.blobUrl, file.isLoading, file.error, starting, path, onNaturalSize, retry],
  );
}
