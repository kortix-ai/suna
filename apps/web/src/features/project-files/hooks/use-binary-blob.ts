'use client';

import { useMemo } from 'react';

/**
 * Binary blob loader — stubbed for project-files (read-only).
 *
 * `GET /projects/:id/files/content` returns JSON `{content: string}` built
 * from `git show` stdout (apps/api `git/files.ts` → `getFileAtRef`), so bytes
 * that are not valid UTF-8 are already lossy by the time they reach the
 * client. There is no raw-bytes read for a project file: `/files/archive`
 * streams real bytes but runs `git archive --format=zip <ref>:<path>`, which
 * needs a TREE and fails for a single file.
 *
 * So every binary category is unpreviewable on this surface — PDF, image,
 * docx, video, and (since archives became browsable) zip. Consumers see the
 * message below rather than a mangled text render.
 *
 * TODO: add `GET /projects/:id/files/raw` (git cat-file blob) + its audit
 * label and routes.generated.json entry, an SDK fetch, and swap this stub for
 * it. That one endpoint unblocks every category above at once.
 */

export const binaryBlobKeys = {
  all: ['project-files', 'binary-blob'] as const,
  file: (projectId: string, ref: string, filePath: string) =>
    ['project-files', 'binary-blob', projectId, ref, filePath] as const,
};

export function useBinaryBlob(_filePath: string | null): {
  blobUrl: string | null;
  blob: Blob | null;
  isLoading: boolean;
  error: string | null;
} {
  return useMemo(
    () => ({
      blobUrl: null,
      blob: null,
      isLoading: false,
      // User-facing: this string is rendered verbatim as the viewer's error
      // body, and Download is a real control in the toolbar beside it.
      error: "This file can't be previewed here yet — download it to open it.",
    }),
    [],
  );
}
