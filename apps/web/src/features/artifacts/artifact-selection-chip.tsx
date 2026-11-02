'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { Kbd, KbdGroup } from '@kortix/ui/kbd';
import { ChatCircleIcon } from '@phosphor-icons/react';
import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { ArtifactAnnotationSelection } from './artifact-annotation-controller';

type Box = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/** The space between the selection and the chip, and between the chip and the frame edge. */
const GAP = 8;

/**
 * Where the Comment chip goes, in frame coordinates: centered above the selection, below it
 * when the top has no room, and inside the frame. null when the selection is out of view (the
 * person scrolled it away). Without a box (the page could not measure one) it sits top center.
 */
export function selectionChipPosition(
  selection: Box | null,
  frame: Size,
  chip: Size,
): { x: number; y: number } | null {
  const clamp = (value: number, max: number) => Math.max(GAP, Math.min(value, max - GAP));
  if (!selection)
    return { x: clamp((frame.width - chip.width) / 2, frame.width - chip.width), y: GAP };
  if (
    selection.y + selection.height <= 0 ||
    selection.y >= frame.height ||
    selection.x + selection.width <= 0 ||
    selection.x >= frame.width
  )
    return null;
  const above = selection.y - GAP - chip.height;
  const below = selection.y + selection.height + GAP;
  const y = above >= GAP ? above : below + chip.height <= frame.height - GAP ? below : GAP;
  const x = selection.x + selection.width / 2 - chip.width / 2;
  return { x: clamp(x, frame.width - chip.width), y };
}

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** True for ⌘⌥M (Ctrl+Alt+M off a Mac): comment on the current selection. */
export function isCommentShortcut(
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
) {
  return (
    event.code === 'KeyM' && event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey)
  );
}

/** An offer's identity: two offers of the same selection compare equal. */
export function selectionOfferKey(offer: ArtifactAnnotationSelection): string {
  return offer.state === 'candidate' ? JSON.stringify(offer.anchor) : 'too_long';
}

/**
 * The chip after the page reports its selection. `dismissed` is the key of the offer the person
 * dismissed (Escape, a press elsewhere). A scroll or resize in the page withdraws the offer
 * (`moved`) and the next layout offers the same selection again: it stays hidden. A press in the
 * page or a selection that is gone (`moved` false) forgets the dismissal. `hidden`: keys the
 * parent never shows a chip for (draw mode, the passage the composer already holds).
 */
export function nextSelectionOffer(
  next: ArtifactAnnotationSelection | null,
  moved: boolean,
  dismissed: string,
  hidden: (key: string) => boolean,
): { offer: ArtifactAnnotationSelection | null; dismissed: string } {
  if (!next) return { offer: null, dismissed: moved ? dismissed : '' };
  const key = selectionOfferKey(next);
  return { offer: key === dismissed || hidden(key) ? null : next, dismissed };
}

/**
 * The floating chip beside a text selection on an HTML page. Selecting text only offers it:
 * the comments panel opens when the person clicks the chip or presses the shortcut. The
 * parent draws it from the page's geometry; the page never sees it.
 */
export const ArtifactSelectionChip = forwardRef<
  HTMLDivElement,
  {
    rect: Box | null;
    frame: Size;
    /** The chip's action; without one the chip is a note (a selection too long to comment on). */
    onComment?: () => void;
    label: string;
    hint?: string;
  }
>(function ArtifactSelectionChip({ rect, frame, onComment, label, hint }, ref) {
  const own = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const node = own.current;
    if (node) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, [label, onComment]);
  const place = selectionChipPosition(rect, frame, size ?? { width: 0, height: 0 });
  if (!place) return null;
  const mac = isMac();
  let content: ReactNode = (
    <p className="text-muted-foreground max-w-64 px-2 py-1 text-xs text-pretty" role="status">
      {label}
    </p>
  );
  if (onComment)
    content = (
      <Hint
        side="top"
        sideOffset={6}
        content={
          <span className="flex items-center gap-2">
            {hint ?? label}
            <KbdGroup>
              <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>{mac ? '⌥' : 'Alt'}</Kbd>
              <Kbd>M</Kbd>
            </KbdGroup>
          </span>
        }
      >
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-keyshortcuts={mac ? 'Meta+Alt+M' : 'Control+Alt+M'}
          onClick={onComment}
        >
          <ChatCircleIcon className="size-3.5 shrink-0" aria-hidden />
          {label}
        </Button>
      </Hint>
    );
  return (
    <div
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      data-artifact-selection-chip
      className="bg-popover text-popover-foreground absolute z-10 flex items-center rounded-lg border p-1 shadow-md"
      style={{ left: place.x, top: place.y, visibility: size ? undefined : 'hidden' }}
    >
      {content}
    </div>
  );
});
