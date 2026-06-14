'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
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
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import {
  linkRepository,
  listGitHubInstallations,
  listGitHubRepositories,
  provisionProject,
  type GitHubRepository,
  type KortixProject,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, ExternalLink, Github } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

const sanitizeProjectName = (value: string) => value.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();

const managedProjectSchema = z.object({
  name: z
    .string()
    .transform(sanitizeProjectName)
    .pipe(z.string().min(1, 'Project name is required')),
  includeGeneralKnowledgeSkills: z.boolean(),
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'managed' | 'github'>('managed');
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);

  const managedForm = useForm<ManagedProjectFormValues>({
    resolver: zodResolver(managedProjectSchema),
    defaultValues: {
      name: '',
      includeGeneralKnowledgeSkills: true,
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
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to create project');
    },
  });

  const githubInstallationsQuery = useQuery({
    queryKey: ['github-installations', accountId],
    queryFn: () => listGitHubInstallations(accountId!),
    enabled: open && mode === 'github' && !!accountId,
    staleTime: 0,
  });

  const githubInstallations = useMemo(
    () => githubInstallationsQuery.data?.installations ?? [],
    [githubInstallationsQuery.data?.installations],
  );
  const selectedInstallation =
    githubInstallations.find(
      (installation) => installation.installation_id === selectedInstallationId,
    ) ?? null;

  const githubReposQuery = useQuery({
    queryKey: ['github-repositories', accountId, selectedInstallationId],
    queryFn: () => listGitHubRepositories(accountId!, selectedInstallationId),
    enabled: open && mode === 'github' && !!accountId && !!selectedInstallationId,
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
    if (!accountId) return errorToast('Select an account first');
    createMutation.mutate({
      account_id: accountId,
      name: values.name,
      starter_template: values.includeGeneralKnowledgeSkills
        ? 'general-knowledge-worker'
        : 'minimal',
    });
  }

  function handleLinkGitHub(values: GitHubLinkFormValues) {
    if (!accountId) return errorToast('Select an account first');
    const trimmedName = values.name.trim();
    linkMutation.mutate({
      account_id: accountId,
      installation_id: values.installationId,
      repo_full_name: values.repo,
      ...(trimmedName ? { name: trimmedName } : {}),
    });
  }

  async function handleConnectGitHub() {
    if (!accountId) {
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
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={managedForm.control}
                    name="includeGeneralKnowledgeSkills"
                    render={({ field }) => (
                      <Item variant="outline" className="items-start">
                        <ItemContent>
                          <ItemTitle>
                            <FormLabel>
                              {tHardcodedUi.raw(
                                'componentsProjectsProjectCreateModal.line273JsxTextGeneralKnowledgeWorkerSkills',
                              )}
                            </FormLabel>
                          </ItemTitle>
                          <ItemDescription>
                            {tHardcodedUi.raw(
                              'componentsProjectsProjectCreateModal.line275JsxTextIncludePreconfiguredSkillsForResearchAuditSupportBrand',
                            )}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              disabled={submitting}
                            />
                          </FormControl>
                        </ItemActions>
                      </Item>
                    )}
                  />

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
                <Button type="submit" disabled={submitting || !accountId}>
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
                <Button type="button" variant="ghost" onClick={switchToManagedMode}>
                  Go back
                </Button>
                <Button
                  type="submit"
                  disabled={submitting || !accountId || !selectedInstallationId || !selectedRepo}
                >
                  {submitting ? <Loading  /> : <Icon.Github />}
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
