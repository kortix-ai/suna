'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { STAGE_DATA, type StageVisual } from './content';

type StageProps = {
  visual: StageVisual;
  t: (key: string) => string;
};

function SceneShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn('flex h-full min-h-[280px] w-full items-center justify-center p-8', className)}
    >
      {children}
    </div>
  );
}

function IsolationScene({ reduceMotion }: { reduceMotion: boolean }) {
  const { sandboxes, spine } = STAGE_DATA.isolation;

  return (
    <SceneShell>
      <div className="relative flex h-48 w-full max-w-md items-center justify-center">
        <motion.div
          className="border-primary/40 bg-primary/10 text-primary absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-sm border px-3 py-1.5 font-mono text-xs"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
        >
          {spine}
        </motion.div>

        {sandboxes.map((id, index) => {
          const positions = [
            { x: -120, y: -60 },
            { x: 100, y: -70 },
            { x: -20, y: 80 },
          ] as const;
          const pos = positions[index] ?? { x: 0, y: 0 };

          return (
            <motion.div
              key={id}
              className="absolute top-1/2 left-1/2"
              style={{ x: pos.x, y: pos.y }}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: reduceMotion ? 0 : 0.15 + index * 0.4, duration: 0.35 }}
            >
              <div className="border-border bg-card text-muted-foreground rounded-sm border px-2.5 py-1 font-mono text-[11px]">
                {id}
              </div>
              <motion.span
                className="text-kortix-green absolute -top-2 -right-8 font-mono text-[10px]"
                initial={reduceMotion ? false : { opacity: 0, x: 8 }}
                animate={{ opacity: [0.4, 1, 0.4], x: [8, -4, 8] }}
                transition={{
                  delay: reduceMotion ? 0 : 0.6 + index * 0.4,
                  duration: reduceMotion ? 0 : 1.8,
                  repeat: reduceMotion ? 0 : Infinity,
                }}
              >
                CR→
              </motion.span>
            </motion.div>
          );
        })}
      </div>
    </SceneShell>
  );
}

function TokenScene({ t, reduceMotion }: { t: (key: string) => string; reduceMotion: boolean }) {
  const { rejectedKey, acceptedKey } = STAGE_DATA.token;

  return (
    <SceneShell>
      <div className="relative h-44 w-full max-w-sm">
        <div className="border-border absolute inset-4 rounded-sm border border-dashed" />
        <span className="text-muted-foreground absolute top-6 left-6 font-mono text-[10px] tracking-wider uppercase">
          sandbox
        </span>

        <motion.span
          className="text-destructive absolute top-1/2 left-0 -translate-y-1/2 font-mono text-xs"
          animate={reduceMotion ? { x: 0, opacity: 1 } : { x: [0, 52, 0], opacity: [1, 0.5, 1] }}
          transition={{ duration: 1.6, repeat: reduceMotion ? 0 : Infinity, ease: 'easeInOut' }}
        >
          {t(rejectedKey)}
        </motion.span>

        <motion.span
          className="text-kortix-purple absolute top-[62%] left-0 font-mono text-xs"
          animate={reduceMotion ? { x: 80, opacity: 1 } : { x: [0, 96], opacity: [0.6, 1] }}
          transition={{
            duration: 1.4,
            repeat: reduceMotion ? 0 : Infinity,
            repeatDelay: 0.6,
            ease: 'easeOut',
          }}
        >
          {t(acceptedKey)}
        </motion.span>
      </div>
    </SceneShell>
  );
}

function AuditScene({ t, reduceMotion }: { t: (key: string) => string; reduceMotion: boolean }) {
  const rows = STAGE_DATA.audit.rowKeys.map((key) => t(key));
  const [visibleCount, setVisibleCount] = useState(reduceMotion ? rows.length : 1);

  useEffect(() => {
    if (reduceMotion) {
      setVisibleCount(rows.length);
      return;
    }
    setVisibleCount(1);
    const interval = setInterval(() => {
      setVisibleCount((count) => (count >= rows.length ? 1 : count + 1));
    }, 900);
    return () => clearInterval(interval);
  }, [reduceMotion, rows.length]);

  return (
    <SceneShell>
      <div className="border-border bg-background/60 w-full max-w-sm space-y-2 rounded-sm border p-4 font-mono text-xs">
        {rows.slice(0, visibleCount).map((row, index) => (
          <motion.div
            key={row}
            className="text-muted-foreground border-border/60 border-b pb-2 last:border-b-0 last:pb-0"
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : index * 0.08, duration: 0.2 }}
          >
            {row}
          </motion.div>
        ))}
      </div>
    </SceneShell>
  );
}

function Soc2Scene({ t, reduceMotion }: { t: (key: string) => string; reduceMotion: boolean }) {
  const controls = STAGE_DATA.soc2.controlKeys.map((key) => t(key));

  return (
    <SceneShell>
      <div className="w-full max-w-sm space-y-4">
        <motion.div
          className="bg-kortix-orange/15 text-kortix-orange border-kortix-orange/30 inline-flex rounded-sm border px-2.5 py-1 font-mono text-[11px]"
          animate={reduceMotion ? { opacity: 1 } : { opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 1.8, repeat: reduceMotion ? 0 : Infinity }}
        >
          {t(STAGE_DATA.soc2.badgeKey)}
        </motion.div>

        <ul className="space-y-2.5">
          {controls.map((control, index) => (
            <motion.li
              key={control}
              className="text-foreground flex items-center gap-2.5 text-sm"
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reduceMotion ? 0 : index * 0.4, duration: 0.25 }}
            >
              <span className="bg-kortix-green/20 text-kortix-green flex size-5 shrink-0 items-center justify-center rounded-sm text-xs">
                ✓
              </span>
              {control}
            </motion.li>
          ))}
        </ul>
      </div>
    </SceneShell>
  );
}

function SelfhostScene({ t, reduceMotion }: { t: (key: string) => string; reduceMotion: boolean }) {
  const hosts = STAGE_DATA.selfhost.hostKeys.map((key) => t(key));
  const [hostIndex, setHostIndex] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const interval = setInterval(() => {
      setHostIndex((index) => (index + 1) % hosts.length);
    }, 1800);
    return () => clearInterval(interval);
  }, [reduceMotion, hosts.length]);

  return (
    <SceneShell>
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <div className="relative flex h-36 w-full items-center justify-center">
          <div className="border-border absolute inset-0 rounded-sm border border-dashed" />
          <div className="border-border bg-card text-foreground relative z-10 rounded-sm border px-6 py-4 font-mono text-sm">
            kortix
          </div>
          <p className="text-muted-foreground absolute -bottom-6 left-1/2 w-full -translate-x-1/2 text-center font-mono text-[11px]">
            {hosts[hostIndex]}
          </p>
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          {t(STAGE_DATA.selfhost.commandKey)}
        </p>
      </div>
    </SceneShell>
  );
}

export function SecurityStage({ visual, t }: StageProps) {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div className="relative h-full min-h-[280px] overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={visual}
          className="absolute inset-0"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {visual === 'isolation' && <IsolationScene reduceMotion={reduceMotion} />}
          {visual === 'token' && <TokenScene t={t} reduceMotion={reduceMotion} />}
          {visual === 'audit' && <AuditScene t={t} reduceMotion={reduceMotion} />}
          {visual === 'soc2' && <Soc2Scene t={t} reduceMotion={reduceMotion} />}
          {visual === 'selfhost' && <SelfhostScene t={t} reduceMotion={reduceMotion} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
