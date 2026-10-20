'use client';

import { lazy, Suspense } from 'react';

import { useFilePreviewStore } from '../internal/stores/file-preview-store';

// The viewer pulls CodeMirror, KaTeX, Shiki and the diff renderer. It loads on
// the first open, never with the page. See `file-preview-dialog.tsx`.
const FilePreviewDialog = lazy(() =>
  import('./file-preview-dialog').then((mod) => ({ default: mod.FilePreviewDialog })),
);

/**
 * The file preview for a page with no session side panel: one store
 * subscription, and the dialog code on the first open. Mount it once.
 */
export function FilePreviewHost() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  if (!isOpen || !filePath) return null;
  return (
    <Suspense fallback={null}>
      <FilePreviewDialog />
    </Suspense>
  );
}
