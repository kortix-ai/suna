'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * The hero: the screen at the playhead. A chunk is a 1 fps video with frame i
 * at i seconds (the Kortix Capture format), so a move inside one chunk is a
 * seek, not a load. Two video elements take turns: the next chunk loads and
 * seeks in the hidden one and swaps in once its frame is on screen, so
 * scrubbing across a chunk boundary never flashes blank.
 */
export function FrameStage({
  src,
  seconds,
  label,
  dimmed,
  children,
}: {
  /** The chunk's signed video URL; null shows only `children`. */
  src: string | null;
  /** Seek position in the chunk's video. */
  seconds: number;
  label: string;
  /** The playhead is off the frame (a gap): keep the last frame, faded. */
  dimmed: boolean;
  children?: ReactNode;
}) {
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [active, setActive] = useState(0);
  const sources = useRef<[string | null, string | null]>([null, null]);
  const base = (url: string | null) => (url ? url.split('?')[0] : null);

  useEffect(() => {
    if (!src) return;
    const cur = refs[active]!.current;
    if (!cur) return;
    const seek = (el: HTMLVideoElement) => {
      const target = seconds + 0.01;
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
    };
    if (base(sources.current[active]) === base(src)) {
      if (cur.readyState >= 1) seek(cur);
      return;
    }
    const nextIdx = active === 0 ? 1 : 0;
    const next = refs[nextIdx]!.current;
    if (!next) return;
    let cancelled = false;
    const onLoaded = () => seek(next);
    const onSeeked = () => {
      if (cancelled) return;
      setActive(nextIdx);
    };
    next.addEventListener('loadedmetadata', onLoaded, { once: true });
    next.addEventListener('seeked', onSeeked, { once: true });
    sources.current[nextIdx] = src;
    next.src = src;
    return () => {
      cancelled = true;
      next.removeEventListener('loadedmetadata', onLoaded);
      next.removeEventListener('seeked', onSeeked);
    };
    // `refs` are stable; `active` flips only after a swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, seconds, active]);

  return (
    <div className="bg-pane relative min-h-0 flex-1 overflow-hidden">
      {[0, 1].map((i) => (
        <video
          key={i}
          ref={refs[i]}
          muted
          playsInline
          preload="auto"
          aria-label={i === active ? label : undefined}
          aria-hidden={i !== active}
          className={
            i === active && src
              ? `duration-fast absolute inset-0 size-full object-contain transition-opacity ${dimmed ? 'opacity-40' : 'opacity-100'}`
              : 'pointer-events-none absolute inset-0 size-full object-contain opacity-0'
          }
        />
      ))}
      {children}
    </div>
  );
}
