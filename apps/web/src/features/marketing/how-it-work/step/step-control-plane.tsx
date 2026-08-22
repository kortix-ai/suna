'use client';

import { Button } from '@/components/ui/button';
import { Cursor } from '@/features/icon/icons/cursor';
import { cn } from '@/lib/utils';
import { CheckCircleIcon, CheckIcon, GitPullRequestIcon, XCircleIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion, type Transition } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';
import { AppleCursor } from '@/features/icon/icons/apple-cursor';

type Outcome = 'pending' | 'merged' | 'changes-requested';

const ENTER: Transition = { duration: 0.3, ease: [0.23, 1, 0.32, 1] };
const MORPH: Transition = { type: 'spring', duration: 0.3, bounce: 0 };

function MergePath({
  state,
  reduced,
}: {
  state: 'open' | 'merging' | 'merged';
  reduced: boolean;
}): ReactNode {
  const active = state !== 'open';
  let transition: Transition = { duration: 0.2 };
  if (reduced) transition = { duration: 0 };
  if (!reduced && state === 'merging') {
    transition = { duration: 0.7, ease: [0.77, 0, 0.175, 1] };
  }

  return (
    <div className="grid grid-cols-[auto_minmax(2rem,1fr)_auto] items-center gap-2">
      <code className="border-border bg-muted/40 text-muted-foreground rounded-sm border px-2 py-1 text-xs">
        7f2a1c94
      </code>
      <span className="bg-border relative h-px overflow-hidden">
        <m.span
          initial={false}
          animate={{
            opacity: active ? 1 : 0,
            transform: active ? 'scaleX(1)' : 'scaleX(0)',
          }}
          transition={transition}
          style={{ transformOrigin: 'left center' }}
          className="bg-kortix-green absolute inset-0"
        />
      </span>
      <code
        className={cn(
          'rounded-sm border px-2 py-1 text-xs transition-colors duration-200',
          active
            ? 'border-kortix-green/30 bg-kortix-green/10 text-kortix-green'
            : 'border-border bg-muted/40 text-muted-foreground',
        )}
      >
        main
      </code>
    </div>
  );
}

function StatusIcon({ outcome, reduced }: { outcome: Outcome; reduced: boolean }): ReactNode {
  let icon = <GitPullRequestIcon className="size-5" />;
  if (outcome === 'merged') icon = <CheckCircleIcon weight="fill" className="size-5" />;
  if (outcome === 'changes-requested') icon = <XCircleIcon weight="fill" className="size-5" />;

  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center">
      <AnimatePresence initial={false} mode="popLayout">
        <m.span
          key={outcome}
          initial={
            reduced ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.25)', filter: 'blur(4px)' }
          }
          animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
          exit={
            reduced ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.25)', filter: 'blur(4px)' }
          }
          transition={MORPH}
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-sm',
            outcome === 'merged' && 'bg-kortix-green/15 text-kortix-green',
            outcome === 'changes-requested' && 'bg-kortix-orange/15 text-kortix-orange',
            outcome === 'pending' && 'bg-kortix-blue/15 text-kortix-blue',
          )}
        >
          {icon}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

function ChangeRequest({
  beat,
  outcome,
  reduced,
}: {
  beat: number;
  outcome: Outcome;
  reduced: boolean;
}): ReactNode {
  const merging = beat === 4;
  const merged = outcome === 'merged';
  let status = 'Open';
  let mergeState: 'open' | 'merging' | 'merged' = 'open';

  if (merging) mergeState = 'merging';
  if (merged) {
    status = 'Merged';
    mergeState = 'merged';
  }
  if (outcome === 'changes-requested') status = 'Changes requested';

  return (
    <m.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
      animate={{ opacity: 1, transform: 'translateY(0)' }}
      transition={ENTER}
      className="border-border bg-background w-full rounded-md border px-3.5 py-3 shadow-sm sm:px-4 sm:py-3.5"
    >
      <div className="flex items-start gap-3">
        <StatusIcon outcome={outcome} reduced={reduced} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-foreground truncate text-sm font-medium">Billing webhook retry</p>
            <span
              className={cn(
                'shrink-0 text-xs font-medium',
                merged && 'text-kortix-green',
                outcome === 'changes-requested' && 'text-kortix-orange',
                outcome === 'pending' && 'text-muted-foreground',
              )}
            >
              {status}
            </span>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
            2 files · <span className="text-kortix-green">+48</span>{' '}
            <span className="text-kortix-red">−12</span>
          </div>
          <div className="mt-3">
            <MergePath state={mergeState} reduced={reduced} />
          </div>
        </div>
      </div>
    </m.div>
  );
}

