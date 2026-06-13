'use client';

import { cn } from '@/lib/utils';
import { BookOpen, Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { DemoPhase } from './use-demo-conversation';
import { skillDescription } from './match-skills';

const READ_STAGGER_MS = 380;

export function SkillsRead({
  skills,
  phase,
  onSkillClick,
}: {
  skills: string[];
  phase: DemoPhase;
  onSkillClick?: (name: string) => void;
}) {
  const [readCount, setReadCount] = useState(0);

  useEffect(() => {
    if (!skills.length) {
      setReadCount(0);
      return;
    }
    if (phase === 'idle' || phase === 'typing') {
      setReadCount(0);
      return;
    }
    if (phase === 'streaming' || phase === 'done') {
      setReadCount(skills.length);
      return;
    }
    if (phase === 'thinking') {
      setReadCount(0);
      const timers = skills.map((_, i) =>
        window.setTimeout(() => setReadCount(i + 1), READ_STAGGER_MS * (i + 1)),
      );
      return () => timers.forEach((t) => window.clearTimeout(t));
    }
  }, [phase, skills]);

  if (readCount === 0) return null;

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {skills.slice(0, readCount).map((name, i) => {
          const done = phase !== 'thinking' || i < readCount - 1;
          const desc = skillDescription(name);

          return (
            <motion.div
              key={name}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <button
                type="button"
                onClick={() => onSkillClick?.(name)}
                disabled={!onSkillClick}
                className={cn(
                  ' w-full overflow-hidden rounded-2xl border text-left transition-colors',
                  // onSkillClick && 'hover:bg-muted/30 active:scale-[0.99]',
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <BookOpen className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-foreground font-mono font-medium">skill</span>
                  <span className="text-muted-foreground truncate">· {name}</span>
                  {done ? (
                    <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <span className="border-muted-foreground/40 border-t-foreground ml-auto size-3.5 shrink-0 animate-spin rounded-full border-[1.5px]" />
                  )}
                </div>
                
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
