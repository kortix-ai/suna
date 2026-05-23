'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

const SYMBOL =
  'M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z';

const BIOS_LINES: { text: string; bold?: boolean }[] = [
  { text: 'KORTIX BIOS v2.0.1', bold: true },
  { text: '' },
  { text: 'CPU: Kortix Inference Engine X1 @ 3.80 GHz' },
  { text: 'Memory test................. OK' },
  { text: 'Neural cores............... 8/8 online' },
  { text: 'Agent runtime.............. initialized' },
  { text: 'Tool registry.............. 47 tools loaded' },
  { text: 'Secure enclave............. active' },
  { text: 'Mounting workspace......... done' },
  { text: 'Connecting to services..... done' },
  { text: '' },
  { text: 'All systems nominal. Starting KORTIX OS...' },
];

type Phase = 'bios' | 'logo';

interface BootOverlayProps {
  onComplete: () => void;
}

export function BootOverlay({ onComplete }: BootOverlayProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [phase, setPhase] = useState<Phase>('bios');
  const [visibleLines, setVisibleLines] = useState(0);
  const [progressFill, setProgressFill] = useState(false);
  const [biosReady, setBiosReady] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bootTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Boot sound
  useEffect(() => {
    const audio = new Audio('/sounds/kortix/startup.mp3');
    audio.volume = 0.6;
    audio.preload = 'auto';
    audioRef.current = audio;
    const timers = bootTimers.current;
    return () => {
      audio.pause();
      audioRef.current = null;
      timers.forEach(clearTimeout);
    };
  }, []);

  // Start BIOS lines on mount
  useEffect(() => {
    const t = bootTimers.current;
    BIOS_LINES.forEach((_, i) => {
      t.push(setTimeout(() => setVisibleLines(i + 1), 100 + i * 160));
    });
    const allLinesMs = 100 + (BIOS_LINES.length - 1) * 160 + 300;
    t.push(setTimeout(() => setBiosReady(true), allLinesMs));
  }, []);

  const continueBoot = useCallback(() => {
    if (phase !== 'bios' || !biosReady) return;
    audioRef.current?.play().catch(() => {});
    setPhase('logo');
    const t = bootTimers.current;
    t.push(setTimeout(() => setProgressFill(true), 200));
    t.push(setTimeout(() => onComplete(), 3400));
  }, [phase, biosReady, onComplete]);

  // Auto-continue 600ms after BIOS finishes
  useEffect(() => {
    if (phase !== 'bios' || !biosReady) return;
    const id = setTimeout(() => continueBoot(), 600);
    return () => clearTimeout(id);
  }, [phase, biosReady, continueBoot]);

  // Enter key skips BIOS
  useEffect(() => {
    const handler = () => continueBoot();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [continueBoot]);

  return (
    <div className="fixed inset-0 z-[100] bg-background overflow-hidden">
      <AnimatePresence mode="wait">
        {/* BIOS POST screen */}
        {phase === 'bios' && (
          <motion.div
            key="bios"
            className="absolute inset-0 p-8 sm:p-12"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            <div className="font-mono text-sm sm:text-sm leading-relaxed">
              {BIOS_LINES.slice(0, visibleLines).map((line, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.04 }}
                  className={
                    line.bold
                      ? 'text-foreground font-semibold mb-2 tracking-wide'
                      : line.text === ''
                        ? 'h-3'
                        : 'text-foreground/70'
                  }
                >
                  {line.text}
                </motion.div>
              ))}
              {visibleLines > 0 && !biosReady && (
                <motion.span
                  className="inline-block w-2 h-[14px] bg-foreground/70 ml-0.5 mt-0.5"
                  animate={{ opacity: [1, 0] }}
                  transition={{ duration: 0.5, repeat: Infinity }}
                />
              )}
              {biosReady && (
                <motion.div
                  className="mt-5 cursor-pointer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  onClick={continueBoot}
                >
                  <motion.span
                    className="font-mono text-sm sm:text-sm text-foreground/90"
                    animate={{ opacity: [1, 0.3] }}
                    transition={{ duration: 0.7, repeat: Infinity, repeatType: 'reverse' }}
                  >{tHardcodedUi.raw('componentsOnboardingBootOverlay.line135JsxTextPressEnterToBoot')}</motion.span>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}

        {/* Logo + progress bar */}
        {phase === 'logo' && (
          <motion.div
            key="logo"
            className="absolute inset-0 flex flex-col items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5 } }}
            transition={{ duration: 0.5 }}
          >
            <motion.div
              className="relative z-10 flex flex-col items-center"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            >
              <svg viewBox="0 0 30 25" className="h-11 sm:h-[52px] w-auto text-foreground">
                <path d={SYMBOL} fill="currentColor" />
              </svg>
              <div className="mt-10 w-44 sm:w-52 h-px bg-foreground/[0.06] overflow-hidden">
                <div
                   className={cn("h-full bg-foreground/30", progressFill ? "w-full" : "w-0")}
                   style={{
                     transition: progressFill
                       ? 'width 2.5s cubic-bezier(0.4, 0, 0.2, 1)'
                       : 'none',
                   }}
                 />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
