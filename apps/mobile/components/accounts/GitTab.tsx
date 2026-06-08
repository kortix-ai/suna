/**
 * Account → Git (web parity: GitHubConnectionCard). List connected GitHub App
 * installations, connect a new one (opens the install URL), configure, and
 * disconnect.
 */

import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Github, ExternalLink, Unplug, Shield } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { listGitHubInstallations, deleteGitHubInstallation } from '@/lib/projects/projects-client';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import { accountColors, Card, SkeletonRow, type AccountCaps } from './account-shared';

function permissionLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return `Contents ${value}`;
}

export function GitTab({ account, can, isDark }: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
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
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to disconnect GitHub.'),
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
        Alert.alert('Unavailable', res.data?.configured === false ? 'The GitHub App is not configured.' : 'GitHub install URL unavailable.');
        return;
      }
      await Linking.openURL(installUrl);
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Failed to start GitHub setup.');
    } finally {
      setConnecting(false);
    }
  };

  const confirmDisconnect = (installationId: string, owner: string | null) => {
    Alert.alert('Disconnect GitHub', `New imports from ${owner ?? 'this GitHub account'} will stop working until it's connected again. Existing projects keep their repository link.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => { haptics.medium(); disconnect.mutate(installationId); } },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 14 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={installationsQuery.isRefetching} onRefresh={() => installationsQuery.refetch()} tintColor={c.muted} />}
    >
      <Card
        title="Git connections"
        count={installations.length}
        description="Connect one or more GitHub users or organizations to import repositories."
        isDark={isDark}
        action={canManage ? (
          <TouchableOpacity onPress={handleConnect} disabled={connecting} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 11, paddingRight: 13, height: 34, borderRadius: 9999, backgroundColor: theme.primary }}>
            {connecting ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <Github size={14} color={theme.primaryForeground} />}
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{connecting ? 'Connecting' : 'Connect'}</Text>
          </TouchableOpacity>
        ) : undefined}
      >
        <View style={{ marginTop: 14 }}>
          {installationsQuery.isLoading ? (
            <View><SkeletonRow isDark={isDark} /><SkeletonRow isDark={isDark} /></View>
          ) : installationsQuery.isError ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 11, backgroundColor: 'rgba(217,119,6,0.08)' }}>
              <Github size={15} color="#d97706" />
              <Text style={{ flex: 1, fontSize: 12.5, color: '#d97706' }}>GitHub status unavailable: {(installationsQuery.error as Error)?.message}</Text>
            </View>
          ) : installations.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 28, gap: 12 }}>
              <Github size={26} color={c.muted} />
              <Text style={{ fontSize: 13.5, color: c.muted, textAlign: 'center' }}>No GitHub connections. Connect the Kortix GitHub App to import repositories.</Text>
            </View>
          ) : (
            <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
              {installations.map((inst, i) => {
                const contents = permissionLabel(inst.permissions?.contents);
                const repoSel = inst.repository_selection === 'selected' ? 'Selected repositories' : inst.repository_selection === 'all' ? 'All repositories' : null;
                const id = inst.installation_id ?? '';
                const meta = [inst.owner_type, repoSel, contents].filter(Boolean).join(' · ');
                return (
                  <View key={id || inst.owner_login || 'gh'} style={{ padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}>
                        <Github size={18} color={c.fg} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{inst.owner_login ?? 'GitHub App'}</Text>
                          <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(34,197,94,0.12)' }}>
                            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: '#16a34a' }}>Connected</Text>
                          </View>
                        </View>
                        {!!meta && <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }} numberOfLines={1}>{meta}</Text>}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      {inst.installation_url && (
                        <TouchableOpacity onPress={() => { haptics.tap(); Linking.openURL(inst.installation_url!); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
                          <ExternalLink size={13} color={c.muted} />
                          <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Configure</Text>
                        </TouchableOpacity>
                      )}
                      {canManage && id && (
                        <TouchableOpacity onPress={() => confirmDisconnect(id, inst.owner_login)} disabled={disconnect.isPending} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)' }}>
                          {disconnect.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Unplug size={13} color="#ef4444" />}
                          <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Disconnect</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.cardBg, borderWidth: 1, borderColor: c.border }}>
        <Shield size={15} color={c.muted} style={{ marginTop: 1 }} />
        <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: c.muted }}>
          Kortix stores the GitHub App installation on the account. It's a platform credential — individual projects link to repos through it.
        </Text>
      </View>
    </ScrollView>
  );
}
