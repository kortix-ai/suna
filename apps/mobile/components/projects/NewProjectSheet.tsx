/**
 * NewProjectSheet — create a project, ported from web's ProjectCreateModal.
 *
 * Two modes (same as web):
 *  - managed: provision a private Kortix-managed repo (name + GKW skills toggle)
 *  - github:  import an existing GitHub repo via the GitHub App installation
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Switch, ActivityIndicator, Linking } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sparkles, Github, Plus, Check, GitBranch, ExternalLink } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useToast } from '@/components/ui/toast-provider';
import {
  useGitHubInstallations,
  useGitHubRepositories,
  useLinkRepository,
  useProvisionProject,
} from '@/lib/projects/hooks';
import type { KortixProject } from '@/lib/projects/projects-client';

interface NewProjectSheetProps {
  open: boolean;
  accountId: string | null;
  onClose: () => void;
  onCreated: (project: KortixProject) => void;
}

export function NewProjectSheet({ open, accountId, onClose, onCreated }: NewProjectSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const toast = useToast();

  const [mode, setMode] = useState<'managed' | 'github'>('managed');
  const [name, setName] = useState('');
  const [includeGKW, setIncludeGKW] = useState(true);
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoSearch, setRepoSearch] = useState('');

  const provision = useProvisionProject();
  const link = useLinkRepository();
  const installationsQuery = useGitHubInstallations(accountId, open && mode === 'github');
  const reposQuery = useGitHubRepositories(accountId, selectedInstallationId || null, open && mode === 'github');

  const installations = useMemo(
    () => installationsQuery.data?.installations ?? [],
    [installationsQuery.data?.installations],
  );
  const repos = reposQuery.data?.repositories ?? [];
  const submitting = provision.isPending || link.isPending;

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const faint = isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const fieldBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';

  useEffect(() => {
    if (open) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [open]);

  // Default to the first installation when entering GitHub mode.
  useEffect(() => {
    if (!open || mode !== 'github') return;
    if (selectedInstallationId && installations.some((i) => i.installation_id === selectedInstallationId)) return;
    setSelectedInstallationId(installations[0]?.installation_id ?? '');
  }, [installations, mode, open, selectedInstallationId]);

  useEffect(() => {
    setSelectedRepo('');
  }, [selectedInstallationId]);

  const reset = useCallback(() => {
    setMode('managed');
    setName('');
    setIncludeGKW(true);
    setSelectedInstallationId('');
    setSelectedRepo('');
    setRepoSearch('');
  }, []);

  const handleDismiss = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const handleCreateManaged = useCallback(async () => {
    if (!accountId) return toast.error('Select an account first');
    const cleaned = name.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();
    if (!cleaned) return toast.error('Project name is required');
    try {
      haptics.medium();
      const project = await provision.mutateAsync({
        account_id: accountId,
        name: cleaned,
        starter_template: includeGKW ? 'general-knowledge-worker' : 'minimal',
      });
      haptics.success();
      toast.success('Project created');
      onCreated(project);
      sheetRef.current?.dismiss();
    } catch (err: any) {
      haptics.warning();
      toast.error(err?.message || 'Failed to create project');
    }
  }, [accountId, name, includeGKW, provision, toast, onCreated]);

  const handleLinkGitHub = useCallback(async () => {
    if (!accountId) return toast.error('Select an account first');
    if (!selectedInstallationId) return toast.error('Select a GitHub account');
    if (!selectedRepo) return toast.error('Select a repository');
    try {
      haptics.medium();
      const result = await link.mutateAsync({
        account_id: accountId,
        installation_id: selectedInstallationId,
        repo_full_name: selectedRepo,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      haptics.success();
      toast.success('Repository linked');
      onCreated(result.project);
      sheetRef.current?.dismiss();
    } catch (err: any) {
      haptics.warning();
      toast.error(err?.message || 'Failed to link repository');
    }
  }, [accountId, selectedInstallationId, selectedRepo, name, link, toast, onCreated]);

  const handleConnectGitHub = useCallback(async () => {
    try {
      const result = await installationsQuery.refetch();
      const url = result.data?.install_url;
      if (!url) {
        toast.error(result.data?.configured === false ? 'GitHub App is not configured' : 'GitHub install URL unavailable');
        return;
      }
      await Linking.openURL(url);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to start GitHub setup');
    }
  }, [installationsQuery, toast]);

  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) =>
      [r.full_name, r.name, r.default_branch, r.description ?? ''].join(' ').toLowerCase().includes(q),
    );
  }, [repos, repoSearch]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={['88%']}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ fontSize: 20, fontFamily: 'Roobert-SemiBold', color: fg, marginBottom: 2 }}>New project</Text>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginBottom: 20, lineHeight: 18 }}>
          A dedicated space for one company, product, or idea — set up for you.
        </Text>

        {mode === 'managed' ? (
          <>
            {/* Managed info */}
            <View style={{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, backgroundColor: fieldBg, marginBottom: 18 }}>
              <Icon as={Sparkles} size={18} color={theme.primary} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Start fresh</Text>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, lineHeight: 18, marginTop: 2 }}>
                  We set up your project with starter skills, ready to use. Nothing to configure.
                </Text>
              </View>
            </View>

            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 8 }}>Project name</Text>
            <BottomSheetTextInput
              value={name}
              onChangeText={setName}
              placeholder="my-agi-company"
              placeholderTextColor={faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                backgroundColor: fieldBg,
                borderWidth: 1,
                borderColor: border,
                borderRadius: 14,
                paddingHorizontal: 16,
                paddingVertical: 14,
                fontSize: 16,
                fontFamily: 'Menlo',
                color: fg,
                marginBottom: 16,
              }}
            />

            {/* GKW skills toggle */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: border, marginBottom: 20 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Starter skills</Text>
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2, lineHeight: 16 }}>
                  Comes with ready-made skills for research, writing, documents, slides, data, and the web.
                </Text>
              </View>
              <Switch
                value={includeGKW}
                onValueChange={setIncludeGKW}
                disabled={submitting}
                trackColor={{ false: border, true: theme.primary }}
                thumbColor="#ffffff"
              />
            </View>

            <Pressable onPress={() => setMode('github')} disabled={submitting} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginBottom: 20 }}>
              <Icon as={Github} size={14} color={muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted }}>Already have code on GitHub? Import it</Text>
            </Pressable>

            <PrimaryButton
              label="Create project"
              icon={<Icon as={Plus} size={18} color={theme.primaryForeground} />}
              loading={provision.isPending}
              disabled={submitting || !accountId}
              onPress={handleCreateManaged}
              theme={theme}
            />
            <Pressable
              onPress={() => sheetRef.current?.dismiss()}
              disabled={submitting}
              style={{ height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 }}
            >
              <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: muted }}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <Text style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }}>Import GitHub repository</Text>
              <Pressable onPress={() => setMode('managed')} disabled={submitting} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon as={GitBranch} size={14} color={muted} />
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted }}>Managed repo</Text>
              </Pressable>
            </View>

            {installationsQuery.isLoading ? (
              <View style={{ paddingVertical: 28, alignItems: 'center' }}>
                <ActivityIndicator color={muted} />
              </View>
            ) : installations.length === 0 ? (
              <View style={{ padding: 16, borderRadius: 14, borderWidth: 1, borderColor: border, alignItems: 'flex-start', gap: 10 }}>
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Connect the Kortix GitHub App</Text>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, lineHeight: 18 }}>
                  Kortix uses the GitHub App to list repositories you can import.
                </Text>
                <Pressable onPress={handleConnectGitHub} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 9999, backgroundColor: theme.primary }}>
                  <Icon as={Github} size={16} color={theme.primaryForeground} />
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Connect</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {/* Installation chips */}
                {installations.length > 1 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                    {installations.map((inst) => {
                      const active = inst.installation_id === selectedInstallationId;
                      return (
                        <Pressable
                          key={inst.installation_id ?? inst.owner_login ?? ''}
                          onPress={() => setSelectedInstallationId(inst.installation_id ?? '')}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1, borderColor: active ? theme.primary : border }}
                        >
                          <Icon as={Github} size={14} color={active ? theme.primary : muted} />
                          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: active ? fg : muted }}>{inst.owner_login}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                {/* Repo search */}
                <BottomSheetTextInput
                  value={repoSearch}
                  onChangeText={setRepoSearch}
                  placeholder="Search repositories"
                  placeholderTextColor={faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ backgroundColor: fieldBg, borderWidth: 1, borderColor: border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: 'Roobert', color: fg, marginBottom: 10 }}
                />

                {reposQuery.isLoading ? (
                  <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator color={muted} />
                  </View>
                ) : filteredRepos.length === 0 ? (
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, textAlign: 'center', paddingVertical: 20 }}>
                    No repositories found
                  </Text>
                ) : (
                  <View style={{ marginBottom: 16 }}>
                    {filteredRepos.map((repo) => {
                      const selected = repo.full_name === selectedRepo;
                      return (
                        <Pressable
                          key={repo.id}
                          onPress={() => setSelectedRepo(repo.full_name)}
                          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: selected ? theme.primary : border, marginBottom: 8 }}
                        >
                          <Icon as={Check} size={16} color={selected ? theme.primary : 'transparent'} style={{ marginRight: 8 }} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text numberOfLines={1} style={{ fontSize: 14, fontFamily: 'Menlo', color: fg }}>{repo.full_name}</Text>
                            <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
                              {repo.default_branch}{repo.private ? ' · Private' : ''}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 8 }}>Project name (optional)</Text>
                <BottomSheetTextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Use repository name"
                  placeholderTextColor={faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ backgroundColor: fieldBg, borderWidth: 1, borderColor: border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: 'Roobert', color: fg, marginBottom: 20 }}
                />

                <PrimaryButton
                  label="Import repo"
                  icon={<Icon as={Github} size={16} color={theme.primaryForeground} />}
                  loading={link.isPending}
                  disabled={submitting || !accountId || !selectedInstallationId || !selectedRepo}
                  onPress={handleLinkGitHub}
                  theme={theme}
                />
                <Pressable
                  onPress={() => sheetRef.current?.dismiss()}
                  disabled={submitting}
                  style={{ height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 }}
                >
                  <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: muted }}>Cancel</Text>
                </Pressable>

                {installationsQuery.data?.install_url ? (
                  <Pressable onPress={handleConnectGitHub} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14 }}>
                    <Icon as={ExternalLink} size={13} color={muted} />
                    <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Add another GitHub account</Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

function PrimaryButton({
  label,
  icon,
  loading,
  disabled,
  onPress,
  theme,
}: {
  label: string;
  icon: React.ReactNode;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
  theme: { primary: string; primaryForeground: string };
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 52,
        borderRadius: 9999,
        backgroundColor: theme.primary,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {loading ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : icon}
      <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{label}</Text>
    </Pressable>
  );
}
