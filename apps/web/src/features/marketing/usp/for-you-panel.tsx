'use client';

import { cn } from '@/lib/utils';
import { Heatmap } from '@paper-design/shaders-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { DEPT_DOT, FOR_YOU, type UseCaseCard } from './section3-content';

const { terminal, cards } = FOR_YOU;

const ORBIT_SLOTS = 8;
const ORBIT_RADIUS = 204;
const CHIP_SWAP_MS = 1000;
const CHIP_EASE = [0.23, 1, 0.32, 1] as const;

type OrbitSlot = {
  slotIndex: number;
  card: UseCaseCard;
  key: number;
};

function orbitStyle(slotIndex: number): React.CSSProperties {
  const angle = (2 * Math.PI * slotIndex) / ORBIT_SLOTS - Math.PI / 2;
  return {
    left: `calc(50% + ${ORBIT_RADIUS * Math.cos(angle)}px)`,
    top: `calc(50% + ${ORBIT_RADIUS * Math.sin(angle)}px)`,
  };
}

function initialOrbitSlots(): OrbitSlot[] {
  return cards.slice(0, ORBIT_SLOTS).map((card, slotIndex) => ({
    slotIndex,
    card,
    key: slotIndex,
  }));
}

function pickReplacement(visible: readonly UseCaseCard[]): UseCaseCard | null {
  const visibleLabels = new Set(visible.map((c) => c.label));
  const pool = cards.filter((c) => !visibleLabels.has(c.label));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function CardChip({ card, className }: { card: UseCaseCard; className?: string }) {
  return (
    <div
      className={cn(
        '*:text-foreground bg-background dark:bg-secondary border-border/25 dark:border-border flex shrink-0 items-center gap-2.5 rounded-sm border px-3 py-2 shadow-sm',
        className,
      )}
    >
      <span className={cn('size-3 shrink-0 rounded', DEPT_DOT[card.dept])} aria-hidden />
      <span className="text-sm font-medium whitespace-nowrap">{card.label}</span>
    </div>
  );
}

function AnimatedCardChip({ card }: { card: UseCaseCard }) {
  return (
    <motion.div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      initial={{ opacity: 0, scale: 0.92, filter: 'blur(4px)' }}
      animate={{
        opacity: 1,
        scale: 1,
        filter: 'blur(0px)',
        transition: { duration: 0.45, ease: CHIP_EASE },
      }}
      exit={{
        opacity: 0,
        scale: 0.96,
        filter: 'blur(3px)',
        transition: { duration: 0.22, ease: CHIP_EASE },
      }}
    >
      <CardChip card={card} />
    </motion.div>
  );
}

function StaticOrbit() {
  return (
    <>
      {initialOrbitSlots().map((slot) => (
        <div key={slot.card.label} className="absolute" style={orbitStyle(slot.slotIndex)}>
          <CardChip card={slot.card} className="absolute -translate-x-1/2 -translate-y-1/2" />
        </div>
      ))}
    </>
  );
}

function LiveOrbit() {
  const [slots, setSlots] = useState<OrbitSlot[]>(initialOrbitSlots);
  const nextKey = useRef(ORBIT_SLOTS);

  useEffect(() => {
    const id = setInterval(() => {
      setSlots((prev) => {
        const slotIndex = Math.floor(Math.random() * ORBIT_SLOTS);
        const replacement = pickReplacement(prev.map((s) => s.card));
        if (!replacement) return prev;

        return prev.map((slot) =>
          slot.slotIndex === slotIndex
            ? { ...slot, card: replacement, key: nextKey.current++ }
            : slot,
        );
      });
    }, CHIP_SWAP_MS);

    return () => clearInterval(id);
  }, []);

  return (
    <>
      {slots.map((slot) => (
        <div key={slot.slotIndex} className="absolute" style={orbitStyle(slot.slotIndex)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <AnimatedCardChip key={slot.key} card={slot.card} />
          </AnimatePresence>
        </div>
      ))}
    </>
  );
}

export function ForYouPanel({
  title,
  description,
}: {
  title: readonly string[];
  description: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="border-border bg-foreground flex h-auto w-full flex-col gap-4 overflow-hidden p-6 md:p-8 lg:aspect-20/9 lg:h-[450px] lg:flex-row lg:p-12">
      <div className="flex w-full flex-col justify-start gap-6 space-y-3 pr-0 lg:col-span-4 lg:w-[340px] lg:shrink-0 lg:gap-0 lg:pr-10">
        <h2 className="text-background flex gap-2 text-2xl font-medium tracking-tight whitespace-nowrap">
          {title[0]} {title[1]}
        </h2>

        <p className="text-background/70 max-w-xl text-base leading-relaxed">{description}</p>
      </div>

      <div className="relative flex h-full min-h-[430px] w-full flex-1 scale-75 items-center justify-center lg:col-span-8 lg:min-h-[220px] lg:scale-90">
        <div className="pointer-events-none absolute inset-0">
          {reduceMotion ? <StaticOrbit /> : <LiveOrbit />}
        </div>

        <Heatmap
          speed={1}
          contour={0.5}
          angle={0}
          noise={0}
          innerGlow={0.5}
          outerGlow={0.05}
          scale={0.65}
          image="https://app.paper.design/file-assets/01KSZX87JES96T455ZX3RRGMPP/01KT47X1FY5YNJN6EPP8TW6ZB1.svg"
          frame={407072.499999992}
          colors={['var(--kortix-orange)', '#fafafa', '#242424']}
          colorBack="#ffffff00"
          className="shrink-0"
          style={{
            // backgroundColor: 'var(--card)',
            height: '182px',
            width: '220px',
          }}
        />
      </div>
    </div>
  );
}
