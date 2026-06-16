'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SessionStartStage } from '@/lib/projects-client';

/**
 * The ONE loader shown while a session's Kortix Computer comes up. All the heavy
 * lifting (provision / wake / OpenCode readiness + pin) is server-side behind
 * POST /sessions/:id/start — this just reports the real stage it returns.
 *
 * Gated behind a short delay: a warm session opens in well under a second, and a
 * brief re-render/refetch shouldn't flash this whole screen OVER an already-loaded
 * session. So we render NOTHING for the first ~700ms — only a genuinely slow
 * (cold) boot ever shows the loader. Same trick the old SessionLoadingSkeleton
 * used; without it the loader "overlays the session for a slight sec".
 */
const LOADER_DELAY_MS = 700;

const PHASES: { key: string; label: string }[] = [
  { key: 'provisioning', label: 'Provisioning your computer' },
  { key: 'starting', label: 'Starting the workspace' },
  { key: 'connecting', label: 'Connecting' },
];

function phaseIndex(stage: SessionStartStage): number {
  if (stage === 'provisioning') return 0;
  if (stage === 'starting') return 1;
  return 2; // ready/connecting — waiting on the active-server switch + health
}

export function SessionStartingLoader({
  stage = 'provisioning',
}: {
  stage?: SessionStartStage;
}) {
  // Hold the loader back briefly so warm opens + transient re-renders never flash
  // it. Timer starts on mount; a flash that unmounts before it fires shows nothing.
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), LOADER_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;

  const active = phaseIndex(stage);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-xs flex-col gap-5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <h2 className="text-foreground/90 text-sm font-medium">Kortix Computer is starting</h2>
        </div>

        <ol className="flex flex-col gap-2.5">
          {PHASES.map((p, i) => {
            const done = i < active;
            const current = i === active;
            return (
              <li key={p.key} className="flex items-center gap-2.5 text-xs">
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                    done
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : current
                        ? 'border-foreground/40'
                        : 'border-border/60',
                  )}
                >
                  {done ? (
                    <Check className="h-2.5 w-2.5" />
                  ) : current ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    'transition-colors',
                    done
                      ? 'text-muted-foreground/70'
                      : current
                        ? 'text-foreground/90'
                        : 'text-muted-foreground/50',
                  )}
                >
                  {p.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
          This usually takes a few seconds — your workspace and files are being prepared.
        </p>
      </div>
    </div>
  );
}
