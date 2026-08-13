"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DotMatrixPhase } from "@/lib/dotmatrix-core";

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");

    const update = () => {
      setPrefersReducedMotion(query.matches);
    };

    update();
    query.addEventListener("change", update);

    return () => {
      query.removeEventListener("change", update);
    };
  }, []);

  return prefersReducedMotion;
}

export interface UseCyclePhaseOptions {
  active: boolean;
  cycleMsBase: number;
  speed?: number;
}

export function useCyclePhase({ active, cycleMsBase, speed = 1 }: UseCyclePhaseOptions): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!active) {
      setPhase(0);
      return;
    }

    const safeSpeed = speed > 0 ? speed : 1;
    const raw = cycleMsBase / safeSpeed;
    const cycleMs = raw > 0 && Number.isFinite(raw) ? raw : 1000;
    const start = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const elapsed = ((now - start) % cycleMs + cycleMs) % cycleMs;
      setPhase(elapsed / cycleMs);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, cycleMsBase, speed]);

  return phase;
}

interface UseSteppedCycleOptions {
  active: boolean;
  cycleMsBase: number;
  steps: number;
  speed?: number;
  idleStep?: number;
}

type FrameListener = (now: number) => void;

const listeners = new Set<FrameListener>();
let rafId: number | null = null;

function emit(now: number) {
  listeners.forEach((listener) => {
    listener(now);
  });
}

function tick(now: number) {
  emit(now);
  if (listeners.size > 0) {
    rafId = window.requestAnimationFrame(tick);
  } else {
    rafId = null;
  }
}

function subscribeFrame(listener: FrameListener) {
  listeners.add(listener);
  if (rafId === null) {
    rafId = window.requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

export function useSteppedCycle({
  active,
  cycleMsBase,
  steps,
  speed = 1,
  idleStep = 0
}: UseSteppedCycleOptions): number {
  const safeSteps = Math.max(1, Math.floor(steps));
  const safeSpeed = speed > 0 ? speed : 1;
  const rawCycleMs = cycleMsBase / safeSpeed;
  const rawStepMs = rawCycleMs / safeSteps;
  const stepMs = rawStepMs > 0 && Number.isFinite(rawStepMs) ? rawStepMs : 1;
  const cycleMs = stepMs * safeSteps;

  const [step, setStep] = useState(() => (active ? 0 : idleStep));
  const startMsRef = useRef<number>(0);
  const activeRef = useRef(false);
  const currentStepRef = useRef(idleStep);

  useEffect(() => {
    if (!active) {
      activeRef.current = false;
      currentStepRef.current = idleStep;
      setStep(idleStep);
      return;
    }

    const updateStep = (now: number) => {
      if (!activeRef.current) {
        startMsRef.current = now;
        activeRef.current = true;
      }

      const elapsed = Math.max(0, now - startMsRef.current);
      const nextStep = Math.floor((elapsed % cycleMs) / stepMs) % safeSteps;
      if (nextStep !== currentStepRef.current) {
        currentStepRef.current = nextStep;
        setStep(nextStep);
      }
    };

    updateStep(performance.now());
    return subscribeFrame(updateStep);
  }, [active, cycleMs, idleStep, safeSteps, stepMs]);

  return active ? step : idleStep;
}

interface UseDotMatrixPhasesOptions {
  animated?: boolean;
  hoverAnimated?: boolean;
  speed?: number;
}

interface DotMatrixPhasesResult {
  phase: DotMatrixPhase;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useDotMatrixPhases({
  animated = false,
  hoverAnimated = false,
  speed = 1
}: UseDotMatrixPhasesOptions): DotMatrixPhasesResult {
  const safeSpeed = speed > 0 ? speed : 1;
  const autoRun = Boolean(animated && !hoverAnimated);
  const [hoverPhase, setHoverPhase] = useState<DotMatrixPhase>("idle");
  const timeouts = useRef<number[]>([]);
  const hoverGen = useRef(0);

  const clearTimers = useCallback(() => {
    for (let i = 0; i < timeouts.current.length; i += 1) {
      window.clearTimeout(timeouts.current[i]!);
    }
    timeouts.current = [];
  }, []);

  useEffect(() => {
    hoverGen.current += 1;
    clearTimers();
    return clearTimers;
  }, [autoRun, hoverAnimated, clearTimers]);

  const onMouseEnter = useCallback(() => {
    if (!hoverAnimated || autoRun) {
      return;
    }
    clearTimers();
    const gen = ++hoverGen.current;
    setHoverPhase("collapse");
    const collapseMs = Math.max(1, Math.round(300 / safeSpeed));
    const id = window.setTimeout(() => {
      if (hoverGen.current !== gen) {
        return;
      }
      setHoverPhase("hoverRipple");
    }, collapseMs);
    timeouts.current.push(id);
  }, [hoverAnimated, autoRun, safeSpeed, clearTimers]);

  const onMouseLeave = useCallback(() => {
    if (!hoverAnimated || autoRun) {
      return;
    }
    hoverGen.current += 1;
    clearTimers();
    setHoverPhase("idle");
  }, [hoverAnimated, autoRun, clearTimers]);

  const phase: DotMatrixPhase = autoRun ? "loadingRipple" : hoverAnimated ? hoverPhase : "idle";

  return useMemo(
    () => ({
      phase,
      onMouseEnter,
      onMouseLeave
    }),
    [phase, onMouseEnter, onMouseLeave]
  );
}
