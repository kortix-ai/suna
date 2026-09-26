/**
 * Account detail (web parity: app/accounts/[id]/page.tsx). Mobile does not
 * maintain settings parity with web (COR-120): this screen is a small plan +
 * web handoff, not a rebuild of the web admin tabs. See apps/mobile/design.md
 * → Account page and account screens.
 *
 * Native back header titled with the account name, one Billing row (plan ·
 * balance as its value, opens `/billing` for this account), then "On
 * kortix.com" — Members, Git, Audit log — each opening the matching web tab
 * in the in-app browser. Git and Audit log are hidden when the signed-in
 * user lacks the same capability the old tabs gated on.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  ArrowClockwiseIcon as RotateCw,
  GitBranchIcon as GitBranch,
  ListIcon as List,
  UsersIcon as Users,
  WarningCircleIcon as AlertCircle,
} from '@/lib/icons';
import { formatCredits } from '@kortix/shared';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useEffectiveAccountCaps } from '@/components/accounts/account-shared';
import { useAuthContext } from '@/contexts';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { useAccountState } from '@/lib/billing';
import { accountHubUrl } from '@/lib/accounts/web-account-links';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';

export default function AccountDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const accountId = params.id;
  const router = useRouter();
  const { user } = useAuthContext();

  const { accountQuery, account, can } = useEffectiveAccountCaps(accountId ?? null, user?.id ?? null);

  const accountStateQuery = useAccountState({
    accountId,
    enabled: !!accountId,
  });
  const planName = accountStateQuery.data?.plan?.label ?? '';
  const creditsTotal = accountStateQuery.data?.credits?.total;
  // "Team · 1,240 credits": the plan and the balance in one value.
  const billingSummary =
    [planName, creditsTotal != null ? `${formatCredits(creditsTotal)} credits` : '']
      .filter(Boolean)
      .join(' · ') || undefined;

  const openWebTab = React.useCallback(
    (tab: 'members' | 'git' | 'audit') => {
      if (!accountId) return;
      haptics.tap();
      WebBrowser.openBrowserAsync(accountHubUrl(KORTIX_WEB_URL, accountId, tab)).catch((error) => {
        log.error('Error opening account web tab:', error);
      });
    },
    [accountId]
  );

  const openBilling = React.useCallback(() => {
    haptics.tap();
    router.push({ pathname: '/billing', params: accountId ? { accountId } : {} });
  }, [router, accountId]);

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <SettingsHeader title={account?.name ?? 'Account'} />

      {accountQuery.isError ? (
        <SettingsPage>
          <SettingsGroup>
            <SettingsRow
              icon={AlertCircle}
              label={(accountQuery.error as Error)?.message || "Couldn't load this account"}
              destructive
            />
            <SettingsRow
              icon={RotateCw}
              label="Try again"
              onPress={() => {
                haptics.tap();
                void accountQuery.refetch();
              }}
            />
          </SettingsGroup>
        </SettingsPage>
      ) : accountQuery.isLoading || !account ? (
        <View className="items-center py-16">
          <KortixLoader />
        </View>
      ) : (
        <SettingsPage>
          <SettingsGroup>
            <SettingsRow label="Billing" value={billingSummary} onPress={openBilling} />
          </SettingsGroup>

          <SettingsGroup title="On kortix.com">
            <SettingsRow icon={Users} label="Members" external onPress={() => openWebTab('members')} />
            {can['account.write'] && (
              <SettingsRow icon={GitBranch} label="Git" external onPress={() => openWebTab('git')} />
            )}
            {can['audit.read'] && (
              <SettingsRow icon={List} label="Audit log" external onPress={() => openWebTab('audit')} />
            )}
          </SettingsGroup>
        </SettingsPage>
      )}
    </View>
  );
}
