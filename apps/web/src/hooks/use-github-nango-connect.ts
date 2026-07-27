'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  runGitHubNangoConnect,
  type GitHubNangoConnectOutcome,
  type GitHubNangoConnectPhase,
} from '@/lib/github-nango-connect';
import type { GitHubInstallationStatus } from '@kortix/sdk';

interface UseGitHubNangoConnectOptions {
  accountId: string | null;
  onConnected?: (installation: GitHubInstallationStatus) => void | Promise<void>;
}

type GitHubNangoConnectError = Extract<GitHubNangoConnectOutcome, { status: 'error' }>;

export function useGitHubNangoConnect({
  accountId,
  onConnected,
}: UseGitHubNangoConnectOptions) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const lastInstallationIdRef = useRef<string | undefined>(undefined);
  const runIdRef = useRef(0);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const [phase, setPhase] = useState<GitHubNangoConnectPhase | 'idle'>('idle');
  const [error, setError] = useState<GitHubNangoConnectError | null>(null);

  const start = useCallback(
    async (installationId?: string): Promise<GitHubNangoConnectOutcome | null> => {
      if (!accountId) {
        const outcome: GitHubNangoConnectError = {
          status: 'error',
          code: 'session_failed',
          message: 'Select a Kortix account before connecting GitHub.',
        };
        setError(outcome);
        return outcome;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastInstallationIdRef.current = installationId;
      const runId = ++runIdRef.current;
      setError(null);
      setPhase('requesting');

      const outcome = await runGitHubNangoConnect({
        accountId,
        installationId,
        signal: controller.signal,
        onPhaseChange: (nextPhase) => {
          if (runIdRef.current === runId) setPhase(nextPhase);
        },
      });

      if (runIdRef.current !== runId) return outcome;
      abortRef.current = null;
      await queryClient.invalidateQueries({
        queryKey: ['github-installations', accountId],
      });
      await queryClient.refetchQueries({
        queryKey: ['github-installations', accountId],
        type: 'active',
      });

      if (outcome.status === 'connected') {
        setPhase('idle');
        await onConnectedRef.current?.(outcome.installation);
      } else if (outcome.status === 'error') {
        setPhase('idle');
        setError(outcome);
      } else {
        setPhase('idle');
      }

      return outcome;
    },
    [accountId, queryClient],
  );

  const retry = useCallback(
    () => start(lastInstallationIdRef.current),
    [start],
  );

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [accountId]);

  return {
    start,
    retry,
    cancel,
    clearError,
    phase,
    error,
    isPending: phase !== 'idle',
  };
}
