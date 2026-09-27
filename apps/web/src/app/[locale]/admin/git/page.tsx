'use client';

/**
 * `/admin/git` — the instance's ONE managed-git identity.
 *
 * This page exists because the card it hosts used to render inside an
 * account-scoped page. On 2026-09-16 a platform admin ran its manifest flow
 * from `Settings → <a customer account> → Git`. The callback overwrote
 * `kortix.platform_settings.managed_github_app`, the single global row every
 * managed-git accessor reads before falling back to env, and every GitHub
 * connection on production broke for about six minutes.
 *
 * The rule that came out of it: a surface that writes instance-global state
 * never renders inside a page scoped to one account. So the card lives here,
 * behind the platform-admin gate `admin-shell.tsx` already enforces, and the
 * account Git tab keeps only account-scoped controls plus a read-only
 * `ManagedGitNotice`.
 *
 * The page header says the scope in words, because the card's own title
 * ("Managed GitHub") does not: a reader has to be told that this one form
 * decides how EVERY project on the instance reaches GitHub.
 */

import { Suspense } from 'react';

import { GitHubAppSetupCard } from '@/components/iam/github-app-setup-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';

import { AdminPageShell } from '../_components/admin-page-shell';

export default function AdminGitPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <AdminPageShell
      title={tI18nComplete.raw('textb949c922b6ef')}
      description={tI18nComplete.raw('text42888e8dc93e')}
    >
      {/* `GitHubAppSetupCard` reads `?github=connected` off the URL, so it
          needs a Suspense boundary of its own — `useSearchParams` opts its
          subtree into client rendering and Next refuses to prerender the page
          without one. */}
      <Suspense fallback={<Skeleton className="h-44 w-full rounded-md" />}>
        <GitHubAppSetupCard />
      </Suspense>
    </AdminPageShell>
  );
}
