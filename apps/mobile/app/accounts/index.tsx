/**
 * Accounts list (web parity: /accounts). Every account the signed-in user
 * belongs to — tap one to manage it (members, groups, git, audit, settings).
 * Mobile branding: custom header + borderless divider list.
 */

import * as React from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useAuthContext } from '@/contexts';
import { useAccounts } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';

function roleLabel(account: { account_role?: string; personal_account?: boolean }): string {
  if (account.personal_account) return 'Personal';
  const r = account.account_role;
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Member';
}

export default function AccountsListScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const { user } = useAuthContext();
  const accountsQuery = useAccounts(!!user);
  const { selectedAccountId } = useCurrentAccountStore();

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const avatarBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const bg = isDark ? '#0D0D0D' : '#FFFFFF';

  const accounts = accountsQuery.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10 }}>
        <TouchableOpacity onPress={() => { haptics.tap(); router.back(); }} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginBottom: 10 }}>
          <ChevronLeft size={18} color={muted} />
          <Text style={{ fontSize: 13.5, color: muted }}>Back</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 24, fontFamily: 'Roobert-Semibold', color: fg }}>Accounts</Text>
        <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>Teams and personal accounts you belong to.</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {accountsQuery.isLoading ? (
          <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        ) : accounts.length === 0 ? (
          <Text style={{ fontSize: 13.5, color: muted, textAlign: 'center', paddingVertical: 40 }}>No accounts.</Text>
        ) : (
          <View>
            {accounts.map((a, i) => {
              const selected = a.account_id === selectedAccountId;
              return (
                <TouchableOpacity
                  key={a.account_id}
                  onPress={() => { haptics.tap(); router.push(`/accounts/${a.account_id}`); }}
                  activeOpacity={0.6}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}
                >
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: avatarBg, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 16, fontFamily: 'Roobert-Semibold', color: fg }}>{(a.name?.trim()?.[0] ?? '?').toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{a.name}</Text>
                    <Text style={{ fontSize: 12, color: muted, marginTop: 1 }}>{roleLabel(a)}</Text>
                  </View>
                  {selected && <Check size={17} color={theme.primary} />}
                  <ChevronRight size={17} color={muted} />
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
