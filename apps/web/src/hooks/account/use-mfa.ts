/**
 * The MFA state machine shared by every surface that lets a member manage
 * their own second factor (authenticator app / TOTP): the factor list, the
 * current session's `aal` level, and the enroll / verify / remove /
 * cancel-enroll mutations.
 *
 * Extracted from `features/accounts/settings/security-tab.tsx` (Task 10) —
 * `features/workspace/settings/tabs/profile-tab.tsx` had re-implemented the
 * same ~90 lines of orchestration by hand (Task 7's port), which left two
 * copies reading and writing the same `['mfa-factors']` / `['mfa-aal']`
 * query keys. Diffing them line-for-line before extracting turned up no
 * behavioural divergence — only cosmetic renames (`code` vs `enrollCode`,
 * `setRemoveTarget` vs `setRemoveFactorTarget`) and a defensive
 * `if (enrolling)` guard around the cancel-enroll cleanup that
 * `profile-tab.tsx` had added but that never changes behaviour, since the
 * Cancel button that calls it only ever renders while `enrolling` is set.
 * That guarded version is what this hook keeps.
 *
 * `FactorRow` (the pure per-factor row) and `totpQrSrc` (the QR data-URL
 * normalizer) are NOT here — they're view code, not state, and this file
 * stays hook-only (`.ts`, no JSX). They now live in `profile-tab.tsx`, their
 * sole remaining consumer.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';
import { invalidateTokenCache } from '@/lib/auth-token';
import { createClient } from '@/lib/supabase/client';
import { supabaseMFAService } from '@/lib/supabase/mfa';

export const MFA_FACTORS_QUERY_KEY = ['mfa-factors'] as const;
export const MFA_AAL_QUERY_KEY = ['mfa-aal'] as const;

export interface EnrollingFactor {
  factorId: string;
  qr: string;
  secret?: string;
}

export function useMfa() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  const [enrolling, setEnrolling] = useState<EnrollingFactor | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [removeFactorTarget, setRemoveFactorTarget] = useState<string | null>(null);

  const factorsQuery = useQuery({
    queryKey: MFA_FACTORS_QUERY_KEY,
    queryFn: () => supabaseMFAService.listFactors(),
    staleTime: 10_000,
  });

  const aalQuery = useQuery({
    queryKey: MFA_AAL_QUERY_KEY,
    queryFn: () => supabaseMFAService.getAAL(),
    staleTime: 10_000,
  });

  const startEnrollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Authenticator (${new Date().toISOString().slice(0, 10)})`,
      });
      if (error) throw new Error(error.message);
      if (!data?.totp?.qr_code) throw new Error('Enrollment returned no QR code');
      return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    },
    onSuccess: (data) => {
      setEnrolling(data);
      setEnrollCode('');
    },
    onError: (error: Error) => errorToast(error.message || 'Could not start enrollment'),
  });

  const removeFactorMutation = useMutation({
    mutationFn: (factorId: string) => supabaseMFAService.unenrollFactor(factorId),
    onSuccess: () => {
      successToast('Factor removed');
      setRemoveFactorTarget(null);
      queryClient.invalidateQueries({ queryKey: MFA_FACTORS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MFA_AAL_QUERY_KEY });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove factor'),
  });

  const verifyEnrollMutation = useMutation({
    mutationFn: async () => {
      if (!enrolling) throw new Error('No enrollment in progress');
      await supabaseMFAService.challengeAndVerify({
        factor_id: enrolling.factorId,
        code: enrollCode,
      });
    },
    onSuccess: () => {
      // Verifying the first factor elevates this session to aal2. Bust the
      // 30s token cache so the next gated request uses the new token instead
      // of replaying the stale aal1 one.
      invalidateTokenCache();
      successToast('Authenticator enrolled — this session is now MFA-verified');
      setEnrolling(null);
      setEnrollCode('');
      // Refetch every active query so data that 403'd while aal1 (projects,
      // API keys, members) repopulates on its own — no manual page reload,
      // and the MFA error banners on those screens clear.
      queryClient.invalidateQueries();
    },
    onError: (error: Error) => errorToast(error.message || 'Code did not verify'),
  });

  const cancelEnroll = () => {
    // Abandoning enrollment leaves an unverified factor behind — clean it up
    // so the list doesn't accumulate ghosts.
    if (enrolling) removeFactorMutation.mutate(enrolling.factorId);
    setEnrolling(null);
  };

  return {
    factors: factorsQuery.data?.factors ?? [],
    factorsLoading: factorsQuery.isLoading,
    factorsError: factorsQuery.isError,
    onRetryFactors: () => factorsQuery.refetch(),
    sessionVerified: aalQuery.data?.current_level === 'aal2',

    enrolling,
    enrollCode,
    setEnrollCode,
    startEnroll: () => startEnrollMutation.mutate(),
    isStartingEnroll: startEnrollMutation.isPending,
    verifyEnroll: () => verifyEnrollMutation.mutate(),
    isVerifyingEnroll: verifyEnrollMutation.isPending,
    cancelEnroll,

    removeFactorTarget,
    setRemoveFactorTarget,
    confirmRemoveFactor: () =>
      removeFactorTarget && removeFactorMutation.mutate(removeFactorTarget),
    isRemovingFactor: removeFactorMutation.isPending,
  };
}
