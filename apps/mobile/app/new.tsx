/**
 * New project — `/new`, the full-screen create for a user with no project in
 * any account (COR-161): after the upgrade screen on the first run, and on
 * every start while no account has a project (`app/index.tsx`,
 * `startDestination`). The switcher's `+` keeps the sheet (`NewProjectSheet`).
 *
 * Top to bottom: "What should Kortix work on?" (`h3`), the project name
 * (`PillInput`), three starter prompts (`PROJECT_STARTERS`: a pick names the
 * project and becomes the first message's draft), the Account group (only
 * with two or more accounts the user owns or administers —
 * `showAccountPicker`, web's `AccountPicker` rule), Import from GitHub (the
 * sheet's GitHub view, `NewProjectSheet initialView="github"`), and one
 * "Create project" pill at the bottom.
 *
 * Created → the project's home, composer focused (`markComposerFocus`), with
 * the starter prompt as its draft (`project:<id>` in the composer draft
 * store). Nothing sits under this screen, so Sign out (header) is the way out.
 * A user who can create in no account sees why, and Sign out.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PillInput } from '@/components/kortix/pill-input';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
import { useCreateManagedProject } from '@/components/projects/useCreateManagedProject';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import {
  ChartBarIcon,
  GithubLogoIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
} from '@/lib/icons';
import { markComposerFocus } from '@/lib/onboarding/composer-handoff';
import { useAccounts } from '@/lib/projects/hooks';
import { creatableAccounts } from '@/lib/projects/landing';
import {
  nameAfterStarterPick,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_STARTERS,
  resolveCreateAccountId,
  showAccountPicker,
  type ProjectStarter,
} from '@/lib/projects/new-project-form';
import type { KortixProject } from '@/lib/projects/projects-client';
import { projectHref } from '@/lib/projects/switcher';
import { draftKey } from '@/lib/session/composer-draft';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';

const STARTER_ICONS: Record<ProjectStarter['id'], typeof GlobeIcon> = {
  research: MagnifyingGlassIcon,
  website: GlobeIcon,
  analysis: ChartBarIcon,
};

export default function NewProjectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuthContext();
  const accountsQuery = useAccounts(!!user);
  const accounts = React.useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  const [name, setName] = React.useState('');
  const [starter, setStarter] = React.useState<ProjectStarter | null>(null);
  const [pickedAccountId, setPickedAccountId] = React.useState<string | null>(null);
  const [githubOpen, setGithubOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  const creatable = React.useMemo(() => creatableAccounts(accounts), [accounts]);
  const accountId = resolveCreateAccountId({ accounts, picked: pickedAccountId, preferred: selectedAccountId });
  const { create, isPending } = useCreateManagedProject();

  const openProject = React.useCallback(
    (project: KortixProject, prompt: string | null) => {
      if (project.account_id) setSelectedAccountId(project.account_id);
      if (prompt) {
        useComposerDraftStore.getState().write(draftKey({ kind: 'project', projectId: project.project_id }), prompt);
      }
      markComposerFocus(project.project_id);
      router.replace(projectHref(project.project_id));
    },
    [router, setSelectedAccountId]
  );

  const handleCreate = React.useCallback(async () => {
    if (isPending) return;
    const project = await create(accountId, name);
    if (project) openProject(project, starter?.prompt ?? null);
  }, [isPending, create, accountId, name, openProject, starter]);

  const pickStarter = React.useCallback(
    (next: ProjectStarter) => {
      haptics.selection();
      const picked = starter?.id === next.id ? null : next;
      setStarter(picked);
      setName((current) => nameAfterStarterPick(current, picked));
    },
    [starter]
  );

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    haptics.tap();
    setSigningOut(true);
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    if (result?.success) router.replace('/auth');
  }, [router, signOut, signingOut]);

  const canCreate = !isPending && !!accountId && name.trim().length > 0;

  let body: React.ReactNode;
  if (accountsQuery.isLoading) {
    body = (
      <View className="flex-1 items-center justify-center">
        <KortixLoader size="large" />
      </View>
    );
  } else if (accountsQuery.isError) {
    body = (
      <View className="flex-1 items-center justify-center gap-4">
        <Text variant="muted">Couldn't load your accounts</Text>
        <Button variant="secondary" size="lg" className="rounded-full" onPress={() => accountsQuery.refetch()}>
          <Text>Try again</Text>
        </Button>
      </View>
    );
  } else if (creatable.length === 0) {
    body = (
      <View className="flex-1 justify-center">
        <Text variant="h3">What should Kortix work on?</Text>
        <Text variant="muted" className="mt-2">
          Only an account owner or admin can create a project. Ask one to make you an admin.
        </Text>
      </View>
    );
  } else {
    body = (
      <>
        <View className="gap-4">
          <Text variant="h3">What should Kortix work on?</Text>

          <PillInput
            value={name}
            onChangeText={setName}
            placeholder="Project name"
            accessibilityLabel="Project name"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            returnKeyType="done"
            onSubmitEditing={canCreate ? handleCreate : undefined}
            editable={!isPending}
          />

          <SettingsGroup title="Start with">
            {PROJECT_STARTERS.map((s) => (
              <SettingsRow
                key={s.id}
                icon={STARTER_ICONS[s.id]}
                label={s.label}
                checked={starter?.id === s.id}
                right={null}
                onPress={isPending ? undefined : () => pickStarter(s)}
              />
            ))}
          </SettingsGroup>

          {showAccountPicker(accounts) ? (
            <SettingsGroup title="Account">
              {creatable.map((a) => (
                <SettingsRow
                  key={a.account_id}
                  leading={<Avatar chalk size={28} fallbackText={a.name} />}
                  label={a.name}
                  checked={a.account_id === accountId}
                  right={null}
                  onPress={
                    isPending
                      ? undefined
                      : () => {
                          haptics.selection();
                          setPickedAccountId(a.account_id);
                        }
                  }
                />
              ))}
            </SettingsGroup>
          ) : null}

          <SettingsGroup>
            <SettingsRow
              icon={GithubLogoIcon}
              label="Import from GitHub"
              onPress={
                isPending
                  ? undefined
                  : () => {
                      haptics.tap();
                      setGithubOpen(true);
                    }
              }
            />
          </SettingsGroup>
        </View>

        <View className="flex-1" />
        <Button size="lg" className="mt-8 rounded-full" disabled={!canCreate} onPress={handleCreate}>
          <Text>{isPending ? 'Creating…' : 'Create project'}</Text>
        </Button>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        <View className="flex-row justify-end px-4 pb-2" style={{ paddingTop: insets.top + 8 }}>
          <Button variant="ghost" size="sm" disabled={signingOut} onPress={handleSignOut}>
            <Text>Sign out</Text>
          </Button>
        </View>

        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            // flexGrow lets the spacer pin Create project to the bottom.
            flexGrow: 1,
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: insets.bottom + 16,
          }}>
          {body}
        </KeyboardAwareScrollView>
      </View>

      {githubOpen ? (
        <NewProjectSheet
          open
          initialView="github"
          accountId={accountId}
          accounts={accounts}
          onClose={() => setGithubOpen(false)}
          onCreated={(project) => {
            setGithubOpen(false);
            openProject(project, null);
          }}
        />
      ) : null}
    </>
  );
}