function ReviewGate({
  beat,
  cursorActive,
  reduced,
  onApprove,
  onRequestChanges,
}: {
  beat: number;
  cursorActive: boolean;
  reduced: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
}): ReactNode {
  const merging = beat === 4;
  const contentInitial = reduced
    ? { opacity: 0 }
    : { opacity: 0, transform: 'scale(0.97)', filter: 'blur(4px)' };
  const contentExit = reduced
    ? { opacity: 0, transition: { duration: 0.15 } }
    : {
        opacity: 0,
        transform: 'scale(0.97)',
        filter: 'blur(4px)',
        transition: {
          duration: 0.2,
          ease: [0.23, 1, 0.32, 1] as [number, number, number, number],
        },
      };
  const gateExit = reduced
    ? { opacity: 0, transition: { duration: 0.15 } }
    : {
        opacity: 0,
        transform: 'scale(0.98)',
        transition: {
          duration: 0.3,
          ease: [0.23, 1, 0.32, 1] as [number, number, number, number],
        },
      };

  return (
    <m.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.97)' }}
      animate={{ opacity: 1, transform: 'scale(1)' }}
      exit={gateExit}
      transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
      className="bg-background absolute inset-0 z-30 flex items-center justify-center overflow-hidden"
    >
      <AnimatePresence initial={false} mode="wait">
        {merging ? (
          <m.div
            key="merging"
            initial={contentInitial}
            animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
            exit={contentExit}
            transition={MORPH}
            className="w-full max-w-sm px-8 text-center"
          >
            <div className="bg-kortix-green/15 text-kortix-green mx-auto mb-5 flex size-11 items-center justify-center rounded-sm">
              <GitPullRequestIcon className="size-5" />
            </div>
            <MergePath state="merging" reduced={reduced} />
            <p className="text-muted-foreground mt-4 text-xs">Merging</p>
          </m.div>
        ) : (
          <m.div
            key="review"
            initial={contentInitial}
            animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
            exit={contentExit}
            transition={MORPH}
            className="flex w-full max-w-sm flex-col items-center px-6 text-center"
          >
            <span className="bg-kortix-blue/15 text-kortix-blue flex size-11 items-center justify-center rounded-sm">
              <GitPullRequestIcon className="size-5" />
            </span>
            <p className="text-foreground mt-4 text-base font-medium">Merge into main?</p>
            <p className="text-muted-foreground mt-1 text-xs tabular-nums">
              2 files · <span className="text-kortix-green">+48</span>{' '}
              <span className="text-kortix-red">−12</span>
            </p>

            <div className="mt-5 flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onRequestChanges}>
                Request changes
              </Button>
              <m.div className="relative" whileTap={{ transform: 'scale(0.96)' }}>
                <Button type="button" size="sm" className="gap-1.5" onClick={onApprove}>
                  <CheckIcon className="size-3.5 shrink-0" />
                  Approve & merge
                </Button>

                {!reduced && (
                  <m.span
                    aria-hidden
                    initial={{
                      opacity: 0,
                      transform: 'translate(-104px, -52px) scale(0.9)',
                    }}
                    animate={
                      cursorActive
                        ? { opacity: 1, transform: 'translate(-8px, 9px) scale(1)' }
                        : { opacity: 0, transform: 'translate(-104px, -52px) scale(0.9)' }
                    }
                    transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
                    onAnimationComplete={() => {
                      if (cursorActive) onApprove();
                    }}
                    className=" pointer-events-none absolute -top-2 -right-2 z-20 flex size-32 items-center justify-center rounded-md shadow-md"
                  >
                    <AppleCursor className="size-30" />
                  </m.span>
                )}
              </m.div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}

/** Layer 05 — a request becomes a reviewed change before it reaches `main`. */
export function StepControlPlane(): ReactNode {
  const reduced = useReducedMotion();
  const shouldReduceMotion = reduced === true;
  const reducedRef = useRef(reduced);
  const startedRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [beat, setBeat] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>('pending');
  const [cursorActive, setCursorActive] = useState(false);

  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const approve = useCallback(() => {
    clearTimers();
    setCursorActive(false);
    setBeat(4);
    timersRef.current.push(
      setTimeout(
        () => {
          setOutcome('merged');
          setBeat(5);
        },
        reducedRef.current ? 0 : 950,
      ),
    );
  }, [clearTimers]);

  const requestChanges = useCallback(() => {
    clearTimers();
    setCursorActive(false);
    setOutcome('changes-requested');
    setBeat(5);
  }, [clearTimers]);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (reducedRef.current) {
      setBeat(3);
      return;
    }

    timersRef.current.push(setTimeout(() => setBeat(1), 260));
    timersRef.current.push(setTimeout(() => setBeat(2), 900));
    timersRef.current.push(setTimeout(() => setBeat(3), 1900));
    timersRef.current.push(setTimeout(() => setCursorActive(true), 2700));
  }, []);

  const rootRef = useStepShowcaseStart(start);
  const reviewOpen = beat === 3 || beat === 4;
  let announcement = '';
  if (outcome === 'merged') announcement = 'Change request merged into main';
  if (outcome === 'changes-requested') announcement = 'Changes requested';

  return (
    <div ref={rootRef} className="bg-muted/40 relative flex h-full w-full flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-4 sm:px-8 sm:pt-6">
        {beat >= 1 && (
          <m.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0)' }}
            transition={ENTER}
            className="text-foreground bg-secondary ml-auto w-fit max-w-[80%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed font-medium"
          >
            Open a change request
          </m.div>
        )}
      </div>

      <div className="border-border bg-background mx-auto mt-4 flex min-h-0 w-[92%] flex-1 flex-col overflow-hidden rounded-t-xl border border-b-0 px-4 pt-4 shadow-sm sm:px-6 sm:pt-5">
        <div className="mx-auto flex h-full w-full max-w-lg items-center pb-5">
          {beat >= 2 && (
            <ChangeRequest beat={beat} outcome={outcome} reduced={shouldReduceMotion} />
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {reviewOpen && (
          <ReviewGate
            beat={beat}
            cursorActive={cursorActive}
            reduced={shouldReduceMotion}
            onApprove={approve}
            onRequestChanges={requestChanges}
          />
        )}
      </AnimatePresence>

      <div role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
