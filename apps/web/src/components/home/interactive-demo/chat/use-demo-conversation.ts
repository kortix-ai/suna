'use client';

import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { DemoScenario } from '../types';
import { matchScenario } from './scenarios';

const THINKING_MS = 1600;
const STREAM_CHARS_PER_TICK = 6;
const STREAM_TICK_MS = 28;
const TYPE_CHAR_MS = 30;
const RESULT_REVEAL_MS = 400;
const POST_STEP_GAP_MS = 250;
const AUTO_SUBMIT_DELAY_MS = 500;

export type DemoPhase = 'idle' | 'typing' | 'thinking' | 'streaming' | 'done';

export type DemoConversation = {
  phase: DemoPhase;
  draft: string;
  userText: string | null;
  scenario: DemoScenario | null;
  startedSteps: number;
  doneToolIds: Set<string>;
  streamed: Record<string, string>;
  setDraft: (t: string) => void;
  submit: (text?: string) => void;
  reset: () => void;
  startAutoDemo: (prompt: string) => void;
};

export function useDemoConversation(opts: { onEnterChat: () => void }): DemoConversation {
  const { onEnterChat } = opts;
  const reduce = useReducedMotion();

  const [phase, setPhase] = useState<DemoPhase>('idle');
  const [draft, setDraftState] = useState('');
  const [userText, setUserText] = useState<string | null>(null);
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  const [startedSteps, setStartedSteps] = useState(0);
  const [doneToolIds, setDoneToolIds] = useState<Set<string>>(() => new Set());
  const [streamed, setStreamed] = useState<Record<string, string>>({});

  const interactedRef = useRef(false);
  const sceneTimers = useRef<number[]>([]); // scenario timeline timers
  const autoTimers = useRef<number[]>([]); // auto-demo typewriter timers

  const clear = (bucket: MutableRefObject<number[]>) => {
    bucket.current.forEach((t) => {
      window.clearTimeout(t);
      window.clearInterval(t);
    });
    bucket.current = [];
  };

  useEffect(
    () => () => {
      clear(sceneTimers);
      clear(autoTimers);
    },
    [],
  );

  const playFrom = useCallback((sc: DemoScenario, i: number) => {
    if (i >= sc.steps.length) {
      setPhase('done');
      return;
    }
    setStartedSteps(i + 1);
    const step = sc.steps[i];
    if (step.kind === 'tool') {
      const t = window.setTimeout(() => {
        setDoneToolIds((prev) => {
          const n = new Set(prev);
          n.add(step.id);
          return n;
        });
        const g = window.setTimeout(() => playFrom(sc, i + 1), POST_STEP_GAP_MS);
        sceneTimers.current.push(g);
      }, step.durationMs);
      sceneTimers.current.push(t);
    } else if (step.kind === 'text') {
      let idx = 0;
      const iv = window.setInterval(() => {
        idx = Math.min(idx + STREAM_CHARS_PER_TICK, step.markdown.length);
        const slice = step.markdown.slice(0, idx);
        setStreamed((prev) => ({ ...prev, [step.id]: slice }));
        if (idx >= step.markdown.length) {
          window.clearInterval(iv);
          const g = window.setTimeout(() => playFrom(sc, i + 1), POST_STEP_GAP_MS);
          sceneTimers.current.push(g);
        }
      }, STREAM_TICK_MS);
      sceneTimers.current.push(iv);
    } else {
      const t = window.setTimeout(() => playFrom(sc, i + 1), RESULT_REVEAL_MS);
      sceneTimers.current.push(t);
    }
  }, []);

  const finalize = useCallback((sc: DemoScenario) => {
    setStartedSteps(sc.steps.length);
    setDoneToolIds(new Set(sc.steps.filter((s) => s.kind === 'tool').map((s) => s.id)));
    const full: Record<string, string> = {};
    sc.steps.forEach((s) => {
      if (s.kind === 'text') full[s.id] = s.markdown;
    });
    setStreamed(full);
    setPhase('done');
  }, []);

  const submit = useCallback(
    (text?: string) => {
      const value = (text ?? draft).trim();
      if (!value) return;
      interactedRef.current = true;
      clear(autoTimers);
      clear(sceneTimers);
      const sc = matchScenario(value);
      setUserText(value);
      setScenario(sc);
      setStartedSteps(0);
      setDoneToolIds(new Set());
      setStreamed({});
      onEnterChat();
      if (reduce) {
        finalize(sc);
        return;
      }
      setPhase('thinking');
      const t = window.setTimeout(() => {
        setPhase('streaming');
        playFrom(sc, 0);
      }, THINKING_MS);
      sceneTimers.current.push(t);
    },
    [draft, reduce, onEnterChat, playFrom, finalize],
  );

  const setDraft = useCallback((t: string) => {
    interactedRef.current = true;
    clear(autoTimers); // stop any in-flight typewriter; never touch a running scenario
    setPhase((p) => (p === 'typing' ? 'idle' : p));
    setDraftState(t);
  }, []);

  const reset = useCallback(() => {
    clear(autoTimers);
    clear(sceneTimers);
    setPhase('idle');
    setDraftState('');
    setUserText(null);
    setScenario(null);
    setStartedSteps(0);
    setDoneToolIds(new Set());
    setStreamed({});
  }, []);

  const startAutoDemo = useCallback(
    (prompt: string) => {
      if (interactedRef.current) return;
      if (reduce) {
        setDraftState(prompt);
        submit(prompt);
        return;
      }
      setPhase('typing');
      let i = 0;
      const iv = window.setInterval(() => {
        i += 1;
        setDraftState(prompt.slice(0, i));
        if (i >= prompt.length) {
          window.clearInterval(iv);
          const t = window.setTimeout(() => {
            if (!interactedRef.current) submit(prompt);
          }, AUTO_SUBMIT_DELAY_MS);
          autoTimers.current.push(t);
        }
      }, TYPE_CHAR_MS);
      autoTimers.current.push(iv);
    },
    [reduce, submit],
  );

  return {
    phase,
    draft,
    userText,
    scenario,
    startedSteps,
    doneToolIds,
    streamed,
    setDraft,
    submit,
    reset,
    startAutoDemo,
  };
}
