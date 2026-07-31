'use client';

import { AnimatePresence, motion } from 'motion/react';
import dynamic from 'next/dynamic';
import { useCallback, useRef, useState } from 'react';

import { KortixLogo } from '@/components/ui/kortix-logo';

import { COPY, LAYERS } from './content';
import { useRollSound } from './use-roll-sound';

/**
 * Standalone page — deliberately outside the marketing shell and outside the
 * theme. It is always black, so colors here are literal rather than semantic
 * tokens, matching the other standalone canvases (/rauch, /game-of-life).
 */

// three + cannon are heavy and touch `document` while building textures — keep
// them off the server render and out of the shared bundle.
const DieScene = dynamic(() => import('./die-scene'), {
  ssr: false,
  loading: () => <div className="h-full w-full" aria-hidden />,
});

export function DiceStage() {
  // Starts at 1 so the die is already in the air when the page opens.
  const [rollToken, setRollToken] = useState(1);
  const [spinToken, setSpinToken] = useState(0);
  const [slot, setSlot] = useState<number | null>(null);
  const [hinted, setHinted] = useState(false);
  const { muted, toggleMuted, playThrow, playImpact, playSettle } =
    useRollSound();

  const throwDie = useCallback(() => {
    setRollToken((t) => t + 1);
    playThrow();
  }, [playThrow]);

  const spinDie = useCallback(() => {
    setSpinToken((t) => t + 1);
    playThrow();
  }, [playThrow]);

  const handleSettle = useCallback(
    (value: number) => {
      // Only fires when the die rests on a face it was not already on, so the
      // copy stays put while the die is being pushed around.
      setSlot(value);
      playSettle();
    },
    [playSettle],
  );

  const layer = slot ? (LAYERS.find((l) => l.slot === slot) ?? null) : null;

  return (
    <div className="relative h-full w-full bg-black text-white">
      <div className="absolute inset-0">
        <DieScene
          rollToken={rollToken}
          spinToken={spinToken}
          onSettle={handleSettle}
          onImpact={playImpact}
          onFirstDrag={() => setHinted(true)}
        />
      </div>

      {/* Chrome. Nothing here swallows a pointer except the controls. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6 sm:p-10">
        <header className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {/* Renders in currentColor, so it picks up the white here. */}
            <KortixLogo variant="icon" size={26} className="text-white" />
            <div>
              <p className="text-sm font-medium tracking-tight text-white">
                {COPY.wordmark}
              </p>
              <p className="mt-0.5 text-sm text-white/40">{COPY.title}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleMuted}
            aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
            aria-pressed={!muted}
            className="pointer-events-auto cursor-pointer text-xs tracking-tight text-white/40 transition-colors hover:text-white"
          >
            {muted ? 'Sound off' : 'Sound on'}
          </button>
        </header>

        <footer className="flex items-end justify-between gap-8">
          {/* The layer copy is the payload of the whole page — set it big. */}
          <div className="min-h-[16rem] max-w-2xl sm:min-h-[15rem]">
            <AnimatePresence mode="wait">
              {layer ? (
                <motion.div
                  key={layer.slot}
                  initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
                  transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
                >
                  <p className="font-mono text-sm tabular-nums text-white/45">
                    {layer.ordinal}
                  </p>
                  <h1 className="mt-3 text-4xl font-medium tracking-tight text-white sm:text-5xl lg:text-6xl">
                    {layer.title}
                  </h1>
                  <p className="mt-3 text-lg tracking-tight text-white/60 sm:text-xl">
                    {layer.teaser}
                  </p>
                  <p className="mt-5 text-base leading-relaxed text-balance text-white/85 sm:text-lg">
                    {layer.body}
                  </p>
                </motion.div>
              ) : (
                <motion.p
                  key="lede"
                  initial={{ opacity: 0, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(6px)' }}
                  transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
                  className="max-w-xl text-lg leading-relaxed text-balance text-white/60 sm:text-xl"
                >
                  {COPY.lede}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            {/* The hint retires itself once the visitor has dragged once. */}
            <AnimatePresence>
              {!hinted ? (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="text-xs tracking-tight text-white/35"
                >
                  {COPY.hint}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <button
              type="button"
              onClick={spinDie}
              className="pointer-events-auto shrink-0 cursor-pointer rounded-full border border-white/20 px-5 py-2 text-xs tracking-tight text-white/70 transition-colors hover:border-white/50 hover:text-white active:scale-[0.98]"
            >
              {COPY.spin}
            </button>
            <button
              type="button"
              onClick={throwDie}
              className="pointer-events-auto shrink-0 cursor-pointer rounded-full border border-white/20 px-5 py-2 text-xs tracking-tight text-white/70 transition-colors hover:border-white/50 hover:text-white active:scale-[0.98]"
            >
              {COPY.throw}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
