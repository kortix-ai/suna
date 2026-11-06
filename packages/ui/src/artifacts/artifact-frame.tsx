'use client';

import { forwardRef, useLayoutEffect, useState } from 'react';

import { claimFrame, ensureFrame } from '../apps/app-preview-pool';
import { ARTIFACT_FRAME_ALLOW, ARTIFACT_IFRAME_SANDBOX } from './frame-policy';

/**
 * The frame's canvas: what shows where the page has not painted yet. Open, a
 * third-party page with no background of its own reads as a white page, as it
 * would in a browser tab, in both themes. As a card preview it is the app's
 * background: a preview that is still painting (on load, on a tab switch)
 * must not flash white in the dark theme.
 */
const ARTIFACT_CANVAS = 'bg-white';
const PREVIEW_CANVAS = 'bg-background';

/**
 * An artifact page. The frame lives in the project's frame pool
 * (`@kortix/ui/apps`, shared with App previews): it loads once, in the
 * background or on first show, and moves between the gallery card and the
 * viewer without reloading. `frameKey` changes after a save, so an edit loads
 * the new page. The ref is the slot (the viewer's full screen target).
 */
export const ArtifactFrame = forwardRef<
  HTMLDivElement,
  {
    frameKey: string;
    src: string;
    title: string;
    className?: string;
    preview?: boolean;
  }
>(function ArtifactFrame({ frameKey, src, title, className, preview }, ref) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const interactive = !preview;
  const frameClass = `${className ?? ''} ${preview ? PREVIEW_CANVAS : ARTIFACT_CANVAS}`;

  useLayoutEffect(() => {
    if (!slot) return;
    ensureArtifactFrame(frameKey, src, title);
    const release = claimFrame(frameKey, slot, {
      className: frameClass,
      style: {},
      interactive,
    });
    // The viewer hands the keyboard to the page, so a deck's arrow keys work at once.
    const claimed =
      Array.from(slot.querySelectorAll('iframe')).find(
        (candidate) => candidate.dataset.frameKey === frameKey,
      ) ?? null;
    // A page that reloads under the person (a new version saved by someone else) keeps the
    // keyboard where it was: it takes it only if the page it replaces had it, and never from a
    // field the person types in.
    const page = artifactOf(frameKey);
    const previous = releasedFocus.get(page);
    releasedFocus.delete(page);
    const reload = !!previous && Date.now() - previous.at < RELOAD_MS;
    if (interactive && (!reload || previous.focused) && !typingElsewhere())
      claimed?.focus({ preventScroll: true });
    return () => {
      releasedFocus.set(page, {
        at: Date.now(),
        focused: !!claimed && claimed.ownerDocument.activeElement === claimed,
      });
      release();
    };
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

/** A frame claimed this soon after the same artifact's frame left is a reload in place. */
const RELOAD_MS = 15_000;
// One browser tab: whether each artifact's last released frame had the keyboard.
const releasedFocus = new Map<string, { at: number; focused: boolean }>();
/** `artifact:<id>` of a frame key (`artifact:<id>:<version>`). */
const artifactOf = (frameKey: string) => frameKey.split(':').slice(0, 2).join(':');

/** The keyboard is in a text field or an editor of this document. */
function typingElsewhere(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable || active.matches('input, textarea, select'))
  );
}

/** Create (and park) the pooled frame for an artifact page; a no-op when it exists. */
export function ensureArtifactFrame(key: string, src: string, title: string): void {
  ensureFrame(key, src, {
    title,
    sandbox: ARTIFACT_IFRAME_SANDBOX,
    allow: ARTIFACT_FRAME_ALLOW,
    testid: 'artifact-frame',
    // The page sees this app's origin, never the path with project ids.
    referrerPolicy: 'strict-origin',
  });
}
