'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';

/**
 * "Take me into the app" — the latest project this user had open, else the
 * landing door that resolves one.
 *
 * Use this from components instead of calling `latestProjectPath` directly.
 * The raw function takes a user id because the remembered project is scoped to
 * its owner, and threading that through by hand meant call sites without a
 * convenient `user` passed `null` — technically safe (it degrades to the door)
 * but it made "I could not be bothered" and "there is genuinely no user here"
 * indistinguishable at a glance. Binding the lookup to `useAuth` removes the
 * choice: every component gets the correct answer with no argument to get
 * wrong.
 *
 * Not for post-account-switch navigation — see `latestProjectPath`.
 */
export function useAppHome(): string {
  const { user } = useAuth();
  return latestProjectPath(user?.id);
}
