'use client';

import { createImageCache, isRuntimeStartingError, isSessionAttachmentRef } from '@kortix/sdk';
import { binaryBlobKeys, useRuntimeStore } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useCurrentAccountStore } from '../../../internal/stores/current-account-store';
import { useBinaryBlob } from './use-binary-blob';

/**
 * The page's shared images (R38). Two stores, one per key:
 *
 * - **By path: React Query's blob cache** (`useBinaryBlob`, `binaryBlobKeys`).
 *   The image card, the full-screen viewer, a `show` card and a Files preview
 *   read ONE query per sandbox file. Every invalidation that already exists
 *   reaches them all: `file.edited`, the turn end, the show card's Refresh and
 *   the viewer's Refresh refetch it, and a file rewritten in place draws its
 *   new bytes everywhere (`keepBlobIfUnchanged` keeps unchanged bytes the same
 *   Blob, so nothing reloads for them).
 * - **By sha256: `byDigest`.** Bytes whose digest the tool output named, after
 *   the digest is checked against the bytes. An image already loaded under one
 *   path draws at once under another path with the same bytes (a Drive copy),
 *   with no read. Content-addressed and verified, so it never goes stale.
 *   Evicted least recently used past 64 images or 256 MiB.
 *
 * One object URL per Blob, shared by every surface that draws it, so a second
 * surface never decodes the image again. It is revoked about 1 s after the last
 * surface lets it go.
 *
 * Bound: an image on screen is never evicted. Its Blob stays while a surface
 * draws it, so memory is the images mounted at once plus `byDigest`'s 256 MiB.
 * This is the same as before R38, when each mount held its own blob URL.
 */
const byDigest = createImageCache<Blob>({ maxEntries: 64, maxBytes: 256 * 1024 * 1024 });

// One object URL per Blob. Revoked a moment after its last release, so a
// StrictMode remount (release, then acquire in the same tick) and a render that
// never commits keep a live URL instead of a revoked one.
const urls = new Map<Blob, { url: string; refs: number }>();
const naturalRatios = new WeakMap<Blob, string>();
const REVOKE_GRACE_MS = 1000;

function urlFor(blob: Blob): string {
  let held = urls.get(blob);
  if (!held) {
    held = { url: URL.createObjectURL(blob), refs: 0 };
    urls.set(blob, held);
    scheduleRevoke(blob);
  }
  return held.url;
}

function scheduleRevoke(blob: Blob) {
  setTimeout(() => {
    const held = urls.get(blob);
    if (!held || held.refs > 0) return;
    URL.revokeObjectURL(held.url);
    urls.delete(blob);
  }, REVOKE_GRACE_MS);
}

/**
 * Drops every shared image: the digests, and the URL of every image no surface
 * draws (the rest go when their surface unmounts). Runs on a sign-out and an
 * account switch.
 */
export function clearSharedImages(): void {
  byDigest.clear();
  for (const [blob, held] of urls) {
    if (held.refs > 0) continue;
    URL.revokeObjectURL(held.url);
    urls.delete(blob);
  }
}

// A sign-out clears the selected account; an account switch changes it.
useCurrentAccountStore.subscribe((state, previous) => {
  if (state.selectedAccountId !== previous.selectedAccountId) clearSharedImages();
});

/** The bytes a digest disagreed with, read again once each (never a loop). */
const rereadOnce = new WeakSet<Blob>();

/** `useBinaryBlob`'s query key for `path`. */
function blobKey(serverUrl: string, path: string): readonly unknown[] {
  return isSessionAttachmentRef(path) ? ['session-attachment', 'blob', path] : binaryBlobKeys.file(serverUrl, path);
}

/** The lowercase hex sha256 of `blob`, or null when it cannot be computed (no Web Crypto, over 32 MiB). */
async function digestOf(blob: Blob): Promise<string | null> {
  if (blob.size > 32 * 1024 * 1024 || !globalThis.crypto?.subtle) return null;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface SharedImage {
  /** The image's object URL; null until its bytes are in. */
  url: string | null;
  /** `"<w> / <h>"` once any surface measured the image. */
  naturalRatio: string | null;
  /**
   * The bytes are on the way: a read in flight, or the session runtime still
   * starting (its URL not pinned yet, a waking 503), polled with a backoff for
   * about 2 min.
   */
  loading: boolean;
  /** A genuine read failure, or a wait that ran out. A host shows "Image unavailable" and `retry`, never this text. */
  error: string | null;
  /** Reads the file again, from a fresh wait. */
  retry: () => void;
  /** Records the image's natural size for the next surface that draws it. */
  onNaturalSize: (width: number, height: number) => void;
}

/**
 * The image at `path` (a sandbox path or a stored attachment ref), or the
 * bytes with digest `sha256`. A digest already in `byDigest` draws at once and
 * reads nothing. Otherwise the file is read through its one shared query, and
 * bytes whose digest matches `sha256` join `byDigest`.
 */
export function useSharedImage(path: string | null, sha256?: string | null): SharedImage {
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());
  const read = useCallback(() => (sha256 ? byDigest.get({ sha256 })?.value : undefined), [sha256]);
  const pinned = useSyncExternalStore(byDigest.subscribe, read, read);
  const file = useBinaryBlob(pinned || !path ? null : path, { imageWait: true });
  const queryClient = useQueryClient();
  const blob = pinned ?? file.blob;

  // Trust a digest only once the bytes match it: the file may have changed
  // after the tool hashed it, and a wrong entry would draw under every later
  // lookup. Cached bytes that do not match are read again once: the output
  // names newer bytes than the cache holds (the file was rewritten).
  useEffect(() => {
    const read = file.blob;
    if (!read || !sha256 || !path) return;
    let live = true;
    void digestOf(read).then((digest) => {
      if (!live || digest === null) return;
      if (digest === sha256) byDigest.put({ sha256 }, read, read.size);
      else if (!rereadOnce.has(read)) {
        rereadOnce.add(read);
        void queryClient.invalidateQueries({ queryKey: blobKey(serverUrl, path) });
      }
    });
    return () => {
      live = false;
    };
  }, [file.blob, sha256, path, queryClient, serverUrl]);

  // Held while drawn, so the URL is never revoked under an <img>.
  useEffect(() => {
    if (!blob) return;
    const held = urls.get(blob);
    if (!held) return;
    held.refs++;
    return () => {
      held.refs--;
      if (held.refs === 0) scheduleRevoke(blob);
    };
  }, [blob]);

  const starting = !!file.error && isRuntimeStartingError(file.error) && !file.waitedOut;

  const retry = useCallback(() => {
    if (!path) return;
    // A reset, not a refetch: the wait's failure count starts over.
    void queryClient.resetQueries({ queryKey: blobKey(serverUrl, path) });
  }, [path, queryClient, serverUrl]);

  const onNaturalSize = useCallback(
    (width: number, height: number) => {
      if (blob) naturalRatios.set(blob, `${width} / ${height}`);
    },
    [blob],
  );

  return useMemo(
    () => ({
      // The read's own URL covers a render with no Blob in hand (a server render).
      url: blob ? urlFor(blob) : file.blobUrl,
      naturalRatio: blob ? (naturalRatios.get(blob) ?? null) : null,
      loading: !blob && !!path && (file.isLoading || starting),
      error: blob || starting ? null : file.waitedOut ? 'unavailable' : file.error,
      retry,
      onNaturalSize,
    }),
    [blob, file.blobUrl, file.isLoading, file.error, file.waitedOut, starting, path, retry, onNaturalSize],
  );
}
