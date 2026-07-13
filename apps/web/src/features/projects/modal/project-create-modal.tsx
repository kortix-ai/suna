'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { defaultProjectMarketplaceItems, listMarketplaceItems } from '@/lib/marketplace-client';
import { isProjectLimitError } from '@/lib/onboarding/ensure-first-project';
import { cn } from '@/lib/utils';
import {
  linkRepository,
  listAccounts,
  listGitHubInstallations,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  listProjectsForAccount,
  provisionProject,
  type KortixProject,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Boxes, ExternalLink, GitBranch, Github } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { CreateAccountField } from './create-account-field';
import { resolveCreateAccountSelection } from './create-account-selection';
import { BranchPicker, RepositoryPicker } from './github-import-pickers';
import { resolveGitHubBranchSelection } from './github-import-selection';
import { SetupOptionRow } from './setup-option-row';

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
  includeGeneralKnowledgeSkills: z.boolean(),
  marketplaceItems: z.array(z.string()),
});

const githubLinkSchema = z.object({
  installationId: z.string().min(1, 'Select a GitHub account'),
  repo: z.string().trim().min(1, 'Select a GitHub repository'),
  branch: z.string().trim().min(1, 'Select a GitHub branch'),
  name: z.string(),
});

type ManagedProjectFormValues = z.infer<typeof managedProjectSchema>;
type GitHubLinkFormValues = z.infer<typeof githubLinkSchema>;

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
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

