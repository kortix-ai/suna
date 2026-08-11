'use client';

import { Button } from '@/components/ui/marketing/button';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/** The one command in the docs, the README and the CLI page. Keep them equal. */
const INSTALL_COMMAND = 'curl -fsSL https://dosco.live/install | bash';

/** Long enough to register, short enough not to strand the button in a fake state. */
const COPIED_MS = 1600;

/**
 * A persistent way to act, once the reader is past the hero.
 *
 * It carries the install command and one button, not three. The navbar is
 * sticky and already offers Get started and Request demo on every scroll
 * position, so a floating bar repeating both would be the same two actions
 * twice on one screen. The command is the thing the navbar cannot do, so it is
 * what earns the space; Get started rides along because a copy-only bar gives a
 * non-developer nothing.
 *
 * Both anchors are ids on the page rather than pixel offsets, so the pill keeps
 * its meaning when a section is reordered or grows.
 */
export function ScrollCtaPill(): ReactNode {
  const { user } = useAuth();

  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Read both anchors on every frame rather than latching IntersectionObserver
    // booleans. The closing CTA is taller than the viewport, so "is it
    // intersecting" is true for a long stretch and never cleanly false again —
    // comparing rects is the only reading that stays correct at every offset.
    let frame = 0;

    const measure = () => {
      frame = 0;
      const trigger = document.getElementById('cta-pill-anchor');
      const closing = document.getElementById('cta');
      if (!trigger || !closing) return;

      const viewport = window.innerHeight;
      const past = trigger.getBoundingClientRect().top < viewport * 0.65;
      const atEnd = closing.getBoundingClientRect().top < viewport * 0.75;
      setVisible(past && !atEnd);
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
    } catch {
      return; // clipboard denied — say nothing rather than claim a copy
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? latestProjectPath(user?.id) : '/auth';
  }, [user]);

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 sm:bottom-7',
        'motion-safe:transition-[opacity,transform] motion-safe:duration-300',
        visible
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-3 opacity-0 motion-reduce:hidden',
      )}
      aria-hidden={!visible}
    >
      <div className="bg-popover flex items-center gap-1 rounded-full border p-1 shadow-sm">
        <button
          type="button"
          onClick={handleCopy}
          tabIndex={visible ? 0 : -1}
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-xs transition-colors"
        >
          {/* The command is the point on desktop; on a phone it will not fit,
              so the label carries the meaning instead. */}
          <span className="hidden sm:inline">{INSTALL_COMMAND}</span>
          <span className="sm:hidden">Copy install</span>
          {copied ? (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <CopyIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="sr-only">
            {copied ? 'Install command copied' : `Copy the install command: ${INSTALL_COMMAND}`}
          </span>
        </button>

        <Button
          size="sm"
          onClick={handleLaunch}
          tabIndex={visible ? 0 : -1}
          className="rounded-full"
        >
          Get started
        </Button>
      </div>
    </div>
  );
}
