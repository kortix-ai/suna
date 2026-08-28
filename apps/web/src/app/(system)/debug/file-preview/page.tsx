'use client';

import dynamic from 'next/dynamic';

/**
 * /debug/file-preview
 *
 * Visual harness for the shared file viewer with a STUB file source, so the
 * markdown source/preview toggle and the thumbnail sizing can be exercised
 * without a live sandbox, a project, or any API. Seeing either for real
 * otherwise needs a running workspace with the right files in it.
 *
 * Not linked from anywhere; just hit /debug/file-preview.
 */
const DebugFilePreviewHarness = dynamic(
  () => import('./harness').then((m) => m.DebugFilePreviewHarness),
  { ssr: false },
);

export default function DebugFilePreviewPage() {
  return <DebugFilePreviewHarness />;
}
