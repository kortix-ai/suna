'use client';

/**
 * One read-only line: where Kortix-managed repositories on this instance are
 * created.
 *
 * This is what an account-scoped surface is allowed to say about managed git.
 * The CONFIGURATION of it is instance-global and lives at `/admin/git` — see
 * `github-app-setup-card.tsx` for the incident that separated the two. So this
 * component has no controls, no mutation and no link into a platform surface a
 * customer admin cannot open.
 *
 * It reads `getManagedGitBackend()`, which any authenticated user may call, NOT
 * `getGitHubAppStatus()`, which is platform-admin only and 403s here.
 */

import { useQuery } from '@tanstack/react-query';

import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { getManagedGitBackend } from '@kortix/sdk';

export const MANAGED_GIT_BACKEND_KEY = ['managed-git-backend'];

export function ManagedGitNotice() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const backendQuery = useQuery({
    queryKey: MANAGED_GIT_BACKEND_KEY,
    queryFn: () => getManagedGitBackend(),
    staleTime: 60_000,
    // One line of context is never worth a retry storm, and the caller has no
    // error state to show — see the fallback below.
    retry: false,
  });

  if (backendQuery.isLoading) return <Skeleton className="h-4 w-72" />;
  // A failed read renders nothing. The alternative — an error banner under the
  // connections card — would claim a problem with the account's own GitHub
  // connections, which this line does not describe.
  if (backendQuery.isError || !backendQuery.data) return null;

  const { configured, owner } = backendQuery.data;

  return (
    <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
      {!configured
        ? tI18nComplete.raw('textb79bb0e54e4f')
        : owner
          ? tI18nComplete('text39481fc24bd5', { value0: owner })
          : tI18nComplete.raw('text89a9816ffa6f')}
    </p>
  );
}
