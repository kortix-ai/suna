'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import { Check, Database, Download, FileText, MessageSquare, Paperclip } from 'lucide-react';
import { FaCircle } from 'react-icons/fa';
import { PiCheckCircleFill } from 'react-icons/pi';
import { RiRobot3Fill } from 'react-icons/ri';
import { Reveal } from '../../reveal';
import { SendGlyph } from '../primitives';

const CHAT_SEQUENCE_MS = [400, 600, 2400, 550, 750, 650, 650, 700, 1100];
const CHAT_STREAM_STEPS = 9;

export function ChatPage() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState(reduce ? CHAT_STREAM_STEPS : 0);

  useEffect(() => {
    if (reduce) {
      setStage(CHAT_STREAM_STEPS);
      return;
    }
    setStage(0);
    const timers: number[] = [];
    let acc = 0;
    CHAT_SEQUENCE_MS.forEach((d, i) => {
      acc += d;
      timers.push(window.setTimeout(() => setStage(i + 1), acc));
    });
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reduce]);

  const steps = [
    'Pulled Q3 metrics from the data warehouse',
    'Drafted 12 slides from your board template',
    'Charted revenue, burn, and pipeline',
  ];
  const isDone = stage >= CHAT_STREAM_STEPS;

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex items-center gap-2 text-xs tracking-wide">
        <MessageSquare className="size-3.5" />
        sessions / q3-board-deck
      </div>

      <div className="flex-1 space-y-4 overflow-hidden">
        {stage >= 1 && (
          <Reveal className="bg-foreground text-background ml-auto w-fit max-w-[82%] rounded-md rounded-br-sm px-4 py-2.5 text-sm">
            Build the Q3 board deck from our latest financials.
          </Reveal>
        )}

        {stage >= 2 && (
          <Reveal>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-foreground flex items-center gap-2 text-sm font-medium">
                <RiRobot3Fill className="size-3.5" />
                kortix
              </span>
              <AnimatePresence mode="wait" initial={false}>
                {isDone ? (
                  <motion.span
                    key="done"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Badge size="sm" variant="badgeSuccess">
                      done
                    </Badge>
                  </motion.span>
                ) : (
                  <motion.span
                    key="working"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Badge size="sm" variant="secondary">
                      working
                    </Badge>
                  </motion.span>
                )}
              </AnimatePresence>
              <span className="text-muted-foreground ml-auto text-xs">14:32</span>
            </div>

            <AnimatePresence mode="wait">
              {stage === 2 && (
                <motion.div
                  key="reasoning"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.25 }}
                  className="flex items-center gap-1.5 py-0.5"
                >
                  <span className="relative flex size-2.5 shrink-0">
                    <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
                    <span className="bg-muted-foreground/50 relative inline-flex size-2.5 rounded-full" />
                  </span>
                  <AnimatedThinkingText
                    statusText="Reading the latest financials…"
                    className="text-muted-foreground text-xs"
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {stage >= 3 && (
              <Reveal className="border-border/60 bg-card overflow-hidden rounded-md border">
                <div className="border-border/60 bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs">
                  <Database className="text-muted-foreground size-3.5" />
                  <span className="text-foreground font-medium">query_warehouse</span>
                  {stage >= 4 ? (
                    <Check className="ml-auto size-3.5 text-emerald-500" />
                  ) : (
                    <span className="border-muted-foreground/40 border-t-foreground ml-auto size-3.5 animate-spin rounded-full border-[1.5px]" />
                  )}
                </div>
                <div className="text-muted-foreground space-y-1 px-3 py-2.5 font-mono text-xs leading-relaxed">
                  <div>
                    <span className="text-foreground">SELECT</span> revenue, burn, pipeline
                  </div>
                  {stage >= 4 && (
                    <motion.div
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      <span className="text-foreground">FROM</span> metrics.q3{' '}
                      <span className="text-emerald-500">— 312 rows</span>
                    </motion.div>
                  )}
                </div>
              </Reveal>
            )}

            {stage >= 5 && (
              <div className="mt-3 space-y-2 pl-1">
                {steps.map(
                  (s, i) =>
                    stage >= 5 + i && (
                      <Reveal key={s} className="flex items-center gap-2 text-sm">
                        <PiCheckCircleFill className="text-kortix-green size-3.5 shrink-0" />
                        <span className="text-muted-foreground">{s}</span>
                      </Reveal>
                    ),
                )}
                {stage >= 8 && (
                  <Reveal className="flex items-center gap-2 text-sm">
                    {isDone ? (
                      <PiCheckCircleFill className="text-kortix-green size-3.5 shrink-0" />
                    ) : (
                      <FaCircle className="text-muted-foreground size-3 shrink-0 animate-pulse" />
                    )}
                    <span className="text-foreground">Formatting &amp; final review</span>
                  </Reveal>
                )}
              </div>
            )}

            {stage >= 9 && (
              <Reveal className="border-border/60 bg-card mt-3 flex items-center gap-3 rounded-md border p-3">
                <span className="bg-foreground/6 text-foreground flex size-9 items-center justify-center rounded-lg">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Q3-board-deck.pptx</div>
                  <div className="text-muted-foreground text-xs">12 slides · ready in 4 min</div>
                </div>
                <span className="text-background/90 bg-primary/90 inline-flex size-8 items-center justify-center rounded-md border">
                  <Download className="size-4" />
                </span>
              </Reveal>
            )}
          </Reveal>
        )}
      </div>

      <div className="border-border bg-card mt-4 flex items-center gap-2 rounded-md border p-2.5">
        <Paperclip className="text-muted-foreground size-4" />
        <span className="text-muted-foreground flex-1 text-sm">Reply to kortix…</span>
        <span className="text-background bg-primary/90 inline-flex size-7 items-center justify-center rounded-md">
          <SendGlyph />
        </span>
      </div>
    </div>
  );
}
