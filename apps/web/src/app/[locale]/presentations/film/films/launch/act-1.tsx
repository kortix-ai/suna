'use client';

import { KortixLogo } from '@/components/ui/kortix-logo';
import { IconFrame } from '@/components/ui/marketing/icon-frame';
import { ChatCircleIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { useFrame } from '../../engine/film';
import { ease, fall, interp, rise } from '../../engine/time';
import { Headline, Words } from './parts';

/**
 * Beat 1 — the problem, in three lines. Every line is the kortix-brand
 * kit's problem statement (`concepts.md`): the models got good, they forget you, and the options
 * are "a toy or a cage".
 */
export function ColdOpen() {
  const f = useFrame();
  const a = f < 118 ? rise(f, 0) : fall(f, 110, { blur: 8 });
  const b = f < 222 ? rise(f, 118, { blur: 8 }) : fall(f, 222, { blur: 8 });
  const rule = interp(f, 228, 262, 0, 1, ease.outExpo);

  return (
    <div className="absolute inset-0 grid place-items-center">
      {f < 128 ? (
        <div className="absolute" style={{ opacity: a.opacity, filter: a.filter }}>
          <Headline lead="The models got good." f={f} at={10} />
        </div>
      ) : null}

      {f >= 112 && f < 236 ? (
        <div className="absolute max-w-4xl text-center" style={{ opacity: b.opacity, filter: b.filter }}>
          <Headline lead="They still wake up" rest="with no memory of you." f={f} at={118} stack />
        </div>
      ) : null}

      {f >= 226 ? (
        <div className="absolute inset-0 grid grid-cols-2">
          <div className="flex flex-col items-center justify-center gap-8">
            <div className="text-muted-foreground" style={rise(f, 240, { scale: 0.92 })}>
              <div className="border-border bg-popover flex items-center gap-2 rounded-full border px-4 py-2 text-sm">
                <ChatCircleIcon className="size-4" />
                How can I help you today?
              </div>
            </div>
            <h2 className="text-6xl font-medium tracking-tight">
              <Words text="A toy." f={f} at={232} />
            </h2>
          </div>
          <div className="flex flex-col items-center justify-center gap-8">
            <div className="text-muted-foreground" style={rise(f, 270, { scale: 0.92 })}>
              <div className="border-border bg-popover grid size-10 place-items-center rounded-md border">
                <LockSimpleIcon className="size-5" />
              </div>
            </div>
            <h2 className="text-6xl font-medium tracking-tight">
              <Words text="Or a cage." f={f} at={262} className="text-muted-foreground" />
            </h2>
          </div>
          <div
            className="bg-border absolute top-1/2 left-1/2 h-64 w-px -translate-1/2"
            style={{ transform: `translate(-50%, -50%) scaleY(${rule})` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Beat 2 — the mark lands on the drop, orbits into place, then lifts to make
 * room for the tagline. The mark is the site's own `IconFrame` + logo.
 */
export function Reveal() {
  const f = useFrame();
  const lift = interp(f, 76, 116, 0, 1, ease.inOutCubic);
  const turnY = interp(f, 0, 80, 32, 0);
  const turnX = interp(f, 0, 80, -14, 0);

  return (
    <div className="absolute inset-0 grid place-items-center" style={{ perspective: 1400 }}>
      <div
        className="absolute size-44"
        style={{
          opacity: interp(f, 0, 14, 0, 1, ease.outQuad),
          filter: `blur(${interp(f, 0, 22, 14, 0)}px)`,
          transform: `translateY(${-150 * lift}px) scale(${interp(f, 0, 56, 1.12, 1) * (1 - 0.5 * lift)}) rotateY(${turnY}deg) rotateX(${turnX}deg)`,
        }}
      >
        <IconFrame>
          <KortixLogo variant="icon" />
        </IconFrame>
      </div>

      <div className="absolute top-1/2 mt-6 flex max-w-4xl flex-col items-center gap-5 text-center">
        <Headline lead="The open-source" rest="AI Operating System" f={f} at={92} stack />
        <p className="text-muted-foreground max-w-2xl text-xl leading-relaxed" style={rise(f, 132)}>
          Your agents, skills, memory and connectors — in one repo you own.
        </p>
      </div>
    </div>
  );
}
