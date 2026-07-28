import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AnonymousHomeShell } from '@/features/home/anonymous-home-shell';
import { LAST_PROJECT_COOKIE, isValidProjectId } from '@/lib/home/last-project-cookie';
import { MAX_ACCOUNTS_TO_SEARCH, resolveLandingPath } from '@/lib/home/resolve-landing-project';
import { createClient } from '@/lib/supabase/server';
import { fetchAccountsWithToken, fetchProjectsForAccountWithToken } from '@kortix/sdk';

export const metadata: Metadata = {
  title: 'Kortix',
  description: 'Give your company a workforce of AI agents.',
};

const BACKEND_TIMEOUT_MS = 6_000;

/**
 * `/` is the product.
 *
 * Signed out: the real shell with every action gated behind sign-in — the
 * product is visible before signup, which is the whole point of this change.
 *
 * Signed in: resolve where they were last working and redirect. A redirect,
 * not a render-in-place: ProjectSwitcher keys off `pathname.startsWith
 * ('/projects/')` and ProjectShell's `?customize=` effect replaces to
 * `/projects/{id}`, so rendering the shell at `/` would silently navigate away.
 *
 * HARD RULE: this must never redirect to /auth. Every failure path falls
 * through to /projects, because a backend blip that turns the homepage into a
 * login wall is far worse than a slightly wrong landing.
 */
export default async function HomePage() {
  const supabase = await createClient();

  let userId: string | undefined;
  let accessToken: string | undefined;
  try {
    const [{ data: userData }, { data: sessionData }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ]);
    userId = userData?.user?.id;
    accessToken = sessionData?.session?.access_token;
  } catch {
    // Auth unreachable — show the product, not an error.
  }

  if (!userId) {
    // The shell reads `?view=` to preview a section, so it needs a boundary.
    return (
      <Suspense fallback={<div className="bg-background min-h-dvh" />}>
        <AnonymousHomeShell />
      </Suspense>
    );
  }

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(LAST_PROJECT_COOKIE)?.value;
  const cookieProjectId = isValidProjectId(rawCookie) ? rawCookie : null;

  const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';
  if (!backendUrl || !accessToken) {
    // Nothing to resolve against. The cookie alone is not enough — it could
    // name a project that was deleted or whose access was revoked.
    redirect('/projects');
  }

  let path = '/projects';
  try {
    const tokenOpts = { backendUrl, accessToken, timeoutMs: BACKEND_TIMEOUT_MS };
    const accounts = (await fetchAccountsWithToken(tokenOpts)) ?? [];
    const accountIds = accounts
      .map((account) => account.account_id)
      .filter((id): id is string => !!id)
      .slice(0, MAX_ACCOUNTS_TO_SEARCH);

    const projectsByAccount = await Promise.all(
      accountIds.map(async (accountId) => {
        try {
          return (await fetchProjectsForAccountWithToken(tokenOpts, accountId)) ?? [];
        } catch {
          return [];
        }
      }),
    );

    path = resolveLandingPath({ cookieProjectId, projectsByAccount });
  } catch {
    // Falls through to /projects, which has the right empty state and the
    // create-project modal. Never /auth.
  }

  redirect(path);
}
