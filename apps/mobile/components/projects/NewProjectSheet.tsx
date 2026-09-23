/**
 * NewProjectSheet — create a project (web's ProjectCreateModal), in the
 * app's sheet shape (Jay, 2026-09-22): `KortixBottomSheetModal`, a
 * `SheetTitleRow`, `SheetTextInput`, `SettingsGroup` picker rows, one `lg`
 * pill. No description lines, no info cards, no Cancel button (the title
 * row's X closes).
 *
 * Three views, one sheet:
 *  - New project (default): the name field, an Account row (only with two or
 *    more accounts the user can create in — web's `AccountPicker` rule), an
 *    "Import from GitHub" row, and Create project. A managed project always
 *    gets the starter skills.
 *  - Account: pushed in; picker rows of the creatable accounts. A tap picks
 *    and returns.
 *  - Import from GitHub: pushed in over the first view (`sheet-push`, the
 *    Secrets sheet's motion), Back in the close button's slot. GitHub
 *    account rows, a repository search, the repository rows, an optional
 *    name, and Import repository. With no GitHub App installation: a
 *    Connect GitHub pill that opens the install page in the browser.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GithubLogoIcon, PlusIcon, UserIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { haptics } from '@/lib/haptics';
import { useToast } from '@/components/kortix/toast-provider';
import { starterTemplateForManagedProject } from './project-starter-template';
import {
  useGitHubInstallations,
  useGitHubRepositories,
  useLinkRepository,
  useProvisionProject,
} from '@/lib/projects/hooks';
import { creatableAccounts } from '@/lib/projects/landing';
import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

// Mirrors the API's PROJECT_NAME_MAX_LENGTH (projects.name is varchar(255)).
const PROJECT_NAME_MAX_LENGTH = 120;

interface NewProjectSheetProps {
  open: boolean;
  /** The account the sheet opens on: the Projects page's active account. */
  accountId: string | null;
  /** Every account of the user. The sheet offers the ones a project can be created in. */
  accounts: KortixAccount[];
  onClose: () => void;
  onCreated: (project: KortixProject) => void;
}

