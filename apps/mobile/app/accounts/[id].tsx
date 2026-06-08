/**
 * Account Settings screen (web parity: app/accounts/[id]/page.tsx).
 *
 * Tabbed account management: Members · Groups · Git · Audit · Settings. Billing
 * is intentionally omitted on mobile. Tabs gate on IAM capabilities probed for
 * the current user. Mobile branding: custom header + scrollable tab bar.
 */

import * as React from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { useAuthContext } from '@/contexts';
import { useAccount, useAccountCapabilities } from '@/lib/accounts/hooks';
import { haptics } from '@/lib/haptics';
import { MembersTab } from '@/components/accounts/MembersTab';
import { GroupsTab } from '@/components/accounts/GroupsTab';
import { GitTab } from '@/components/accounts/GitTab';
import { AuditTab } from '@/components/accounts/AuditTab';
import { AccountSettingsTab } from '@/components/accounts/AccountSettingsTab';

type TabKey = 'members' | 'groups' | 'git' | 'audit' | 'settings';

export default function AccountSettingsScreen() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const accountId = params.id;
  const { user } = useAuthContext();

  const accountQuery = useAccount(accountId ?? null);
  const { can } = useAccountCapabilities(accountId ?? null, user?.id ?? null);
  const account = accountQuery.data;

  const [tab, setTab] = React.useState<TabKey>('members');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const bg = isDark ? '#0D0D0D' : '#FFFFFF';
  const theme = useThemeColors();

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
    <View style={{ flex: 1, backgroundColor: bg }}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 12 }}>
        <TouchableOpacity
          onPress={() => { haptics.tap(); router.back(); }}
          hitSlop={10}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginBottom: 10 }}
        >
          <ChevronLeft size={18} color={muted} />
          <Text style={{ fontSize: 13.5, color: muted }}>Accounts</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 19, fontFamily: 'Roobert-Semibold', color: fg }}>{(account?.name?.trim()?.[0] ?? 'A').toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 21, fontFamily: 'Roobert-Semibold', color: fg }} numberOfLines={1}>{account?.name ?? 'Account'}</Text>
            <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }}>
              {account ? `${account.member_count} member${account.member_count === 1 ? '' : 's'} · ${account.project_count} project${account.project_count === 1 ? '' : 's'}` : 'Account settings'}
            </Text>
          </View>
        </View>
      </View>

      {/* Tab bar */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 10 }}>
          {tabs.map((t) => {
            const on = tab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => { haptics.selection(); setTab(t.key); }}
                activeOpacity={0.7}
                style={{ paddingHorizontal: 14, paddingVertical: 13, position: 'relative' }}
              >
                <Text style={{ fontSize: 14.5, fontFamily: on ? 'Roobert-Medium' : 'Roobert', color: on ? fg : muted }}>{t.label}</Text>
                {on && <View style={{ position: 'absolute', left: 14, right: 14, bottom: -1, height: 2.5, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: theme.primary }} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Content */}
      {accountQuery.isLoading || !account ? (
        accountQuery.isError ? (
          <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: 14, color: '#ef4444', textAlign: 'center' }}>{(accountQuery.error as Error)?.message || 'Failed to load account'}</Text>
            <TouchableOpacity onPress={() => accountQuery.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        )
      ) : (
        <View style={{ flex: 1 }}>
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
