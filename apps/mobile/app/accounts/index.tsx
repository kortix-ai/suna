/**
 * Accounts list (web parity: /accounts). Every account the signed-in user
 * belongs to — tap one to manage it (members, groups, git, audit, settings),
 * or create a new account. Settings-list layout: see apps/mobile/design.md.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PlatformButton } from '@/components/kortix/platform-button';
import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { NewAccountSheet } from '@/components/accounts/NewAccountSheet';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { useAccounts } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';

function roleLabel(account: { account_role?: string }): string {
  const r = account.account_role;
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Member';
}

export default function AccountsListScreen() {
  const router = useRouter();
  const { user } = useAuthContext();
  const accountsQuery = useAccounts(!!user);
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [showNewAccount, setShowNewAccount] = React.useState(false);

  const accounts = accountsQuery.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <SettingsHeader
        title="Accounts"
        right={
          <PlatformButton
            label="New"
            systemImage="plus"
            icon={Plus}
            accessibilityLabel="New account"
            onPress={() => {
              haptics.tap();
              setShowNewAccount(true);
            }}
          />
        }
      />

      <SettingsPage>
        {accountsQuery.isLoading ? (
          <View className="items-center py-12">
            <KortixLoader />
          </View>
        ) : accounts.length === 0 ? (
          <Text variant="muted" className="py-10 text-center">
            No accounts yet. Create one to get started.
          </Text>
        ) : (
          <SettingsGroup>
            {accounts.map((a) => (
              <SettingsRow
                key={a.account_id}
                leading={<Avatar variant="custom" size={28} fallbackText={a.name} />}
                label={a.name}
                value={roleLabel(a)}
                checked={a.account_id === selectedAccountId}
                onPress={() => {
                  haptics.tap();
                  router.push(`/accounts/${a.account_id}`);
                }}
              />
            ))}
          </SettingsGroup>
        )}
      </SettingsPage>

      <NewAccountSheet
        open={showNewAccount}
        onClose={() => setShowNewAccount(false)}
        onCreated={(account) => {
          setShowNewAccount(false);
          setSelectedAccountId(account.account_id);
          router.push(`/accounts/${account.account_id}`);
        }}
      />
    </View>
  );
}
