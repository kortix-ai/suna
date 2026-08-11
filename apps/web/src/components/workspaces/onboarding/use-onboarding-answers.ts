'use client';

/**
 * Holds the survey answers locally and mirrors each one to the server as it is
 * given, so a user who abandons onboarding at the tools step still leaves their
 * use case and company behind. Waiting until the finish step would throw away
 * every partial answer, which is most of them.
 *
 * Saves are deliberately fire-and-forget. A failed profile write must not block
 * navigation and must not raise a toast: the user asked to advance a step, not
 * to save a form. The answer is lost; the onboarding is not.
 */

import { useCallback, useState } from 'react';

import { setWorkspaceOnboardingProfile, type OnboardingProfile } from '@kortix/sdk';

export function useOnboardingAnswers(workspaceId: string) {
  const [answers, setAnswers] = useState<OnboardingProfile>({});

  const save = useCallback(
    (patch: OnboardingProfile) => {
      setAnswers((prev) => ({ ...prev, ...patch }));
      void setWorkspaceOnboardingProfile(workspaceId, patch).catch(() => {
        // Intentionally silent — see the module comment.
      });
    },
    [workspaceId],
  );

  return { answers, save };
}
