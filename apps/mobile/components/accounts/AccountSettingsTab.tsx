/**
 * Account → Settings (web parity: Settings tab). Grouped cards:
 *   • General — rename the account.
 *   • Security — require MFA + advanced session controls.
 *   • Tokens & automation — PAT policy + service accounts.
 *   • Observability — audit webhooks.
 *   • Danger zone — delete account (coming soon, like web).
 */

import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useUpdateAccountName } from '@/lib/accounts/hooks';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import { accountColors, Divider, SectionLabel, type AccountCaps } from './account-shared';
import { SecurityCards } from './settings/SecurityCards';
import { TokensCards } from './settings/TokensCards';
import { ObservabilityCards } from './settings/ObservabilityCards';

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Uppercase group label + optional description, sitting above transparent content. */
function GroupHead({ title, description, isDark }: { title: string; description?: string; isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <View style={{ marginBottom: 12 }}>
      <SectionLabel isDark={isDark}>{title}</SectionLabel>
      {description && <Text style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>{description}</Text>}
    </View>
  );
}

function GeneralSection({ account, canWrite, isDark }: { account: AccountDetail; canWrite: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const update = useUpdateAccountName(account.account_id);
  const [name, setName] = useState(account.name);
  useEffect(() => { setName(account.name); }, [account.name]);

  const trimmed = name.trim();
  const dirty = canWrite && trimmed.length > 0 && trimmed !== account.name;
  const save = () => {
    if (!dirty) return;
    haptics.tap();
    update.mutate(trimmed, { onSuccess: () => haptics.success(), onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update account.') });
  };

  return (
    <View>
      <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Account name</Text>
      <TextInput value={name} onChangeText={setName} editable={canWrite && !update.isPending} maxLength={120} placeholderTextColor={c.muted}
        style={{ height: 44, borderRadius: 9999, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 16, fontSize: 14, color: c.fg, fontFamily: 'Roobert' }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
        <Text style={{ flex: 1, fontSize: 11.5, color: c.muted }}>Created {formatDate(account.created_at)}</Text>
        <TouchableOpacity onPress={save} disabled={!dirty || update.isPending} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, height: 40, borderRadius: 9999, backgroundColor: theme.primary, opacity: dirty && !update.isPending ? 1 : 0.5 }}>
          {update.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function DangerSection({ isDark }: { isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>Delete account</Text>
        <Text style={{ fontSize: 12, color: c.muted, marginTop: 2 }}>Permanently delete this account and all associated projects.</Text>
      </View>
      <View style={{ paddingHorizontal: 14, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
        <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.muted }}>Coming soon</Text>
      </View>
    </View>
  );
}

export function AccountSettingsTab({ account, can, isDark }: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  const insets = useSafeAreaInsets();
  const canWrite = can['account.write'];
  const canDelete = can['account.delete'];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: insets.bottom + 48 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <GroupHead title="General" isDark={isDark} />
      <GeneralSection account={account} canWrite={canWrite} isDark={isDark} />

      <Divider isDark={isDark} my={24} />
      <GroupHead title="Security" description="Account-wide gates that apply to every member." isDark={isDark} />
      <SecurityCards accountId={account.account_id} canManage={canWrite} isDark={isDark} />

      <Divider isDark={isDark} my={24} />
      <GroupHead title="Tokens & automation" description="Programmatic access for CI/CD and headless agents." isDark={isDark} />
      <TokensCards accountId={account.account_id} canManage={canWrite} isDark={isDark} />

      <Divider isDark={isDark} my={24} />
      <GroupHead title="Observability" description="Forward audit events to your own pipeline." isDark={isDark} />
      <ObservabilityCards accountId={account.account_id} canManage={canWrite} isDark={isDark} />

      {canDelete && (
        <>
          <Divider isDark={isDark} my={24} />
          <GroupHead title="Danger zone" isDark={isDark} />
          <DangerSection isDark={isDark} />
        </>
      )}
    </ScrollView>
  );
}
