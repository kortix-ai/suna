'use client';

/**
 * `/settings/[tab]` — deep-link into the merged Settings overlay with NO
 * project context (e.g. `/settings/profile`, `/settings/billing`). This is
 * the account-scoped door into the same overlay the two
 * `/projects/[id]/settings*` routes open project-scoped — see the "You" and
 * "Organization" rail groups in `rail.ts`, which is why this route exists
 * with no `[id]` segment at all rather than defaulting to some remembered
 * project.
 *
 * **History, because it has flipped twice.** It first rendered `SettingsPanel`
 * directly, which left a blank page once the overlay was closed (nothing sat
 * behind it). It was then changed to set store state and bounce to
 * `PROJECT_LANDING_PATH`, letting `ProjectShell` mount the panel. That fixed
 * the blank page but routed every visitor through `/projects/start`, the door
 * that PROVISIONS a first project — the exact opposite of what the sign-in
 * redirect for a user without app access needs. It now renders the panel
 * directly again, with the blank page fixed properly instead of avoided. The
 * reasoning lives in one place: `standalone-settings-route.tsx`'s header.
 *
 * Retired account tabs open their replacement in the account hub. Unknown
 * segments still open the account-scoped default rather than 404ing.
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { RouteLoadingFallback } from '@/components/common/route-loading';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/features/layout/section/error-state';
import { useSettingsAccountId } from '@/features/workspace/settings/use-settings-account-id';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useTranslations } from '@/i18n/use-translations';

import {
  isAccountGraduatedSection,
  legacySectionRedirect,
  parseSettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import {
  STANDALONE_DEFAULT_SETTINGS_TAB,
  StandaloneSettingsRoute,
} from '@/features/workspace/settings/standalone-settings-route';

export default function SettingsTabPage() {
  const params = useParams<{ tab: string }>();
  const tab = parseSettingsTab(params?.tab);
  const router = useRouter();
  useEnsureSelectedAccount();
  const accounts = useAccountsList();
  const t = useTranslations('common');
  const graduated = isAccountGraduatedSection(params?.tab);
  const selectedAccountId = useSettingsAccountId();
  // Validate persisted selection against this identity's accounts.
  const accountId = (
    accounts.data?.find((account) => account.account_id === selectedAccountId) ?? accounts.data?.[0]
  )?.account_id;
  const href =
    graduated && accountId && !accounts.isError
      ? legacySectionRedirect('', params?.tab, accountId)
      : null;

  useEffect(() => {
    if (href) router.replace(href);
  }, [href, router]);

  if (graduated) {
    if (href || accounts.isPending) return <RouteLoadingFallback />;
    return (
      <ErrorState
        title={t('error')}
        action={<Button onClick={() => accounts.refetch()}>{t('retry')}</Button>}
      />
    );
  }
  return <StandaloneSettingsRoute tab={tab ?? STANDALONE_DEFAULT_SETTINGS_TAB} />;
}
