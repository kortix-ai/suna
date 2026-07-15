'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { List, ListRow } from '@/components/ui/list';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { isManagedGitUnavailableError, isProjectLimitError } from '@/lib/onboarding/ensure-first-project';
import {
  getMarketplaceItem,
  listMarketplaceItems,
  type MarketplaceItem,
} from '@/lib/marketplace-client';
import {
  getManagedGitStatus,
  linkRepository,
  listAccounts,
  listGitHubInstallations,
  listGitHubRepositories,
  listProjectsForAccount,
  provisionProject,
  type GitHubRepository,
  type KortixAccount,
  type KortixProject,
} from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { Boxes, ChevronsUpDown, ExternalLink, Github } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { resolveCreateAccountSelection } from './create-account-selection';
import {
  startProjectOnboardingSession,
  startTemplateSetupSession,
} from './template-setup-session';

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
        .max(PROJECT_NAME_MAX_LENGTH, `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`),
    ),
});

const githubLinkSchema = z.object({
  installationId: z.string().min(1, 'Select a GitHub account'),
  repo: z.string().trim().min(1, 'Select a GitHub repository'),
  name: z.string(),
});

type ManagedProjectFormValues = z.infer<typeof managedProjectSchema>;
type GitHubLinkFormValues = z.infer<typeof githubLinkSchema>;

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  /** Clone a `registry:project` marketplace item instead of the blank
   *  starter — set from `/projects?clone=<item-id>` (marketplace "Clone"). */
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'managed' | 'template' | 'github'>('managed');
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [sourceNameApplied, setSourceNameApplied] = useState(false);
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  // Cloning a project template comes from two places: the marketplace's
  // "Clone" button (external `?clone=` → `sourceItemId` prop) or picking one
  // right here via "Clone from a template" (`pickedTemplateId`). Once either
  // is set, the rest of the managed form behaves identically either way.
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);
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
    staleTime: 60_000,
    enabled: open,
  });
  const managedGitUnavailable = managedGitStatusQuery.data?.configured === false;
  const accountSelection = useMemo(
    () => resolveCreateAccountSelection(accountsQuery.data, accountId, pickedAccountId),
    [accountsQuery.data, accountId, pickedAccountId],
  );
  const effectiveAccountId = accountSelection.effectiveAccountId;

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

  function resetAndClose() {
    setMode('managed');
    setSourceNameApplied(false);
    setPickedAccountId(null);
    setPickedTemplateId(null);
    managedForm.reset();
    githubForm.reset();
    onOpenChange(false);
  }

  function switchToGitHubMode() {
    setMode('github');
  }

  function switchToManagedMode() {
    managedForm.setValue('name', githubForm.getValues('name'));
    setMode('managed');
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

  const createMutation = useMutation({
    mutationFn: provisionProject,
    onSuccess: async (project) => {
      successToast('Project created');
      queryClient.setQueryData<KortixProject[]>(['projects', project.account_id], (projects) =>
        upsertProject(projects, project),
      );
      queryClient.setQueryData<KortixProject[]>(['projects'], (projects) =>
        upsertProject(projects, project),
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.refetchQueries({
        queryKey: ['projects'],
        type: 'active',
      });

      // Cloned from a marketplace item → route through the setup session
      // instead of dropping the user on an empty project.
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

      // Plain new project → the "agent creation" default: start a first session
      // that onboards + personalizes the preloaded starter, instead of landing
      // the user on an empty project. Falls back to the project home if it fails.
      const onboardingSessionId = await startProjectOnboardingSession(project);
      if (onboardingSessionId) {
        resetAndClose();
        router.replace(`/projects/${project.project_id}/sessions/${onboardingSessionId}`);
        return;
      }

      resetAndClose();
      router.replace(`/projects/${project.project_id}`);
    },
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
        errorToast("Managed git isn't set up on this server — ask your admin to configure GitHub.");
        return;
      }
      errorToast(error.message || 'Failed to create project');
    },
  });

  const githubInstallationsQuery = useQuery({
    queryKey: ['github-installations', effectiveAccountId],
    queryFn: () => listGitHubInstallations(effectiveAccountId!),
    enabled: open && mode === 'github' && !!effectiveAccountId,
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
  const selectedInstallation =
    githubInstallations.find(
      (installation) => installation.installation_id === selectedInstallationId,
    ) ?? null;

  const githubReposQuery = useQuery({
    queryKey: ['github-repositories', effectiveAccountId, selectedInstallationId],
    queryFn: () => listGitHubRepositories(effectiveAccountId!, selectedInstallationId),
    enabled: open && mode === 'github' && !!effectiveAccountId && !!selectedInstallationId,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open || mode !== 'github') return;
    if (
      selectedInstallationId &&
      githubInstallations.some(
        (installation) => installation.installation_id === selectedInstallationId,
      )
    ) {
      return;
    }
    const first = githubInstallations[0]?.installation_id;
    githubForm.setValue('installationId', first ?? '');
  }, [githubForm, githubInstallations, mode, open, selectedInstallationId]);

  useEffect(() => {
    githubForm.setValue('repo', '');
    githubForm.setValue('name', '');
  }, [githubForm, selectedInstallationId]);

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

  function handleCreate(values: ManagedProjectFormValues) {
    if (!effectiveAccountId) return errorToast('Select an account first');
    if (cloningFromSource && effectiveSourceItemId) {
      createMutation.mutate({
        account_id: effectiveAccountId,
        name: values.name,
        source_item_id: effectiveSourceItemId,
      });
      return;
    }
    createMutation.mutate({
      account_id: effectiveAccountId,
      name: values.name,
      // One starter kit: every new project ships the full Kortix skill kit (the
      // general-knowledge-worker template seeds every skill).
      starter_template: 'general-knowledge-worker',
      marketplace_items: [],
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
    });
  }

  async function handleConnectGitHub() {
    if (!effectiveAccountId) {
      errorToast('Select an account first');
      return;
    }

    setIsConnectingGitHub(true);
    try {
      const result = await githubInstallationsQuery.refetch();
      if (result.error) throw result.error;

      const freshInstallUrl = result.data?.install_url;
      if (!freshInstallUrl) {
        errorToast(
          result.data?.configured === false
            ? 'GitHub App is not configured'
            : 'GitHub install URL unavailable',
        );
        return;
      }

      rememberGitHubSetupReturn('/projects?new=1');
      window.location.assign(freshInstallUrl);
    } catch (error) {
      errorToast((error as Error).message || 'Failed to start GitHub setup');
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  const submitting = createMutation.isPending || linkMutation.isPending;
  const installUrl = githubInstallationsQuery.data?.install_url;
  const repos = githubReposQuery.data?.repositories ?? [];
  const selectedRepository = repos.find((repo) => repo.full_name === selectedRepo);

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

        {accountSelection.currentAccount ? (
          <CreateAccountField
            current={accountSelection.currentAccount}
            options={accountSelection.options}
            canSwitch={accountSelection.canSwitch}
            disabled={submitting}
            onSelect={setPickedAccountId}
          />
        ) : null}

        {mode === 'template' ? (
          <TemplatePicker
            templates={templates}
            loading={templatesQuery.isLoading}
            onPick={pickTemplate}
            onCancel={() => setMode('managed')}
          />
        ) : mode === 'managed' ? (
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
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {managedGitUnavailable ? (
                    <InfoBanner tone="warning" title="Managed git isn't set up on this server">
                      Ask your admin to configure GitHub, or{' '}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={switchToGitHubMode}
                      >
                        import an existing GitHub repo
                      </button>{' '}
                      instead.
                    </InfoBanner>
                  ) : null}

                  {cloningFromSource ? (
                    <div className="divide-border/60 overflow-hidden rounded-2xl border divide-y">
                      <div className="flex items-start gap-3 px-3.5 py-3">
                        <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
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
                  ) : (
                    <div className="space-y-2.5">
                      <span className="text-foreground text-sm font-medium">Starter skills</span>
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        Every new project ships with the full Kortix skill kit —
                        preinstalled into your repo and ready in the first session.
                      </p>
                      <div className="flex items-center gap-3 rounded-2xl border px-3.5 py-3">
                        <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
                          <Boxes className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-foreground text-sm font-medium">Starter pack</div>
                          <div className="text-muted-foreground text-xs leading-relaxed">
                            Ready-made skills for research, writing, documents, slides, data, the
                            web, and browser automation.
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {!cloningFromSource ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        disabled={submitting || managedGitUnavailable}
                        onClick={switchToTemplateMode}
                        title={managedGitUnavailable ? "Managed git isn't set up on this server" : undefined}
                      >
                        <Boxes className="size-4" />
                        Clone from a template
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        disabled={submitting}
                        onClick={switchToGitHubMode}
                      >
                        <Icon.Github />
                        {tHardcodedUi.raw(
                          'componentsProjectsProjectCreateModal.line297JsxTextImportExistingGithubRepo',
                        )}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={submitting || !effectiveAccountId || managedGitUnavailable}
                >
                  {submitting ? <Loading /> : <Icon.Plus />}
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectCreateModal.line320JsxTextCreateProject',
                  )}
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
                    <Item variant="outline" className={cn('items-start')}>
                      <ItemMedia variant="icon" className="rounded-full bg-transparent">
                        <Icon.Github />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {tHardcodedUi.raw(
                            'componentsProjectsProjectCreateModal.line362JsxAttrTitleConnectTheKortixGithubApp',
                          )}
                        </ItemTitle>
                        <ItemDescription>
                          {tHardcodedUi.raw(
                            'componentsProjectsProjectCreateModal.line383JsxTextKortixUsesTheGithubAppToListRepositories',
                          )}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          className="gap-1.5"
                          disabled={
                            isConnectingGitHub ||
                            (!installUrl && githubInstallationsQuery.isFetching)
                          }
                          onClick={handleConnectGitHub}
                        >
                          {isConnectingGitHub ? <Loading /> : <Icon.Github />}
                          {isConnectingGitHub ? 'Connecting' : 'Connect'}
                        </Button>
                      </ItemActions>
                    </Item>
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
                              {/* <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
                                disabled={isConnectingGitHub}
                                onClick={handleConnectGitHub}
                              >
                                {isConnectingGitHub ? (
                                  <Loading />
                                ) : (
                                  <Icon.Github />
                                )}
                                {tHardcodedUi.raw(
                                  'componentsProjectsProjectCreateModal.line405JsxTextAddAccount',
                                )}
                              </Button> */}
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
                                      <Icon.Github className="size-4" />
                                    </span>
                                    <Separator orientation="vertical" className="mr-2" />
                                    <span
                                      className={cn(
                                        'min-w-0 truncate text-left',
                                        !selectedRepository && 'text-muted-foreground',
                                      )}
                                    >
                                      github.com/
                                      <span className="text-foreground">
                                        {
                                          githubInstallations.find(
                                            (installation) =>
                                              installation.installation_id === field.value,
                                          )?.owner_login
                                        }
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
                                      <Icon.Github />
                                      <span>{installation.owner_login}</span>
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
                                loading={githubReposQuery.isLoading}
                                disabled={githubReposQuery.isLoading || submitting}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {repos.length === 0 && !githubReposQuery.isLoading ? (
                        <EmptyState
                          icon={Github}
                          title={tHardcodedUi.raw(
                            'componentsProjectsProjectCreateModal.line484JsxAttrTitleNoRepositoriesAvailable',
                          )}
                          description={tHardcodedUi.raw(
                            'componentsProjectsProjectCreateModal.line485JsxAttrDescriptionUpdateTheGithubAppInstallationToGrantKortix',
                          )}
                          size="sm"
                          action={
                            selectedInstallation?.installation_url ? (
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
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}
                </div>
              </ModalBody>

              <ModalFooter className="w-full sm:justify-between">
                <Button
                  type="button"
                  variant="outline-ghost"
                  className="w-full sm:w-auto"
                  onClick={switchToManagedMode}
                >
                  {tI18nHardcoded.raw(
                    'autoFeaturesProjectsModalProjectCreateModalJsxTextGoBack8b169f5b',
                  )}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    submitting || !effectiveAccountId || !selectedInstallationId || !selectedRepo
                  }
                  className="w-full sm:w-auto"
                >
                  {submitting ? <Loading /> : <Icon.Github />}
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

/** Shows which account the new project will be created under. Becomes a
 *  dropdown when the user can create projects in more than one account;
 *  otherwise it's a static read-only field so the target is still visible. */
function CreateAccountField({
  current,
  options,
  canSwitch,
  disabled,
  onSelect,
}: {
  current: KortixAccount;
  options: KortixAccount[];
  canSwitch: boolean;
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
      {canSwitch ? (
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
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
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
      ) : (
        <div className="border-border bg-secondary flex h-9 w-full items-center rounded-md border px-3">
          {summary}
        </div>
      )}
    </div>
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
                className="hover:bg-muted/50 border-border/60 flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors"
              >
                <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
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
        <Button type="button" variant="outline-ghost" className="w-full sm:w-auto" onClick={onCancel}>
          Back
        </Button>
      </ModalFooter>
    </>
  );
}

function RepositoryPicker({
  value,
  repos,
  loading,
  disabled,
  onValueChange,
}: {
  value: string;
  repos: GitHubRepository[];
  loading: boolean;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selectedRepository = repos.find((repo) => repo.full_name === value);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRepos = normalizedSearch
    ? repos.filter((repo) =>
        [repo.full_name, repo.name, repo.default_branch, repo.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch),
      )
    : repos;

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary-outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between p-0 has-[>svg]:p-0"
        >
          <div className="flex h-full items-center">
            <span className="px-3">
              <Icon.Github className="size-4" />
            </span>
            <Separator orientation="vertical" className="mr-2" />
            <span
              className={cn(
                'min-w-0 truncate text-left',
                !selectedRepository && 'text-muted-foreground',
              )}
            >
              {loading
                ? 'Loading repositories...'
                : (selectedRepository?.full_name ?? 'Search repositories')}
            </span>
          </div>
          <span className="shrink-0 pr-4 has-[>svg]:pr-3">
            <ChevronsUpDown className="text-muted-foreground" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
      >
        <div className="border-border/60 border-b p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tHardcodedUi.raw(
              'componentsProjectsProjectCreateModal.line623JsxAttrPlaceholderSearchRepositories',
            )}
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            variant="transparent"
            className="px-2"
          />
        </div>
        {filteredRepos.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            {tHardcodedUi.raw(
              'componentsProjectsProjectCreateModal.line631JsxTextNoRepositoriesFound',
            )}
          </div>
        ) : (
          <List className="max-h-[min(50vh,360px)] overflow-y-auto">
            {filteredRepos.map((repo) => {
              const selected = repo.full_name === value;
              return (
                <ListRow
                  key={repo.id}
                  onClick={() => {
                    onValueChange(repo.full_name);
                    setOpen(false);
                  }}
                  // leading={selected ? <CheckCircleSolid className='size-4' /> : <Icon.Github />}
                  title={<span className="text-sm">{repo.full_name}</span>}
                  badges={
                    repo.private ? (
                      <Badge variant="secondary" size="sm">
                        Private
                      </Badge>
                    ) : null
                  }
                  subtitle={
                    <InlineMeta className="font-sans">
                      <span>{repo.default_branch}</span>
                      {repo.description ? (
                        <span className="truncate">{repo.description}</span>
                      ) : null}
                    </InlineMeta>
                  }
                  className={cn(selected && 'bg-muted/50')}
                />
              );
            })}
          </List>
        )}
      </PopoverContent>
    </Popover>
  );
}
