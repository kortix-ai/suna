'use client';

/**
 * A session's drive files, read through the drive API.
 *
 * A session mounts folders of the project's Files at `/drives/<mount>` in its
 * box. The box daemon serves only the workspace, so a viewer that reads
 * `/drives/me/cat.gif` from it gets a 403 (or, stripped to `drives/me/cat.gif`,
 * a 404 under /workspace). The same bytes are one drive read away: the
 * session's mounts (`GET /projects/:p/sessions/:s/drives`) name the drive and
 * folder behind each mount path, and the drive API applies the caller's own
 * folder access, exactly as the Files page does.
 *
 * The session page registers its scope; the workspace file client
 * (`features/files/api/runtime-files`) asks here first for any path under a
 * mount, so every viewer, card, renderer and download takes the drive source
 * without knowing about it.
 */

import type { FileContent } from '@/features/file-browser/types';
import { attachmentMime } from '@/features/session/attachment-mime';
import { readDriveFile, type SessionDrive } from '@kortix/sdk';
import { sessionDrivesQueryOptions } from '@kortix/sdk/react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';

export interface SessionDriveFile {
  driveId: string;
  /** The file's path in its drive: `/Users/ana/cat.gif`. */
  path: string;
}

type DriveMount = Pick<SessionDrive, 'driveId' | 'mountPath' | 'subdir'>;

const trimSlashes = (p: string) => p.replace(/\/+$/, '');

/**
 * `/drives/me/a.gif`, or the relative `drives/me/a.gif` an agent writes, as the
 * absolute mount path. Anything else, and any path with a `.` or `..` segment,
 * is not a drive file: null.
 */
export function sessionDriveMountPath(filePath: string | null | undefined): string | null {
  const raw = (filePath ?? '').trim();
  const abs = raw.startsWith('/drives/') ? raw : raw.startsWith('drives/') ? `/${raw}` : null;
  if (!abs) return null;
  const segments = abs.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return `/${segments.join('/')}`;
}

/** The drive file behind `filePath` in a session with these mounts, or null. */
export function resolveSessionDriveFile(
  filePath: string | null | undefined,
  mounts: readonly DriveMount[],
): SessionDriveFile | null {
  const abs = sessionDriveMountPath(filePath);
  if (!abs) return null;
  let best: DriveMount | null = null;
  for (const mount of mounts) {
    const root = trimSlashes(mount.mountPath);
    if (!root || (abs !== root && !abs.startsWith(`${root}/`))) continue;
    if (!best || root.length > trimSlashes(best.mountPath).length) best = mount;
  }
  if (!best) return null;
  const rest = abs.slice(trimSlashes(best.mountPath).length);
  return { driveId: best.driveId, path: `${trimSlashes(best.subdir)}${rest}` || '/' };
}

interface DriveFilesScope {
  projectId: string;
  sessionId: string;
  queryClient: QueryClient;
}

let scope: DriveFilesScope | null = null;

/** Make `next` the session drive paths resolve against; returns its undo. */
export function setSessionDriveFilesScope(next: DriveFilesScope): () => void {
  scope = next;
  return () => {
    if (scope === next) scope = null;
  };
}

/** Make the open session's mounts the ones drive paths resolve against. */
export function useSessionDriveFilesScope(projectId: string, sessionId: string) {
  const queryClient = useQueryClient();
  // A layout effect: it lands before any file query's first fetch.
  useLayoutEffect(
    () => setSessionDriveFilesScope({ projectId, sessionId, queryClient }),
    [projectId, sessionId, queryClient],
  );
}

export function SessionDriveFilesScope({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  useSessionDriveFilesScope(projectId, sessionId);
  return null;
}

/**
 * The drive file behind `filePath` in the open session, or null when the path
 * is not under one of its mounts (or no session is open). Only a path under
 * `/drives` costs a lookup, and that one is the cached mounts query.
 */
export async function sessionDriveFileFor(filePath: string): Promise<SessionDriveFile | null> {
  const current = scope;
  if (!current || !sessionDriveMountPath(filePath)) return null;
  const { queryKey, queryFn, staleTime } = sessionDrivesQueryOptions(current.projectId, current.sessionId, true);
  try {
    const mounts = await current.queryClient.fetchQuery({ queryKey, queryFn, staleTime });
    return resolveSessionDriveFile(filePath, mounts.drives);
  } catch {
    return null;
  }
}

/**
 * A drive file's bytes, typed by its name: the API serves every file as
 * octet-stream, and the previewers pick on the type (images, PDF).
 */
export function typedDriveBlob(blob: Blob, filePath: string): Blob {
  const type = attachmentMime(blob.type === 'application/octet-stream' ? '' : blob.type, filePath);
  return type === blob.type ? blob : new Blob([blob], { type });
}

const TEXT_LIMIT = 2 * 1024 * 1024;

/** Bytes as the viewer's content shape: UTF-8 text when they are, base64 otherwise. */
export async function blobToFileContent(blob: Blob): Promise<FileContent> {
  const head = new Uint8Array(await blob.slice(0, TEXT_LIMIT + 1).arrayBuffer());
  if (head.length <= TEXT_LIMIT) {
    try {
      return { type: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(head) };
    } catch {
      // Not text: fall through to base64.
    }
  }
  const all = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < all.length; i += 0x8000) binary += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return { type: 'binary', content: btoa(binary), encoding: 'base64', mimeType: blob.type || undefined };
}

export async function readSessionDriveBlob(file: SessionDriveFile, signal?: AbortSignal): Promise<Blob> {
  const { blob } = await readDriveFile(file.driveId, file.path, signal);
  return typedDriveBlob(blob, file.path);
}

export async function readSessionDriveContent(file: SessionDriveFile, signal?: AbortSignal): Promise<FileContent> {
  return blobToFileContent(await readSessionDriveBlob(file, signal));
}
