'use client';

/**
 * Fallback file-preview modal for surfaces with NO session side panel — see
 * `app-file-preview-modal.tsx` for why it exists.
 *
 * This file is the gate only: one store subscription. The modal body pulls the
 * whole file viewer (CodeMirror, KaTeX, diffs, markdown, Shiki — ~3.4 MB raw),
 * so it loads on the first `openPreview` that lands here, never on page load.
 * It stays mounted at the root because `openPreview` has call sites outside
 * `(app)` too (admin, share and debug pages render the same tool renderers and
 * clickable paths).
 */

import { useFilePreviewStore } from '@/stores/file-preview-store';
import dynamic from 'next/dynamic';

const AppFilePreviewModal = dynamic(
  () => import('./app-file-preview-modal').then((mod) => mod.AppFilePreviewModal),
  { ssr: false },
);

export function AppFilePreviewHost() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  if (!isOpen || !filePath) return null;
  return <AppFilePreviewModal />;
}
