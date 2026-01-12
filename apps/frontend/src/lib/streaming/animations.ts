'use client';

import { useState, useEffect, useRef } from 'react';

export function useSmoothStream(
  text: string,
  enabled: boolean = true,
  speed: number = 250
): string {
  const [displayedLen, setDisplayedLen] = useState(0);
  const stateRef = useRef({
    targetText: '',
    displayedLen: 0,
    lastTime: 0,
    frameId: null as number | null,
  });

  useEffect(() => {
    const state = stateRef.current;

    if (state.frameId) {
      cancelAnimationFrame(state.frameId);
      state.frameId = null;
    }

    if (!text) {
      state.targetText = '';
      state.displayedLen = 0;
      state.lastTime = 0;
      setDisplayedLen(0);
      return;
    }

    if (!enabled) {
      state.targetText = text;
      state.displayedLen = text.length;
      setDisplayedLen(text.length);
      return;
    }

    const isContinuation = state.targetText.length > 0 && text.startsWith(state.targetText);
    state.targetText = text;

    if (!isContinuation) {
      state.displayedLen = 0;
      state.lastTime = 0;
      setDisplayedLen(0);
    }

    const animate = (time: number) => {
      if (!state.lastTime) state.lastTime = time;
      const delta = time - state.lastTime;
      state.lastTime = time;

      const chars = Math.max(2, Math.ceil((delta / 1000) * speed));
      const targetLen = state.targetText.length;
      state.displayedLen = Math.min(state.displayedLen + chars, targetLen);
      
      setDisplayedLen(state.displayedLen);

      if (state.displayedLen < targetLen) {
        state.frameId = requestAnimationFrame(animate);
      } else {
        state.frameId = null;
        state.lastTime = 0;
      }
    };

    if (state.displayedLen < text.length) {
      state.frameId = requestAnimationFrame(animate);
    }

    return () => {
      if (state.frameId) {
        cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
    };
  }, [text, enabled, speed]);

  return text.slice(0, displayedLen);
}
