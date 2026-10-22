'use client';

import { useEffect } from 'react';

type DragLike = Pick<DragEvent, 'defaultPrevented' | 'dataTransfer' | 'preventDefault'>;

/**
 * Refuses a file drag that no drop zone claimed.
 *
 * The browser opens a file dropped where nothing cancels the drag: the tab
 * leaves the page, and unsent attachments and drafts are lost. A drop zone
 * (the composer, the file tree, Files) claims a drag by cancelling its
 * `dragover` and `drop`. This runs on `window`, after those handlers, so it
 * leaves a claimed drag alone and shows the "no drop" cursor everywhere else.
 */
export function refuseStrayFileDrag(event: DragLike): void {
  if (event.defaultPrevented) return;
  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
}

export function FileDropGuard() {
  useEffect(() => {
    window.addEventListener('dragover', refuseStrayFileDrag);
    window.addEventListener('drop', refuseStrayFileDrag);
    return () => {
      window.removeEventListener('dragover', refuseStrayFileDrag);
      window.removeEventListener('drop', refuseStrayFileDrag);
    };
  }, []);

  return null;
}
