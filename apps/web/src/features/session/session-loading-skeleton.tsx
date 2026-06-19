'use client';

import { useEffect, useState } from 'react';
import { Paperclip, ArrowUp } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Only show the center loader if the session is taking a noticeable moment to
 * become usable. Warm-pool sessions open in ~0.5s, so the loader would just
 * flash — gating it behind a short delay makes those feel instant (no spinner),
 * while genuinely-cold boots still get feedback.
 */
const LOADER_DELAY_MS = 700;

/**
 * Skeleton shown while a session is still loading / provisioning / waiting
 * for the sandbox server-store switch. Mirrors the real SessionChat shell:
 *
 *   - Full-height column on `bg-background`.
 *   - Center area is a quiet, centered loader (no copy, no progress).
 *   - Bottom is a non-interactive copy of the chat input — same card
 *     dimensions and toolbar layout as the real input — with skeleton
 *     placeholders where the agent/model/variant pickers normally sit.
 *
 * Why this shape: the page used to flash a giant "Connecting…" pill in the
 * middle. Once the real chat mounts the input snaps in at the bottom, which
 * reads as a layout jump. This component reserves that exact bottom slot so
 * the transition is just "skeleton → input", no shift.
 */
export function SessionLoadingSkeleton() {
  // Hold the loader back briefly — a warm session is usable before this fires,
  // so it never shows a spinner and reads as instant.
  const [showLoader, setShowLoader] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowLoader(true), LOADER_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Center: quiet loader where messages will eventually render — only once
          the load is slow enough to warrant feedback (see LOADER_DELAY_MS). */}
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {showLoader && <KortixLoader size="small" />}
      </div>

      {/* Chat input skeleton — matches the real SessionChatInput shell so
          nothing jumps when the live input swaps in. */}
      <div className="mx-auto w-full max-w-[52rem] relative z-10 shrink-0 px-2 sm:px-4 pb-6">
        <div className="w-full bg-card border border-border rounded-[24px] overflow-visible relative z-10">
          <div className="relative flex flex-col w-full gap-2 overflow-visible">
            {/* Textarea area — empty space matching real input height (pt-4 pb-6, min-h-[72px]) */}
            <div className="px-3.5">
              <div className="min-h-[72px]" aria-hidden />
            </div>

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between mb-1.5 pl-2 pr-1.5 gap-1">
              {/* LEFT: Attach (real-looking, disabled) + Agent + Model placeholders */}
              <div className="flex items-center gap-1 min-w-0">
                <div
                  className="inline-flex items-center justify-center h-8 w-8 rounded-xl text-muted-foreground/40"
                  aria-hidden
                >
                  <Paperclip className="h-4 w-4" strokeWidth={2} />
                </div>
                <Skeleton className="h-7 w-20 rounded-xl" />
                <Skeleton className="h-7 w-28 rounded-xl" />
              </div>

              {/* RIGHT: TokenProgress placeholder + Submit button (disabled-looking) */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Skeleton className="h-7 w-10 rounded-xl" />
                <div
                  className="flex-shrink-0 h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground/40"
                  aria-hidden
                >
                  <ArrowUp className="size-4" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