export function NewProjectSheet({ open, accountId: initialAccountId, accounts, onClose, onCreated }: NewProjectSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const [view, setView] = useState<'managed' | 'account' | 'github'>('managed');
  // The first view slides back in only after another view was open.
  const [returning, setReturning] = useState(false);
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoSearch, setRepoSearch] = useState('');

  const creatable = useMemo(() => creatableAccounts(accounts), [accounts]);
  // The pick wins; else the account the sheet opened on, when a project can
  // be created in it; else the first creatable account.
  const accountId =
    pickedAccountId ??
    (creatable.some((a) => a.account_id === initialAccountId) ? initialAccountId : (creatable[0]?.account_id ?? null));
  const account = creatable.find((a) => a.account_id === accountId) ?? null;

  const provision = useProvisionProject();
  const link = useLinkRepository();
  const github = open && view === 'github';
  const installationsQuery = useGitHubInstallations(accountId, github);
  const reposQuery = useGitHubRepositories(accountId, selectedInstallationId || null, github);

  const installations = useMemo(
    () => installationsQuery.data?.installations ?? [],
    [installationsQuery.data?.installations]
  );
  const repos = reposQuery.data?.repositories ?? [];
  const submitting = provision.isPending || link.isPending;

  useEffect(() => {
    if (!open) {
      sheetRef.current?.dismiss();
      return;
    }
    const frame = requestAnimationFrame(() => {
      sheetRef.current?.present();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Default to the first installation when entering the GitHub view.
  useEffect(() => {
    if (!github) return;
    if (selectedInstallationId && installations.some((i) => i.installation_id === selectedInstallationId)) return;
    setSelectedInstallationId(installations[0]?.installation_id ?? '');
  }, [github, installations, selectedInstallationId]);

  useEffect(() => {
    setSelectedRepo('');
  }, [selectedInstallationId]);

  const reset = useCallback(() => {
    setView('managed');
    setReturning(false);
    setPickedAccountId(null);
    setName('');
    setSelectedInstallationId('');
    setSelectedRepo('');
    setRepoSearch('');
  }, []);

  const handleDismiss = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const close = useCallback(() => {
    haptics.tap();
    sheetRef.current?.dismiss();
  }, []);

  const openGitHub = useCallback(() => {
    haptics.tap();
    setView('github');
  }, []);

  const openAccount = useCallback(() => {
    haptics.tap();
    setView('account');
  }, []);

  const back = useCallback(() => {
    haptics.tap();
    setReturning(true);
    setView('managed');
  }, []);

  const handleCreateManaged = useCallback(async () => {
    if (!accountId) return toast.error('Select an account first');
    const cleaned = name.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();
    if (!cleaned) return toast.error('Project name is required');
    if (cleaned.length > PROJECT_NAME_MAX_LENGTH) {
      return toast.error(`Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`);
    }
    try {
      haptics.medium();
      const project = await provision.mutateAsync({
        account_id: accountId,
        name: cleaned,
        starter_template: starterTemplateForManagedProject(),
      });
      haptics.success();
      toast.success('Project created');
      onCreated(project);
      sheetRef.current?.dismiss();
    } catch (err: any) {
      haptics.warning();
      toast.error(err?.message || 'Failed to create project');
    }
  }, [accountId, name, provision, toast, onCreated]);

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
      haptics.tap();
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
      [r.full_name, r.name, r.default_branch, r.description ?? ''].join(' ').toLowerCase().includes(q)
    );
  }, [repos, repoSearch]);

  const canCreate = !submitting && !!accountId && name.trim().length > 0;
  const canImport = !submitting && !!accountId && !!selectedInstallationId && !!selectedRepo;
  const contentStyle = { paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 16 };

  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      snapPoints={['70%']}
      enableDynamicSizing={false}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={handleDismiss}>
      {view === 'account' ? (
        <Animated.View key="account" entering={PUSH_IN} style={{ flex: 1 }}>
          <SheetTitleRow title="Account" onClose={close} leading={<SheetBackButton onPress={back} />} />
          <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
            <SettingsGroup className="bg-secondary">
              {creatable.map((a) => (
                <SettingsRow
                  key={a.account_id}
                  leading={<Avatar variant="custom" size={28} fallbackText={a.name} />}
                  label={a.name}
                  checked={a.account_id === accountId}
                  right={null}
                  onPress={() => {
                    haptics.selection();
                    setPickedAccountId(a.account_id);
                    setReturning(true);
                    setView('managed');
                  }}
                />
              ))}
            </SettingsGroup>
          </BottomSheetScrollView>
        </Animated.View>
      ) : view === 'github' ? (
        <Animated.View key="github" entering={PUSH_IN} style={{ flex: 1 }}>
          <SheetTitleRow title="Import from GitHub" onClose={close} leading={<SheetBackButton onPress={back} />} />
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={contentStyle}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {installationsQuery.isLoading ? (
              <View className="items-center py-8">
                <KortixLoader size="small" />
              </View>
            ) : installations.length === 0 ? (
              <View className="items-center py-8">
                <Text variant="large">Connect GitHub</Text>
                <Button size="lg" className="mt-6 rounded-full" onPress={handleConnectGitHub}>
                  <Text>Connect GitHub</Text>
                </Button>
              </View>
            ) : (
              <>
                <SettingsGroup className="bg-secondary">
                  {installations.map((inst) => (
                    <SettingsRow
                      key={inst.installation_id ?? inst.owner_login ?? ''}
                      icon={GithubLogoIcon}
                      label={inst.owner_login ?? 'GitHub'}
                      checked={inst.installation_id === selectedInstallationId}
                      right={null}
                      onPress={
                        submitting
                          ? undefined
                          : () => {
                              haptics.selection();
                              setSelectedInstallationId(inst.installation_id ?? '');
                            }
                      }
                    />
                  ))}
                  <SettingsRow icon={PlusIcon} label="Add GitHub account" external onPress={handleConnectGitHub} />
                </SettingsGroup>

                <SheetTextInput
                  value={repoSearch}
                  onChangeText={setRepoSearch}
                  placeholder="Search repositories"
                  accessibilityLabel="Search repositories"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />

                {reposQuery.isLoading ? (
                  <View className="items-center py-8">
                    <KortixLoader size="small" />
                  </View>
                ) : filteredRepos.length === 0 ? (
                  <Text variant="muted" className="py-5 text-center">
                    No repositories found
                  </Text>
                ) : (
                  <SettingsGroup className="bg-secondary">
                    {filteredRepos.map((repo) => (
                      <SettingsRow
                        key={repo.id}
                        label={repo.full_name}
                        description={`${repo.default_branch}${repo.private ? ' · Private' : ''}`}
                        checked={repo.full_name === selectedRepo}
                        right={null}
                        onPress={
                          submitting
                            ? undefined
                            : () => {
                                haptics.selection();
                                setSelectedRepo(repo.full_name);
                              }
                        }
                      />
                    ))}
                  </SettingsGroup>
                )}

                <SheetTextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Project name (optional)"
                  accessibilityLabel="Project name"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  editable={!submitting}
                />

                <Button size="lg" className="rounded-full" disabled={!canImport} onPress={handleLinkGitHub}>
                  <Text>{link.isPending ? 'Importing…' : 'Import repository'}</Text>
                </Button>
              </>
            )}
          </BottomSheetScrollView>
        </Animated.View>
      ) : (
        <Animated.View key="managed" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
          <SheetTitleRow title="New project" onClose={close} />
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={contentStyle}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <SheetTextInput
              value={name}
              onChangeText={setName}
              placeholder="Project name"
              accessibilityLabel="Project name"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              maxLength={PROJECT_NAME_MAX_LENGTH}
              returnKeyType="done"
              onSubmitEditing={canCreate ? handleCreateManaged : undefined}
              editable={!submitting}
            />

            <SettingsGroup className="bg-secondary">
              {creatable.length > 1 && (
                <SettingsRow
                  icon={UserIcon}
                  label="Account"
                  value={account?.name ?? ''}
                  onPress={submitting ? undefined : openAccount}
                />
              )}
              <SettingsRow icon={GithubLogoIcon} label="Import from GitHub" onPress={submitting ? undefined : openGitHub} />
            </SettingsGroup>

            <Button size="lg" className="rounded-full" disabled={!canCreate} onPress={handleCreateManaged}>
              <Text>{provision.isPending ? 'Creating…' : 'Create project'}</Text>
            </Button>
          </BottomSheetScrollView>
        </Animated.View>
      )}
    </KortixBottomSheetModal>
  );
}
