'use client';

import { useEffect, useRef, useState } from 'react';

import type { SessionStartResult } from '../core/rest/projects-client';
import { startGiveUpExpiryAtMs } from './session-start-giveup';

export const START_INCONCLUSIVE_GIVE_UP_MS = 45_000;

function hasInconclusiveStartGivenUp(
  hasData: boolean,
  hasError: boolean,
  inconclusiveSinceMs: number | null,
  nowMs: number,
  budgetMs: number,
): boolean {
  if (hasData || hasError) return false;
  return inconclusiveSinceMs !== null && nowMs - inconclusiveSinceMs >= budgetMs;
}

export function hasStartGivenUp(
  data: SessionStartResult | null | undefined,
  error: unknown,
  inconclusiveSinceMs: number | null,
  nowMs: number,
  budgetMs = START_INCONCLUSIVE_GIVE_UP_MS,
): boolean {
  return hasInconclusiveStartGivenUp(
    !!data,
    !!error,
    inconclusiveSinceMs,
    nowMs,
    budgetMs,
  );
}

export function nextInconclusiveSince(input: {
  current: number | null;
  enabled: boolean;
  hasData: boolean;
  hasError: boolean;
  isFetching: boolean;
  nowMs: number;
}): number | null {
  if (!input.enabled) return null;
  if (input.hasData || input.hasError) return null;
  return input.current ?? input.nowMs;
}

export function useSessionStartGiveUp(input: {
  identity: string;
  enabled: boolean;
  hasData: boolean;
  hasError: boolean;
  isFetching: boolean;
  budgetMs?: number;
}): boolean {
  const budgetMs = input.budgetMs ?? START_INCONCLUSIVE_GIVE_UP_MS;
  const inconclusiveSinceRef = useRef<number | null>(null);
  const [givenUp, setGivenUp] = useState(false);

  useEffect(() => {
    inconclusiveSinceRef.current = null;
    setGivenUp(false);
  }, [input.identity]);

  useEffect(() => {
    const nowMs = Date.now();
    inconclusiveSinceRef.current = nextInconclusiveSince({
      current: inconclusiveSinceRef.current,
      enabled: input.enabled,
      hasData: input.hasData,
      hasError: input.hasError,
      isFetching: input.isFetching,
      nowMs,
    });
    setGivenUp(
      hasInconclusiveStartGivenUp(
        input.hasData,
        input.hasError,
        inconclusiveSinceRef.current,
        nowMs,
        budgetMs,
      ),
    );

    const expiryAtMs = startGiveUpExpiryAtMs({
      inconclusiveSinceMs: inconclusiveSinceRef.current,
      budgetMs,
    });
    if (expiryAtMs === null) return;

    const timer = setTimeout(() => {
      const fireNowMs = Date.now();
      setGivenUp(
        hasInconclusiveStartGivenUp(
          input.hasData,
          input.hasError,
          inconclusiveSinceRef.current,
          fireNowMs,
          budgetMs,
        ),
      );
    }, Math.max(0, expiryAtMs - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [
    input.identity,
    input.enabled,
    input.hasData,
    input.hasError,
    input.isFetching,
    budgetMs,
  ]);

  return givenUp;
}