export const ProjectCreateModal = ({ open, onOpenChange, accountId }: ProjectCreateModalProps) => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'managed' | 'github'>('managed');
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [marketplaceDefaultsApplied, setMarketplaceDefaultsApplied] = useState(false);
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
    enabled: open,
  });
  const accountSelection = useMemo(
    () => resolveCreateAccountSelection(accountsQuery.data, accountId, pickedAccountId),
    [accountsQuery.data, accountId, pickedAccountId],
  );
  const effectiveAccountId = accountSelection.effectiveAccountId;

  const managedForm = useForm<ManagedProjectFormValues>({
    resolver: zodResolver(managedProjectSchema),
    defaultValues: {
      name: '',
      includeGeneralKnowledgeSkills: true,
      marketplaceItems: [],
    },
  });

  const githubForm = useForm<GitHubLinkFormValues>({
    resolver: zodResolver(githubLinkSchema),
    defaultValues: {
      installationId: '',
      repo: '',
      branch: '',
      name: '',
    },
  });

  const selectedInstallationId = githubForm.watch('installationId');
  const selectedRepo = githubForm.watch('repo');
  const selectedBranch = githubForm.watch('branch');

  function resetAndClose() {
    setMode('managed');
    setMarketplaceDefaultsApplied(false);
    setPickedAccountId(null);
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

  const createMutation = useMutation({
    mutationFn: provisionProject,
    onSuccess: (project) => {
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
      errorToast(error.message || 'Failed to create project');
    },
  });

  const githubInstallationsQuery = useQuery({
    queryKey: ['github-installations', effectiveAccountId],
    queryFn: () => listGitHubInstallations(effectiveAccountId!),
    enabled: open && mode === 'github' && !!effectiveAccountId,
    staleTime: 0,
  });

  const marketplaceDefaultsQuery = useQuery({
    queryKey: ['marketplace-default-project-items'],
    queryFn: () => listMarketplaceItems({ source: 'kortix', type: 'skill' }),
    enabled: open && mode === 'managed',
    staleTime: 60_000,
  });
  const marketplaceItems = useMemo(
    () => defaultProjectMarketplaceItems(marketplaceDefaultsQuery.data?.items),
    [marketplaceDefaultsQuery.data?.items],
  );
  const includeGeneralKnowledgeSkills = managedForm.watch('includeGeneralKnowledgeSkills');
  const includedCount = includeGeneralKnowledgeSkills ? 1 : 0;

  useEffect(() => {
    if (!open || marketplaceDefaultsApplied || marketplaceItems.length === 0) return;
    managedForm.setValue(
      'marketplaceItems',
      marketplaceItems.map((item) => item.id),
      {
        shouldDirty: false,
        shouldTouch: false,
        shouldValidate: false,
      },
    );
    setMarketplaceDefaultsApplied(true);
  }, [managedForm, marketplaceDefaultsApplied, marketplaceItems, open]);

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

  const githubBranchesQuery = useQuery({
    queryKey: [
      'github-repository-branches',
      effectiveAccountId,
      selectedInstallationId,
      selectedRepo,
    ],
    queryFn: () =>
      listGitHubRepositoryBranches(effectiveAccountId!, selectedInstallationId, selectedRepo),
    enabled:
      open &&
      mode === 'github' &&
      !!effectiveAccountId &&
      !!selectedInstallationId &&
      !!selectedRepo,
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
    githubForm.setValue('branch', '');
    githubForm.setValue('name', '');
  }, [githubForm, selectedInstallationId]);

  useEffect(() => {
    githubForm.setValue('branch', '');
  }, [githubForm, selectedRepo]);

  useEffect(() => {
    if (!githubBranchesQuery.data) return;
    githubForm.setValue(
      'branch',
      resolveGitHubBranchSelection(githubBranchesQuery.data, githubForm.getValues('branch')),
      { shouldValidate: true },
    );
  }, [githubBranchesQuery.data, githubForm]);

  const linkMutation = useMutation({
    mutationFn: linkRepository,
    onSuccess: (result) => {
      successToast('Project imported');
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
    const defaultMarketplaceItems = marketplaceItems.map((item) => item.id);
    createMutation.mutate({
      account_id: effectiveAccountId,
      name: values.name,
      starter_template: 'minimal',
      marketplace_items: values.includeGeneralKnowledgeSkills ? defaultMarketplaceItems : [],
    });
  }

  function handleLinkGitHub(values: GitHubLinkFormValues) {
    if (!effectiveAccountId) return errorToast('Select an account first');
    const trimmedName = values.name.trim();
    linkMutation.mutate({
      account_id: effectiveAccountId,
      installation_id: values.installationId,
      repo_full_name: values.repo,
      default_branch: values.branch,
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
  const branches = githubBranchesQuery.data?.branches ?? [];
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

        {mode === 'managed' ? (
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

                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-foreground text-sm font-medium">Starter skills</span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {includedCount} included
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Preinstalled into your project&apos;s repo and ready in the first session.
                      Toggle off anything you don&apos;t need.
                    </p>
                    <div className="divide-border/60 divide-y overflow-hidden rounded-2xl border">
                      <SetupOptionRow
                        icon={
                          <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
                            <Boxes className="size-4" />
                          </span>
                        }
                        title="Starter pack"
                        description="Ready-made skills for research, writing, documents, slides, data, the web, and browser automation."
                        selected={includeGeneralKnowledgeSkills}
                        disabled={submitting}
                        onToggle={(next) => {
                          managedForm.setValue('includeGeneralKnowledgeSkills', next, {
                            shouldDirty: true,
                          });
                          managedForm.setValue(
                            'marketplaceItems',
                            next ? marketplaceItems.map((item) => item.id) : [],
                            { shouldDirty: true },
                          );
                        }}
                      />
                    </div>
                  </div>

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
              </ModalBody>
              <ModalFooter>
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={
                    submitting ||
                    !effectiveAccountId ||
                    (includeGeneralKnowledgeSkills && marketplaceDefaultsQuery.isLoading)
                  }
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
                  ) : githubInstallationsQuery.isError ? (
                    <ErrorState
                      size="sm"
                      title="Couldn’t load GitHub accounts"
                      description={githubInstallationsQuery.error.message}
                      action={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void githubInstallationsQuery.refetch()}
                        >
                          Retry
                        </Button>
                      }
                    />
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
                                disabled={
                                  githubReposQuery.isLoading ||
                                  githubReposQuery.isError ||
                                  submitting
                                }
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {githubReposQuery.isError ? (
                        <InfoBanner
                          tone="destructive"
                          icon={AlertTriangle}
                          title="Couldn’t load repositories"
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
                        >
                          {githubReposQuery.error.message}
                        </InfoBanner>
                      ) : null}

                      {repos.length === 0 &&
                      !githubReposQuery.isLoading &&
                      !githubReposQuery.isError ? (
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

                      {selectedRepo ? (
                        <>
                          <FormField
                            control={githubForm.control}
                            name="branch"
                            render={({ field }) => (
                              <FormItem className="space-y-1.5">
                                <FormLabel>Branch</FormLabel>
                                <FormControl>
                                  <BranchPicker
                                    value={field.value}
                                    onValueChange={field.onChange}
                                    branches={branches}
                                    loading={githubBranchesQuery.isLoading}
                                    disabled={
                                      githubBranchesQuery.isLoading ||
                                      githubBranchesQuery.isError ||
                                      submitting
                                    }
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          {githubBranchesQuery.isError ? (
                            <InfoBanner
                              tone="destructive"
                              icon={AlertTriangle}
                              title="Couldn’t load branches"
                              action={
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void githubBranchesQuery.refetch()}
                                >
                                  Retry
                                </Button>
                              }
                            >
                              {githubBranchesQuery.error.message}
                            </InfoBanner>
                          ) : null}

                          {branches.length === 0 &&
                          !githubBranchesQuery.isLoading &&
                          !githubBranchesQuery.isError ? (
                            <EmptyState
                              icon={GitBranch}
                              title="No branches available"
                              description="Create a branch on GitHub before importing this repository."
                              size="sm"
                            />
                          ) : null}
                        </>
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
                    submitting ||
                    !effectiveAccountId ||
                    !selectedInstallationId ||
                    !selectedRepo ||
                    !selectedBranch
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
