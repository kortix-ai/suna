/**
 * Account screen (web parity: app/accounts/[id]/page.tsx).
 *
 * Native back header titled with the account name, a pill tab switcher
 * (Members, Groups, Git, Audit, Settings), then the active tab. Every tab
 * renders its own `SettingsPage`. Billing is intentionally omitted on mobile.
 * Tabs gate on IAM capabilities probed for the current user.
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { AlertCircle, RotateCw } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { useEffectiveAccountCaps } from '@/components/accounts/account-shared';
import { MembersTab } from '@/components/accounts/MembersTab';
import { GroupsTab } from '@/components/accounts/GroupsTab';
import { GitTab } from '@/components/accounts/GitTab';
import { AuditTab } from '@/components/accounts/AuditTab';
import { AccountSettingsTab } from '@/components/accounts/AccountSettingsTab';

type TabKey = 'members' | 'groups' | 'git' | 'audit' | 'settings';

export default function AccountSettingsScreen() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const params = useLocalSearchParams<{ id: string }>();
  const accountId = params.id;
  const { user } = useAuthContext();

  const { accountQuery, account, can } = useEffectiveAccountCaps(accountId ?? null, user?.id ?? null);

  const [tab, setTab] = React.useState<TabKey>('members');

  const tabs = React.useMemo(() => {
    const list: { key: TabKey; label: string; show: boolean }[] = [
      { key: 'members', label: 'Members', show: true },
      { key: 'groups', label: 'Groups', show: true },
      { key: 'git', label: 'Git', show: can['account.write'] },
      { key: 'audit', label: 'Audit', show: can['audit.read'] },
      { key: 'settings', label: 'Settings', show: can['account.write'] },
    ];
    return list.filter((t) => t.show);
  }, [can]);

  // If the active tab becomes hidden (caps resolve), fall back to members.
  React.useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab('members');
  }, [tabs, tab]);

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <SettingsHeader title={account?.name ?? 'Account'} />

      {tabs.length > 1 && (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            haptics.selection();
            setTab(next as TabKey);
          }}
          className="pb-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20 }}>
            <TabsList className="rounded-full">
              {tabs.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="rounded-full px-3.5">
                  <Text>{t.label}</Text>
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollView>
        </Tabs>
      )}

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
        <View className="flex-1">
          {tab === 'members' ? (
            <MembersTab account={account} currentUserId={user?.id ?? ''} can={can} isDark={isDark} />
          ) : tab === 'groups' ? (
            <GroupsTab account={account} can={can} isDark={isDark} />
          ) : tab === 'git' ? (
            <GitTab account={account} can={can} isDark={isDark} />
          ) : tab === 'audit' ? (
            <AuditTab account={account} isDark={isDark} />
          ) : (
            <AccountSettingsTab account={account} can={can} isDark={isDark} />
          )}
        </View>
      )}
    </View>
  );
}
