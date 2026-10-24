'use client';

import { forwardRef, useLayoutEffect, useState } from 'react';

import { claimFrame, ensureFrame } from '../apps/app-preview-pool';
import { ARTIFACT_FRAME_ALLOW, ARTIFACT_IFRAME_SANDBOX } from './frame-policy';

/**
 * The frame's canvas: a third-party page with no background of its own reads
 * as a white page, as it would in a browser tab, in both themes.
 */
const ARTIFACT_CANVAS = 'bg-white';

/**
 * An artifact page. The frame lives in the project's frame pool
 * (`@kortix/ui/apps`, shared with App previews): it loads once, in the
 * background or on first show, and moves between the gallery card and the
 * viewer without reloading. `frameKey` changes after a save, so an edit loads
 * the new page. The ref is the slot (the viewer's full screen target).
 */
export const ArtifactFrame = forwardRef<
  HTMLDivElement,
  { frameKey: string; src: string; title: string; className?: string; preview?: boolean }
>(function ArtifactFrame({ frameKey, src, title, className, preview }, ref) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const interactive = !preview;
  const frameClass = `${className ?? ''} ${ARTIFACT_CANVAS}`;

  useLayoutEffect(() => {
    if (!slot) return;
    ensureArtifactFrame(frameKey, src, title);
    const release = claimFrame(frameKey, slot, { className: frameClass, style: {}, interactive });
    // The viewer hands the keyboard to the page, so a deck's arrow keys work at once.
    if (interactive) slot.querySelector('iframe')?.focus({ preventScroll: true });
    return release;
    // The URL is read once per key: a refetch must not reload the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, slot, interactive, frameClass]);

  return (
    <div
      ref={(node) => {
        setSlot(node);
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      className="absolute inset-0"
    />
  );
});

/** Create (and park) the pooled frame for an artifact page; a no-op when it exists. */
export function ensureArtifactFrame(key: string, src: string, title: string): void {
  ensureFrame(key, src, {
    title,
    sandbox: ARTIFACT_IFRAME_SANDBOX,
    allow: ARTIFACT_FRAME_ALLOW,
    testid: 'artifact-frame',
    referrerPolicy: 'no-referrer',
  });
}
