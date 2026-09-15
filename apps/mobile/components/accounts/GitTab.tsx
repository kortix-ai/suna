/**
 * Account → Git (web parity: GitHubConnectionCard). Connected GitHub App
 * installations; connect a new one (opens the install URL); tap a connection
 * to configure or disconnect it. Settings-list layout: see apps/mobile/design.md.
 */

import React, { useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Github, RotateCw } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { listGitHubInstallations, deleteGitHubInstallation } from '@/lib/projects/projects-client';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import type { AccountCaps } from './account-shared';

function repositoryScope(selection: string | null | undefined): string {
  if (selection === 'selected') return 'Selected repos';
  if (selection === 'all') return 'All repos';
  return 'Connected';
}

export function GitTab({ account, can }: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  const accountId = account.account_id;
  const canManage = can['account.write'];
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);

  const installationsQuery = useQuery({
    queryKey: ['github-installations', accountId],
    queryFn: () => listGitHubInstallations(accountId),
    staleTime: 0,
  });

  const disconnect = useMutation({
    mutationFn: (installationId: string) => deleteGitHubInstallation(accountId, installationId),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['github-installations', accountId] });
    },
    onError: (e: any) => Alert.alert('Unable to disconnect', e?.message || 'Try again in a moment.'),
  });

  const installations = installationsQuery.data?.installations ?? [];

  const handleConnect = async () => {
    if (!canManage) return;
    haptics.tap();
    setConnecting(true);
    try {
      const res = await installationsQuery.refetch();
      if (res.error) throw res.error;
      const installUrl = res.data?.install_url;
      if (!installUrl) {
        Alert.alert('GitHub unavailable', res.data?.configured === false ? 'The GitHub App is not configured.' : 'The GitHub install link is unavailable.');
        return;
      }
      await Linking.openURL(installUrl);
    } catch (e: any) {
      Alert.alert('Unable to connect GitHub', e?.message || 'Try again in a moment.');
    } finally {
      setConnecting(false);
    }
  };

  const confirmDisconnect = (installationId: string, owner: string | null) => {
    Alert.alert(
      `Disconnect ${owner ?? 'GitHub'}?`,
      'New imports from this account stop working. Existing projects keep their repository link.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => { haptics.medium(); disconnect.mutate(installationId); } },
      ],
    );
  };

  // Row press → action sheet with the actions this connection supports.
  const openConnectionActions = (inst: (typeof installations)[number]) => {
    const id = inst.installation_id ?? '';
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (inst.installation_url) {
      buttons.push({ text: 'Configure on GitHub', onPress: () => { void Linking.openURL(inst.installation_url!); } });
    }
    if (canManage && id) {
      buttons.push({ text: 'Disconnect', style: 'destructive', onPress: () => confirmDisconnect(id, inst.owner_login) });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    haptics.selection();
    Alert.alert(inst.owner_login ?? 'GitHub', undefined, buttons);
  };

  return (
    <SettingsPage>
      {canManage && (
        <SettingsGroup>
          <SettingsRow
            icon={Github}
            label={connecting ? 'Opening GitHub…' : 'Connect GitHub'}
            external
            onPress={connecting ? undefined : () => void handleConnect()}
          />
        </SettingsGroup>
      )}

      {installationsQuery.isLoading ? (
        <View className="items-center py-12">
          <KortixLoader />
        </View>
      ) : installationsQuery.isError ? (
        <SettingsGroup>
          <SettingsRow icon={AlertCircle} label="GitHub status unavailable" destructive />
          <SettingsRow
            icon={RotateCw}
            label="Try again"
            right={null}
            onPress={() => {
              haptics.tap();
              installationsQuery.refetch();
            }}
          />
        </SettingsGroup>
      ) : installations.length === 0 ? (
        <Text variant="muted" className="py-10 text-center">
          No GitHub connections yet.
        </Text>
      ) : (
        <SettingsGroup title="GitHub connections">
          {installations.map((inst) => (
            <SettingsRow
              key={inst.installation_id || inst.owner_login || 'gh'}
              icon={Github}
              label={inst.owner_login ?? 'GitHub App'}
              value={repositoryScope(inst.repository_selection)}
              onPress={
                inst.installation_url || (canManage && inst.installation_id)
                  ? () => openConnectionActions(inst)
                  : undefined
              }
            />
          ))}
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
