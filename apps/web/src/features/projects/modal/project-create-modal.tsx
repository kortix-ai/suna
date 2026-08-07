'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { Github as GithubIcon } from '@/features/icon/icons/github';
import { Plus } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useDebounce } from '@/hooks/use-debounce';
import { githubInstallationLabel, isGitHubAppInstallationId } from '@/lib/github-installations';
import {
  getMarketplaceItem,
  listMarketplaceItems,
  type MarketplaceItem,
} from '@/lib/marketplace-client';
import {
  isManagedGitUnavailableError,
  isProjectLimitError,
} from '@/lib/onboarding/ensure-first-project';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  createProjectRepo,
  getManagedGitStatus,
  linkRepository,
  listAccounts,
  listGitHubInstallations,
  listGitHubRepositories,
  listProjectsForAccount,
  provisionProject,
  type KortixAccount,
  type KortixProject,
} from '@kortix/sdk';
import {
  CubeIcon as Boxes,
  CheckCircleIcon as CheckCircleSolid,
  CaretUpDownIcon as ChevronsUpDown,
  ArrowSquareOutIcon as ExternalLink,
  GithubLogoIcon as Github,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { resolveCreateAccountSelection } from './create-account-selection';
import { RepositoryPicker } from './github-import-pickers';
import { GitHubSetupRequiredPanel, isAccountGitAdmin } from './github-setup-required-panel';
import { ProjectIconField, type ProjectIconValue } from './project-icon-field';
import { startProjectOnboardingSession, startTemplateSetupSession } from './template-setup-session';

const sanitizeProjectName = (value: string) => value.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();

// Mirrors the API's PROJECT_NAME_MAX_LENGTH (projects.name is varchar(255);
// pasted prompts used to sail past the charset regex and 500 on the insert).
const PROJECT_NAME_MAX_LENGTH = 120;

const managedProjectSchema = z.object({
  name: z
    .string()
    .transform(sanitizeProjectName)
    .pipe(
      z
        .string()
        .min(1, 'Project name is required')
        .max(
          PROJECT_NAME_MAX_LENGTH,
          `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
        ),
    ),
});

const githubLinkSchema = z.object({
  installationId: z.string().min(1, 'Select a GitHub account'),
  repo: z.string().trim().min(1, 'Select a GitHub repository'),
  name: z.string(),
});

type ManagedProjectFormValues = z.infer<typeof managedProjectSchema>;
type GitHubLinkFormValues = z.infer<typeof githubLinkSchema>;
type RepositoryMode = 'github-create' | 'github-import' | 'managed';

const REPOSITORY_MODE_DESCRIPTIONS: Record<RepositoryMode, string> = {
  managed: 'Kortix creates and manages a private repository for this project.',
  'github-create': 'Kortix creates a private repository in your GitHub account.',
  'github-import': 'Select an existing repository from your GitHub account.',
};

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  /** Clone a `registry:project` marketplace item instead of the blank
   *  starter — set from the removed projects-index `clone=<item-id>` query
   *  param (marketplace "Clone"), now `/new?clone=<item-id>`. */
  sourceItemId?: string | null;
}

function rememberGitHubSetupReturn(path: string) {
  try {
    window.localStorage.setItem('kortix:github_setup_return', path);
  } catch {
    // Non-critical: the setup page still falls back to the projects flow.
  }
}

function upsertProject(projects: KortixProject[] | undefined, project: KortixProject) {
  const current = projects ?? [];
  const existingIndex = current.findIndex((item) => item.project_id === project.project_id);
  if (existingIndex === -1) return [project, ...current];

  const next = [...current];
  next[existingIndex] = project;
  return next;
}

export const ProjectCreateModal = ({
  open,
  onOpenChange,
  accountId,
  sourceItemId,
}: ProjectCreateModalProps) => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'github-create' | 'github-import' | 'managed' | 'template'>(
    'managed',
  );
  // Repository source (Kortix managed / create in GitHub / import from
  // GitHub) is an opt-in disclosure — collapsed by default so the modal's
  // default state is just a name field. Forced open below once the user has
  // actually picked a non-managed mode, or managed git isn't usable, so the
  // switcher stays reachable.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [sourceNameApplied, setSourceNameApplied] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState('');
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  // Cloning a project template comes from two places: the marketplace's
  // "Clone" button (external `?clone=` → `sourceItemId` prop) or picking one
  // right here via "Clone from a template" (`pickedTemplateId`). Once either
  // is set, the rest of the managed form behaves identically either way.
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);
  // The project's icon, owned here rather than by `ProjectIconField`. The
  // field renders in whichever mode's form is mounted and never clears itself,
  // so the modal is the one place that can both send the value with the create
  // payload and drop it on close. `null` means "no icon picked" — the field
  // shows its neutral face and the payloads omit both keys entirely.
  //
  // `ProjectIconValue` — the field's own union type — not two nullable slots:
  // an emoji and a glyph can never both be set here, so `iconPayload` below
  // can never spread both `icon` and `icon_glyph` into one request body.
  const [icon, setIcon] = useState<ProjectIconValue>(null);
  const effectiveSourceItemId = sourceItemId ?? pickedTemplateId;
  const cloningFromSource = !!effectiveSourceItemId;

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
    enabled: open,
  });

  // Pre-check whether managed git (the "Create project" quick path, backed by
  // POST /projects/provision) is usable BEFORE the user hits its 503 —
  // self-host with no MANAGED_GIT_* configured is the primary case. Only
  // gates 'managed'/'template' modes; the BYO GitHub import ('github' mode)
  // doesn't depend on it. `configured` defaults true while loading so the
  // form isn't disabled by a flash of "unavailable".
  const managedGitStatusQuery = useQuery({
    queryKey: ['managed-git-status'],
    queryFn: getManagedGitStatus,
    staleTime: 10_000,
    enabled: open,
  });
  const managedGitUnavailable = managedGitStatusQuery.data?.configured === false;
  const accountSelection = useMemo(
    () => resolveCreateAccountSelection(accountsQuery.data, accountId, pickedAccountId),
    [accountsQuery.data, accountId, pickedAccountId],
  );
  const effectiveAccountId = accountSelection.effectiveAccountId;
  const isGitAdmin = isAccountGitAdmin(accountSelection.currentAccount?.account_role);

  const managedForm = useForm<ManagedProjectFormValues>({
    resolver: zodResolver(managedProjectSchema),
    defaultValues: {
      name: '',
    },
  });

  const githubForm = useForm<GitHubLinkFormValues>({
    resolver: zodResolver(githubLinkSchema),
    defaultValues: {
      installationId: '',
      repo: '',
      name: '',
    },
  });

  const selectedInstallationId = githubForm.watch('installationId');
  const selectedRepo = githubForm.watch('repo');
  const { debouncedValue: debouncedRepositorySearch, isLoading: isDebouncingRepositorySearch } =
    useDebounce(repositorySearch.trim(), 300);

  function resetAndClose() {
    setMode('managed');
    setAdvancedOpen(false);
    setSourceNameApplied(false);
    setPickedAccountId(null);
    setPickedTemplateId(null);
    setIcon(null);
    setRepositorySearch('');
    managedForm.reset();
    githubForm.reset();
    onOpenChange(false);
  }

  function switchToGitHubMode() {
    setMode('github-import');
  }

  function switchToManagedMode() {
    const importedName = githubForm.getValues('name').trim();
    if (importedName) managedForm.setValue('name', importedName);
    setMode('managed');
  }

  function switchToGitHubCreateMode() {
    setMode('github-create');
  }

  function switchRepositoryMode(nextMode: string) {
    if (nextMode === 'managed') return switchToManagedMode();
    if (nextMode === 'github-create') return switchToGitHubCreateMode();
    if (nextMode === 'github-import') return switchToGitHubMode();
  }

  function switchToTemplateMode() {
    setMode('template');
  }

  function pickTemplate(itemId: string) {
    setSourceNameApplied(false);
    setPickedTemplateId(itemId);
    setMode('managed');
  }

  function clearPickedTemplate() {
    setPickedTemplateId(null);
    setSourceNameApplied(false);
    managedForm.setValue('name', '');
  }

  async function finishCreatedProject(project: KortixProject) {
    successToast('Project created');
    queryClient.setQueryData<KortixProject[]>(['projects', project.account_id], (projects) =>
      upsertProject(projects, project),
    );
    queryClient.setQueryData<KortixProject[]>(['projects'], (projects) =>
      upsertProject(projects, project),
    );
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.refetchQueries({ queryKey: ['projects'], type: 'active' });

    if (effectiveSourceItemId) {
      const sessionId = await startTemplateSetupSession(project, {
        itemId: effectiveSourceItemId,
        title: sourceItemQuery.data?.title ?? 'this project',
      });
      if (sessionId) {
        resetAndClose();
        router.replace(`/projects/${project.project_id}/sessions/${sessionId}`);
        return;
      }
    }

    const onboardingSessionId = await startProjectOnboardingSession(project);
    if (onboardingSessionId) {
      resetAndClose();
      router.replace(`/projects/${project.project_id}/sessions/${onboardingSessionId}`);
      return;
    }

    resetAndClose();
    router.replace(`/projects/${project.project_id}`);
  }

  const createMutation = useMutation({
    // Wrapped rather than passed by reference: react-query now hands the
    // mutationFn a context object as its 2nd arg, which collides with
    // `provisionProject(input, options?: ApiClientOptions)`. Pre-existing on
    // main after the react-query bump; fixed here because it blocks typecheck.
    mutationFn: (input: Parameters<typeof provisionProject>[0]) => provisionProject(input),
    onSuccess: finishCreatedProject,
    onError: async (error: Error) => {
      if (effectiveAccountId && isProjectLimitError(error)) {
        try {
          const existing = await listProjectsForAccount(effectiveAccountId);
          const project = existing[0];
          if (project) {
            resetAndClose();
            router.replace(`/projects/${project.project_id}`);
            return;
          }
        } catch {
          // Fall through to the generic toast below.
        }
      }
      if (isManagedGitUnavailableError(error)) {
        const gitSettingsAccountId =
          effectiveAccountId ?? useCurrentAccountStore.getState().selectedAccountId;
        errorToast("Managed git isn't set up on this server", {
          description:
            'An admin needs to connect GitHub in Git settings before projects can be created.',
          ...(gitSettingsAccountId
            ? {
                button: (
                  <Button
                    size="sm"
                    onClick={() => {
                      resetAndClose();
                      router.push(`/accounts/${gitSettingsAccountId}?tab=git`);
                    }}
                  >
                    Open Git settings
                  </Button>
                ),
              }
            : {}),
        });
        return;
      }
      errorToast(error.message || 'Failed to create project');
    },
  });

  const githubCreateMutation = useMutation({
    mutationFn: createProjectRepo,
    onSuccess: finishCreatedProject,
    onError: (error: Error) => errorToast(error.message || 'Failed to create GitHub repository'),
  });

  const githubInstallationsQuery = useQuery({
    queryKey: ['github-installations', effectiveAccountId],
    queryFn: () => listGitHubInstallations(effectiveAccountId!),
    enabled: open && (mode === 'github-create' || mode === 'github-import') && !!effectiveAccountId,
    staleTime: 0,
  });

  const sourceItemQuery = useQuery({
    queryKey: ['marketplace-item', effectiveSourceItemId],
    queryFn: () => getMarketplaceItem(effectiveSourceItemId!),
    enabled: open && cloningFromSource,
    staleTime: 60_000,
  });

  const templatesQuery = useQuery({
    queryKey: ['marketplace-project-templates'],
    queryFn: () => listMarketplaceItems({ type: 'project' }),
    enabled: open && mode === 'template',
    staleTime: 60_000,
  });
  const templates = templatesQuery.data?.items ?? [];

  useEffect(() => {
    if (!open || !cloningFromSource || sourceNameApplied || !sourceItemQuery.data) return;
    managedForm.setValue('name', sourceItemQuery.data.title.replaceAll('-', ' '), {
      shouldDirty: false,
      shouldTouch: false,
      shouldValidate: false,
    });
    setSourceNameApplied(true);
  }, [managedForm, cloningFromSource, open, sourceItemQuery.data, sourceNameApplied]);

  const githubInstallations = useMemo(
    () => githubInstallationsQuery.data?.installations ?? [],
    [githubInstallationsQuery.data?.installations],
  );
  const githubAppInstallations = useMemo(
    () =>
      githubInstallations.filter((installation) =>
        isGitHubAppInstallationId(installation.installation_id),
      ),
    [githubInstallations],
  );
  const selectableInstallations =
    mode === 'github-create' ? githubAppInstallations : githubInstallations;
  const selectedInstallation =
    selectableInstallations.find(
      (installation) => installation.installation_id === selectedInstallationId,
    ) ?? null;

  const githubReposQuery = useQuery({
    queryKey: [
      'github-repositories',
      effectiveAccountId,
      selectedInstallationId,
      debouncedRepositorySearch,
    ],
    queryFn: () =>
      listGitHubRepositories(effectiveAccountId!, selectedInstallationId, {
        search: debouncedRepositorySearch || undefined,
        limit: 100,
      }),
    enabled: open && mode === 'github-import' && !!effectiveAccountId && !!selectedInstallationId,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open || (mode !== 'github-create' && mode !== 'github-import')) return;
    if (
      selectedInstallationId &&
      selectableInstallations.some(
        (installation) => installation.installation_id === selectedInstallationId,
      )
    ) {
      return;
    }
    const first = selectableInstallations[0]?.installation_id;
    githubForm.setValue('installationId', first ?? '');
  }, [githubForm, mode, open, selectableInstallations, selectedInstallationId]);

  useEffect(() => {
    setRepositorySearch('');
    githubForm.setValue('repo', '');
    if (mode === 'github-import') githubForm.setValue('name', '');
  }, [githubForm, mode, selectedInstallationId]);

  const linkMutation = useMutation({
    mutationFn: linkRepository,
    onSuccess: (result) => {
      successToast('Repository linked');
      queryClient.setQueryData<KortixProject[]>(
        ['projects', result.project.account_id],
        (projects) => upsertProject(projects, result.project),
      );
      queryClient.setQueryData<KortixProject[]>(['projects'], (projects) =>
        upsertProject(projects, result.project),
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.refetchQueries({
        queryKey: ['projects'],
        type: 'active',
      });
      resetAndClose();
      router.replace(`/projects/${result.project.project_id}`);
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to link repository');
    },
  });

  // Spread, not `icon: icon ?? undefined`: the key is absent from the JSON
  // entirely when nothing is picked, so the server's create paths keep their
  // own "no icon" default instead of receiving an explicit null to interpret.
  // Which key — `icon` or `icon_glyph` — comes straight from which side of
  // the union `icon` holds, so this client can never send both.
  const iconPayload = !icon
    ? {}
    : 'emoji' in icon
      ? { icon: icon.emoji }
      : { icon_glyph: icon.glyph };

  function handleCreate(values: ManagedProjectFormValues) {
    if (!effectiveAccountId) return errorToast('Select an account first');
    if (mode === 'github-create') {
      if (!selectedInstallationId) return errorToast('Connect a GitHub account first');
      githubCreateMutation.mutate({
        account_id: effectiveAccountId,
        installation_id: selectedInstallationId,
        name: values.name.trim().replace(/\s+/g, '-'),
        private: true,
        starter_template: 'general-knowledge-worker',
        source_item_id: effectiveSourceItemId ?? undefined,
        ...iconPayload,
      });
      return;
    }
    if (cloningFromSource && effectiveSourceItemId) {
      createMutation.mutate({
        account_id: effectiveAccountId,
        name: values.name,
        source_item_id: effectiveSourceItemId,
        ...iconPayload,
      });
      return;
    }
    createMutation.mutate({
      account_id: effectiveAccountId,
      name: values.name,
      starter_template: 'general-knowledge-worker',
      marketplace_items: [],
      ...iconPayload,
    });
  }

  function handleLinkGitHub(values: GitHubLinkFormValues) {
    if (!effectiveAccountId) return errorToast('Select an account first');
    const trimmedName = values.name.trim();
    linkMutation.mutate({
      account_id: effectiveAccountId,
      installation_id: values.installationId,
      repo_full_name: values.repo,
      ...(trimmedName ? { name: trimmedName } : {}),
      ...iconPayload,
    });
  }

  function handleConnectGitHub() {
    if (!effectiveAccountId) {
      errorToast('Select an account first');
      return;
    }

    setIsConnectingGitHub(true);
    rememberGitHubSetupReturn('/new');
    router.push(`/github/setup?account_id=${encodeURIComponent(effectiveAccountId)}`);
  }

  const submitting =
    createMutation.isPending || githubCreateMutation.isPending || linkMutation.isPending;
  const repos =
    githubReposQuery.data?.installation_id === selectedInstallationId
      ? githubReposQuery.data.repositories
      : [];
  const selectedRepository = repos.find((repo) => repo.full_name === selectedRepo);
  const repositoryLoading = githubReposQuery.isFetching || isDebouncingRepositorySearch;
  const repositoryMode: RepositoryMode = mode === 'template' ? 'managed' : mode;
  // Stay open once the user has left the silent "Kortix managed" default —
  // either by picking another source, or because managed git needs a fix —
  // so the switcher that got them there doesn't disappear underneath them.
  const repositoryOptionsOpen = advancedOpen || mode !== 'managed' || managedGitUnavailable;
  // Only the true silent default (managed mode, managed git actually usable)
  // is a real toggle. Everywhere else `repositoryOptionsOpen` above is
  // pinned true for a reason the user can't undo from here — showing a
  // "Hide" trigger in that state would promise a collapse that can't happen.
  const repositoryOptionsCollapsible = mode === 'managed' && !managedGitUnavailable;

  return (
    <Modal open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <ModalContent className={cn('space-y-6 lg:max-w-lg')}>
        <ModalHeader>
          <ModalTitle>
            {tHardcodedUi.raw('componentsProjectsProjectCreateModal.line237JsxTextNewProject')}
          </ModalTitle>
          {/* <ModalDescription>
            {tHardcodedUi.raw(
              'componentsProjectsProjectCreateModal.line240JsxTextStartWithAPrivateManagedRepoExistingGithub',
            )}
          </ModalDescription> */}
        </ModalHeader>

        {accountSelection.canSwitch && accountSelection.currentAccount ? (
          <CreateAccountField
            current={accountSelection.currentAccount}
            options={accountSelection.options}
            disabled={submitting}
            onSelect={setPickedAccountId}
          />
        ) : null}

        {mode === 'managed' && managedGitUnavailable ? (
          <>
            <ModalBody>
              <div className="space-y-4">
                {/* Tabs are pinned open here (managed git is broken), so they
                    already offer "Import from GitHub" — no separate
                    secondaryAction button needed unless the source-tabs
                    themselves are hidden (cloning a template). */}
                {!cloningFromSource ? (
                  <RepositoryOptions
                    repositoryMode={repositoryMode}
                    repositoryOptionsOpen={repositoryOptionsOpen}
                    collapsible={repositoryOptionsCollapsible}
                    onOpenChange={setAdvancedOpen}
                    onModeChange={switchRepositoryMode}
                    submitting={submitting}
                  />
                ) : null}
                <GitHubSetupRequiredPanel
                  accountId={effectiveAccountId}
                  isAdmin={isGitAdmin}
                  onNavigate={resetAndClose}
                  // Tabs (or the cloning card) already sit directly above via
                  // the shared `space-y-4` — drop EmptyState's own generous
                  // top padding (both breakpoints — the base p-6 and the
                  // md:p-12 override) so the two don't compound into a dead gap.
                  className="pt-0 md:pt-0"
                  secondaryAction={
                    cloningFromSource ? (
                      <Button type="button" variant="ghost" size="sm" onClick={switchToGitHubMode}>
                        Import an existing repo
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                type="button"
                variant="outline-ghost"
                className="w-full sm:w-auto"
                onClick={resetAndClose}
              >
                Cancel
              </Button>
            </ModalFooter>
          </>
        ) : mode === 'template' ? (
          <TemplatePicker
            templates={templates}
            loading={templatesQuery.isLoading}
            onPick={pickTemplate}
            onCancel={switchToManagedMode}
          />
        ) : mode === 'managed' || mode === 'github-create' ? (
          <Form {...managedForm}>
            <form onSubmit={managedForm.handleSubmit(handleCreate)} className="w-full">
              <ModalBody>
                <div className="space-y-5">
                  <FormField
                    control={managedForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {tHardcodedUi.raw(
                            'componentsProjectsProjectCreateModal.line258JsxTextProjectName',
                          )}
                        </FormLabel>
                        {/* The icon trigger is a peer of the name input, not a
                            field of its own: one row, one label, one thing the
                            user is naming. `items-start` keeps the two aligned
                            at the top of the row — both are 9 units tall today,
                            so it reads the same as centring, and it stays
                            correct if the input ever grows. */}
                        <div className="flex items-start gap-2">
                          <ProjectIconField
                            value={icon}
                            onChange={(emoji) => setIcon({ emoji })}
                            onGlyphChange={(glyph) => setIcon({ glyph })}
                            disabled={submitting}
                          />
                          <div className="min-w-0 flex-1">
                            <FormControl>
                              <Input
                                placeholder="my-agi-company"
                                autoCapitalize="none"
                                autoCorrect="off"
                                autoFocus
                                maxLength={PROJECT_NAME_MAX_LENGTH}
                                {...field}
                              />
                            </FormControl>
                          </div>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {mode === 'github-create' ? (
                    githubInstallationsQuery.isLoading ? (
                      <div className="text-muted-foreground flex h-20 items-center justify-center gap-2 text-sm">
                        <Loading /> Loading GitHub connections
                      </div>
                    ) : githubAppInstallations.length === 0 ? (
                      githubInstallationsQuery.data?.configured === false ? (
                        <GitHubSetupRequiredPanel
                          accountId={effectiveAccountId}
                          isAdmin={isGitAdmin}
                          onNavigate={resetAndClose}
                          size="sm"
                        />
                      ) : (
                        <Item variant="outline" className="items-start">
                          <ItemMedia variant="icon" className="rounded-full bg-transparent">
                            <GithubIcon />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle>Connect GitHub to create projects</ItemTitle>
                            <ItemDescription>
                              Install the Kortix GitHub App in your user account or organization.
                              Kortix creates a private repository there.
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <Button
                              type="button"
                              size="sm"
                              disabled={isConnectingGitHub}
                              onClick={handleConnectGitHub}
                            >
                              {isConnectingGitHub ? <Loading /> : <GithubIcon />}
                              {isConnectingGitHub ? 'Connecting' : 'Connect'}
                            </Button>
                          </ItemActions>
                        </Item>
                      )
                    ) : (
                      <div className="space-y-1.5">
                        <Label>Repository owner</Label>
                        <Select
                          value={selectedInstallationId}
                          onValueChange={(value) => githubForm.setValue('installationId', value)}
                          disabled={submitting || githubAppInstallations.length < 2}
                        >
                          <SelectTrigger className="w-full">
                            <span className="flex min-w-0 items-center gap-2">
                              <GithubIcon className="size-4" />
                              <span className="truncate">
                                github.com/{selectedInstallation?.owner_login}
                              </span>
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            {githubAppInstallations.map((installation) =>
                              installation.installation_id ? (
                                <SelectItem
                                  key={installation.installation_id}
                                  value={installation.installation_id}
                                >
                                  {installation.owner_login}
                                </SelectItem>
                              ) : null,
                            )}
                          </SelectContent>
                        </Select>
                        <p className="text-muted-foreground text-xs">
                          A private repository is created in this GitHub account and connected
                          through the App.
                        </p>
                      </div>
                    )
                  ) : null}

                  {cloningFromSource ? (
                    <div className="divide-border/60 divide-y overflow-hidden rounded-md border">
                      <div className="flex items-start gap-3 px-3.5 py-3">
                        <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-sm">
                          <Boxes className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground text-sm font-medium">
                            Cloning {sourceItemQuery.data?.title.replaceAll('-', ' ') ?? 'project'}
                          </div>
                          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                            {sourceItemQuery.data?.description ??
                              'Your new project starts with everything this project ships.'}
                          </p>
                        </div>
                        {pickedTemplateId && !sourceItemId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            disabled={submitting}
                            onClick={clearPickedTemplate}
                          >
                            Change
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {!cloningFromSource ? (
                    <RepositoryOptions
                      repositoryMode={repositoryMode}
                      repositoryOptionsOpen={repositoryOptionsOpen}
                      collapsible={repositoryOptionsCollapsible}
                      onOpenChange={setAdvancedOpen}
                      onModeChange={switchRepositoryMode}
                      onCloneTemplate={mode === 'managed' ? switchToTemplateMode : undefined}
                      submitting={submitting}
                    />
                  ) : null}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button
                  type="button"
                  variant="outline-ghost"
                  className="w-full sm:w-auto"
                  disabled={submitting}
                  onClick={resetAndClose}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={
                    submitting ||
                    !effectiveAccountId ||
                    // `watch` rather than a read off getValues: it subscribes
                    // this render to the field, so the button enables on the
                    // keystroke that makes the name non-empty instead of
                    // waiting for some other state change to repaint it.
                    !managedForm.watch('name').trim() ||
                    (mode === 'github-create' && !selectedInstallationId)
                  }
                >
                  {submitting ? <Loading /> : <Plus />}
                  {mode === 'github-create' ? 'Create in your GitHub' : 'Create project'}
                </Button>
              </ModalFooter>
            </form>
          </Form>
        ) : (
          <Form {...githubForm}>
            <form onSubmit={githubForm.handleSubmit(handleLinkGitHub)} className="w-full">
              <ModalBody>
                <div className="min-h-[430px] space-y-5">
                  {githubInstallationsQuery.isLoading ? (
                    <div className="text-muted-foreground flex h-28 items-center justify-center text-sm">
                      <Loading />
                      {tHardcodedUi.raw(
                        'componentsProjectsProjectCreateModal.line352JsxTextLoadingGithubConnections',
                      )}
                    </div>
                  ) : githubInstallations.length === 0 ? (
                    githubInstallationsQuery.data?.configured === false ? (
                      // No GitHub App exists at all on this server (self-host
                      // with only a PAT, or nothing, configured) — the "install
                      // this App" card below has nothing to install. Route to
                      // Git settings instead of a dead-end Connect button.
                      <GitHubSetupRequiredPanel
                        accountId={effectiveAccountId}
                        isAdmin={isGitAdmin}
                        onNavigate={resetAndClose}
                        size="sm"
                      />
                    ) : (
                      <Item variant="outline" className={cn('items-start')}>
                        <ItemMedia variant="icon" className="rounded-full bg-transparent">
                          <GithubIcon />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>Link a GitHub account</ItemTitle>
                          <ItemDescription>
                            Select Configure in GitHub when the Kortix App is already installed.
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1.5"
                            disabled={isConnectingGitHub}
                            onClick={handleConnectGitHub}
                          >
                            {isConnectingGitHub ? <Loading /> : <GithubIcon />}
                            {isConnectingGitHub ? 'Connecting' : 'Link GitHub'}
                          </Button>
                        </ItemActions>
                      </Item>
                    )
                  ) : (
                    <>
                      <FormField
                        control={githubForm.control}
                        name="installationId"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <div className="flex items-center justify-between gap-3">
                              <FormLabel>
                                {tHardcodedUi.raw(
                                  'componentsProjectsProjectCreateModal.line391JsxTextGitAccount',
                                )}
                              </FormLabel>
                              {githubInstallationsQuery.data?.configured !== false ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-muted-foreground h-8 gap-1.5 px-2 text-xs"
                                  aria-label="Connect another GitHub account"
                                  disabled={isConnectingGitHub}
                                  onClick={handleConnectGitHub}
                                >
                                  {isConnectingGitHub ? <Loading /> : <Plus />}
                                  Add account
                                </Button>
                              ) : null}
                            </div>
                            <FormControl>
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                                disabled={submitting || githubInstallations.length < 2}
                              >
                                <SelectTrigger className="w-full justify-between p-0 has-[>svg]:p-0">
                                  <div className="flex h-full items-center">
                                    <span className="px-3">
                                      <GithubIcon className="size-4" />
                                    </span>
                                    <Separator orientation="vertical" className="mr-2" />
                                    <span
                                      className={cn(
                                        'min-w-0 truncate text-left',
                                        !selectedRepository && 'text-muted-foreground',
                                      )}
                                    >
                                      <span className="text-foreground">
                                        {githubInstallationLabel(
                                          selectedInstallation?.installation_id ?? null,
                                          selectedInstallation?.owner_login ?? null,
                                        )}
                                      </span>
                                    </span>
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  {githubInstallations.map((installation) => (
                                    <SelectItem
                                      key={installation.installation_id}
                                      value={installation.installation_id ?? ''}
                                      className="flex flex-row items-center gap-2"
                                    >
                                      <GithubIcon />
                                      <span>
                                        {githubInstallationLabel(
                                          installation.installation_id,
                                          installation.owner_login,
                                        )}
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </FormControl>

                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={githubForm.control}
                        name="repo"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel>Repository</FormLabel>
                            <FormControl>
                              <RepositoryPicker
                                value={field.value}
                                onValueChange={(repoFullName) => {
                                  field.onChange(repoFullName);
                                  const repo = repos.find(
                                    (item) => item.full_name === repoFullName,
                                  );
                                  githubForm.setValue('name', repo?.name ?? '');
                                }}
                                repos={repos}
                                loading={repositoryLoading}
                                disabled={submitting || !selectedInstallationId}
                                onSearchChange={setRepositorySearch}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {githubReposQuery.isError ? (
                        <ErrorState
                          title="Could not load repositories"
                          description={(githubReposQuery.error as Error).message}
                          size="sm"
                          action={
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void githubReposQuery.refetch()}
                            >
                              Retry
                            </Button>
                          }
                        />
                      ) : repos.length === 0 && !repositoryLoading ? (
                        <EmptyState
                          icon={Github}
                          title={
                            debouncedRepositorySearch
                              ? 'No matching repositories'
                              : tHardcodedUi.raw(
                                  'componentsProjectsProjectCreateModal.line484JsxAttrTitleNoRepositoriesAvailable',
                                )
                          }
                          description={
                            debouncedRepositorySearch
                              ? 'Try a different repository name.'
                              : tHardcodedUi.raw(
                                  'componentsProjectsProjectCreateModal.line485JsxAttrDescriptionUpdateTheGithubAppInstallationToGrantKortix',
                                )
                          }
                          size="sm"
                          action={
                            !debouncedRepositorySearch && selectedInstallation?.installation_url ? (
                              <Button
                                asChild
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                              >
                                <a
                                  href={selectedInstallation.installation_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  Configure
                                </a>
                              </Button>
                            ) : undefined
                          }
                        />
                      ) : null}

                      <FormField
                        control={githubForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel>
                              {tHardcodedUi.raw(
                                'componentsProjectsProjectCreateModal.line511JsxTextProjectName',
                              )}
                            </FormLabel>
                            {/* Same row treatment as the managed form's name
                                field — the icon belongs to the project, not to
                                the way its repository was sourced. */}
                            <div className="flex items-start gap-2">
                              <ProjectIconField
                                value={icon}
                                onChange={(emoji) => setIcon({ emoji })}
                                onGlyphChange={(glyph) => setIcon({ glyph })}
                                disabled={submitting}
                              />
                              <div className="min-w-0 flex-1">
                                <FormControl>
                                  <Input
                                    placeholder={tHardcodedUi.raw(
                                      'componentsProjectsProjectCreateModal.line516JsxAttrPlaceholderUseRepositoryName',
                                    )}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    {...field}
                                  />
                                </FormControl>
                              </div>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}

                  {!cloningFromSource ? (
                    <RepositoryOptions
                      repositoryMode={repositoryMode}
                      repositoryOptionsOpen={repositoryOptionsOpen}
                      collapsible={repositoryOptionsCollapsible}
                      onOpenChange={setAdvancedOpen}
                      onModeChange={switchRepositoryMode}
                      submitting={submitting}
                    />
                  ) : null}
                </div>
              </ModalBody>

              <ModalFooter>
                <Button
                  type="button"
                  variant="outline-ghost"
                  className="w-full sm:w-auto"
                  disabled={submitting}
                  onClick={resetAndClose}
                >
                  Cancel
                </Button>
                {/* No name gate here, unlike the managed footer: this form's
                    name field is optional and falls back to the repository
                    name, so gating on it would block a valid import. */}
                <Button
                  type="submit"
                  disabled={
                    submitting || !effectiveAccountId || !selectedInstallationId || !selectedRepo
                  }
                  className="w-full sm:w-auto"
                >
                  {submitting ? <Loading /> : <GithubIcon />}
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectCreateModal.line549JsxTextImportRepo',
                  )}
                </Button>
              </ModalFooter>
            </form>
          </Form>
        )}
      </ModalContent>
    </Modal>
  );
};

/** Account switcher for the new-project target. Only rendered by the caller
 *  when there's more than one account to create in — a single-account user
 *  never sees this, so the default dialog stays down to just a name field. */
function CreateAccountField({
  current,
  options,
  disabled,
  onSelect,
}: {
  current: KortixAccount;
  options: KortixAccount[];
  disabled?: boolean;
  onSelect: (accountId: string) => void;
}) {
  const label = current.name || 'Account';
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <EntityAvatar label={label} size="xs" />
      <span className="text-foreground min-w-0 truncate text-sm font-medium">{label}</span>
    </span>
  );

  return (
    <div className="space-y-1.5 px-5" data-testid="project-create-account">
      <Label>Account</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary-outline"
            disabled={disabled}
            className="w-full justify-between px-3"
          >
            {summary}
            <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuLabel className="text-muted-foreground">Create in</DropdownMenuLabel>
          <div className="max-h-[280px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {options.map((account) => {
              const itemLabel = account.name || 'Account';
              const active = account.account_id === current.account_id;
              return (
                <DropdownMenuItem
                  key={account.account_id}
                  onSelect={() => onSelect(account.account_id)}
                >
                  <EntityAvatar label={itemLabel} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm leading-tight font-medium">
                    {itemLabel}
                  </span>
                  {active && <CheckCircleSolid className="text-kortix-green size-3.5 shrink-0" />}
                </DropdownMenuItem>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Repository source (Kortix managed / Create in GitHub / Import from
 *  GitHub) as a progressive-disclosure control. Rendered at the bottom of
 *  each mode's form body, right above the footer — never above the project
 *  name field, so the 95% path (name → Create) is what a user reads first.
 *
 *  Only truly collapsible in the silent default (`collapsible`, i.e. managed
 *  mode with managed git actually usable). Everywhere else the caller has
 *  already pinned `repositoryOptionsOpen` true for a reason the user can't
 *  undo from here (they picked GitHub, or managed git is broken) — showing
 *  an interactive "Hide" trigger there would be a dead control, so we show
 *  a plain label instead and let the Tabs themselves be how you switch back. */
function RepositoryOptions({
  repositoryMode,
  repositoryOptionsOpen,
  collapsible,
  onOpenChange,
  onModeChange,
  onCloneTemplate,
  submitting,
}: {
  repositoryMode: RepositoryMode;
  repositoryOptionsOpen: boolean;
  collapsible: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (nextMode: string) => void;
  onCloneTemplate?: () => void;
  submitting: boolean;
}) {
  return (
    <Disclosure
      open={repositoryOptionsOpen}
      onOpenChange={onOpenChange}
      className={collapsible ? 'space-y-3' : 'space-y-1.5'}
    >
      {collapsible ? (
        <div className="flex flex-wrap items-center gap-1">
          <DisclosureTrigger>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-8 px-2 text-xs"
            >
              {repositoryOptionsOpen ? 'Hide repository options' : 'Use my own GitHub'}
            </Button>
          </DisclosureTrigger>
          {onCloneTemplate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-8 px-2 text-xs"
              disabled={submitting}
              onClick={onCloneTemplate}
            >
              Clone from a template
            </Button>
          ) : null}
        </div>
      ) : (
        <Label className="text-muted-foreground">Repository source</Label>
      )}
      <DisclosureContent>
        <div className="space-y-1.5 pb-0.5">
          {collapsible ? <Label>Repository source</Label> : null}
          <Tabs value={repositoryMode} onValueChange={onModeChange}>
            <TabsList className="w-full" aria-label="Repository source">
              <TabsTrigger value="managed" size="sm">
                Kortix managed
              </TabsTrigger>
              <TabsTrigger value="github-create" size="sm">
                Create in GitHub
              </TabsTrigger>
              <TabsTrigger value="github-import" size="sm">
                Import from GitHub
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-muted-foreground text-xs">
            {REPOSITORY_MODE_DESCRIPTIONS[repositoryMode]}
          </p>
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/** "Clone from a template" step — pick a `registry:project` marketplace item
 *  to seed the new project from, right inside the New Project flow (the
 *  same source items the public marketplace's "Clone" button uses). */
function TemplatePicker({
  templates,
  loading,
  onPick,
  onCancel,
}: {
  templates: MarketplaceItem[];
  loading: boolean;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <ModalBody>
        <div className="min-h-[200px] space-y-2">
          {loading ? (
            <div className="text-muted-foreground flex h-28 items-center justify-center text-sm">
              <Loading />
            </div>
          ) : templates.length === 0 ? (
            <EmptyState
              icon={Boxes}
              size="sm"
              title="No templates yet"
              description="Ready-to-clone Kortix projects will show up here."
            />
          ) : (
            templates.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPick(item.id)}
                className="hover:bg-muted/50 border-border/60 flex w-full items-start gap-3 rounded-md border px-3.5 py-3 text-left transition-colors"
              >
                <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-sm">
                  <Boxes className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium capitalize">
                    {item.title.replaceAll('-', ' ')}
                  </div>
                  {item.description ? (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
                      {item.description}
                    </p>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          type="button"
          variant="outline-ghost"
          className="w-full sm:w-auto"
          onClick={onCancel}
        >
          Back
        </Button>
      </ModalFooter>
    </>
  );
}
