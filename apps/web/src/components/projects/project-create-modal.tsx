'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  linkRepository,
  type GitHubRepository,
  listGitHubInstallations,
  listGitHubRepositories,
  provisionProject,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';

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

/**
 * New project defaults to a managed Kortix git repo, with an explicit GitHub
 * import path backed by the GitHub App installation.
 */
export function ProjectCreateModal({
  open,
  onOpenChange,
  accountId,
}: ProjectCreateModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'managed' | 'github'>('managed');
  const [newName, setNewName] = useState('');
  const [includeGeneralKnowledgeSkills, setIncludeGeneralKnowledgeSkills] = useState(true);
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);

  function resetAndClose() {
    setMode('managed');
    setNewName('');
    setIncludeGeneralKnowledgeSkills(true);
    setSelectedInstallationId('');
    setSelectedRepo('');
    onOpenChange(false);
  }

  const createMutation = useMutation({
    mutationFn: provisionProject,
    onSuccess: (project) => {
      toast.success('Project created');
      router.replace(`/projects/${project.project_id}`);
      resetAndClose();
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create project');
    },
  });

  const githubInstallationsQuery = useQuery({
    queryKey: ['github-installations', accountId],
    queryFn: () => listGitHubInstallations(accountId!),
    enabled: open && mode === 'github' && !!accountId,
    staleTime: 0,
  });

  const githubInstallations =
    githubInstallationsQuery.data?.installations ?? [];
  const selectedInstallation =
    githubInstallations.find(
      (installation) => installation.installation_id === selectedInstallationId,
    ) ?? null;

  const githubReposQuery = useQuery({
    queryKey: ['github-repositories', accountId, selectedInstallationId],
    queryFn: () => listGitHubRepositories(accountId!, selectedInstallationId),
    enabled:
      open && mode === 'github' && !!accountId && !!selectedInstallationId,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open || mode !== 'github') return;
    if (
      selectedInstallationId &&
      githubInstallations.some(
        (installation) =>
          installation.installation_id === selectedInstallationId,
      )
    ) {
      return;
    }
    const first = githubInstallations[0]?.installation_id;
    setSelectedInstallationId(first ?? '');
  }, [githubInstallations, mode, open, selectedInstallationId]);

  useEffect(() => {
    setSelectedRepo('');
  }, [selectedInstallationId]);

  const linkMutation = useMutation({
    mutationFn: linkRepository,
    onSuccess: (result) => {
      toast.success('Repository linked');
      router.replace(`/projects/${result.project.project_id}`);
      resetAndClose();
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to link repository');
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    // Strip disallowed characters instead of rejecting; the backend derives a
    // safe repo slug from whatever clean name we send.
    const name = newName.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();
    if (!name) return toast.error('Project name is required');
    createMutation.mutate({
      account_id: accountId,
      name,
      starter_template: includeGeneralKnowledgeSkills
        ? 'general-knowledge-worker'
        : 'minimal',
    });
  }

  function handleLinkGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const repoFullName = selectedRepo.trim();
    if (!selectedInstallationId) return toast.error('Select a GitHub account');
    if (!repoFullName) return toast.error('Select a GitHub repository');
    linkMutation.mutate({
      account_id: accountId,
      installation_id: selectedInstallationId,
      repo_full_name: repoFullName,
      ...(newName.trim() ? { name: newName.trim() } : {}),
    });
  }

  async function handleConnectGitHub() {
    if (!accountId) {
      toast.error('Select an account first');
      return;
    }

    setIsConnectingGitHub(true);
    try {
      const result = await githubInstallationsQuery.refetch();
      if (result.error) throw result.error;

      const freshInstallUrl = result.data?.install_url;
      if (!freshInstallUrl) {
        toast.error(
          result.data?.configured === false
            ? 'GitHub App is not configured'
            : 'GitHub install URL unavailable',
        );
        return;
      }

      rememberGitHubSetupReturn('/projects?new=1');
      window.location.assign(freshInstallUrl);
    } catch (error) {
      toast.error((error as Error).message || 'Failed to start GitHub setup');
    } finally {
      setIsConnectingGitHub(false);
    }
  }

  const submitting = createMutation.isPending || linkMutation.isPending;
  const installUrl = githubInstallationsQuery.data?.install_url;
  const repos = githubReposQuery.data?.repositories ?? [];
  const selectedRepository = repos.find(
    (repo) => repo.full_name === selectedRepo,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line237JsxTextNewProject')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line240JsxTextStartWithAPrivateManagedRepoExistingGithub')}</DialogDescription>
        </DialogHeader>

        {mode === 'managed' ? (
          <form onSubmit={handleCreate}>
            <div className="space-y-5 px-6 py-5">
              <InfoBanner
                tone="neutral"
                icon={GitBranch}
                title={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line251JsxAttrTitleKortixManagedRepository')}
              >{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line253JsxTextCreatesAPrivateManagedRepoSeedsTheStarter')}</InfoBanner>

              <div className="space-y-1.5">
                <Label htmlFor="new-name">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line258JsxTextProjectName')}</Label>
                <Input
                  id="new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-agi-company"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="font-mono"
                  autoFocus
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 px-3 py-3">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="gkw-skills">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line273JsxTextGeneralKnowledgeWorkerSkills')}</Label>
                  <p className="text-xs leading-5 text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line275JsxTextIncludePreconfiguredSkillsForResearchAuditSupportBrand')}</p>
                </div>
                <Switch
                  id="gkw-skills"
                  checked={includeGeneralKnowledgeSkills}
                  onCheckedChange={setIncludeGeneralKnowledgeSkills}
                  disabled={submitting}
                />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-fit gap-1.5 px-2 text-xs text-muted-foreground"
                disabled={submitting}
                onClick={() => setMode('github')}
              >
                <Github className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line297JsxTextImportExistingGithubRepo')}</Button>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
              <Button
                type="button"
                variant="ghost"
                onClick={resetAndClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="gap-1.5"
                disabled={submitting || !accountId}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line320JsxTextCreateProject')}</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleLinkGitHub}>
            <div className="min-h-[430px] space-y-5 px-6 py-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line330JsxTextImportGithubRepository')}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line333JsxTextPickAConnectedGithubAccountThenSearchIts')}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  disabled={submitting}
                  onClick={() => setMode('managed')}
                >
                  <GitBranch className="h-4 w-4" />{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line345JsxTextManagedRepo')}</Button>
              </div>

              {githubInstallationsQuery.isLoading ? (
                <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line352JsxTextLoadingGithubConnections')}</div>
              ) : githubInstallations.length === 0 ? (
                <InfoBanner
                  tone={
                    githubInstallationsQuery.data?.configured === false
                      ? 'warning'
                      : 'info'
                  }
                  icon={Github}
                  title={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line362JsxAttrTitleConnectTheKortixGithubApp')}
                  action={
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
                      {isConnectingGitHub ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Github className="h-4 w-4" />
                      )}
                      {isConnectingGitHub ? 'Connecting' : 'Connect'}
                    </Button>
                  }
                >{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line383JsxTextKortixUsesTheGithubAppToListRepositories')}</InfoBanner>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="github-installation">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line391JsxTextGitAccount')}</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                        disabled={isConnectingGitHub}
                        onClick={handleConnectGitHub}
                      >
                        {isConnectingGitHub ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Github className="h-4 w-4" />
                        )}{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line405JsxTextAddAccount')}</Button>
                    </div>
                    <Select
                      value={selectedInstallationId}
                      onValueChange={setSelectedInstallationId}
                      disabled={submitting || githubInstallations.length < 2}
                    >
                      <SelectTrigger
                        id="github-installation"
                        className="w-full"
                      >
                        <SelectValue placeholder={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line417JsxAttrPlaceholderSelectAGithubAccount')} />
                      </SelectTrigger>
                      <SelectContent>
                        {githubInstallations.map((installation) => (
                          <SelectItem
                            key={installation.installation_id}
                            value={installation.installation_id ?? ''}
                          >
                            <Github className="h-4 w-4" />
                            <span>{installation.owner_login}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="min-h-4">
                      <InlineMeta>
                        {selectedInstallation?.owner_type ? (
                          <span>{selectedInstallation.owner_type}</span>
                        ) : null}
                        {selectedInstallation?.repository_selection ? (
                          <span>
                            {selectedInstallation.repository_selection ===
                            'selected'
                              ? 'Selected repositories'
                              : 'All repositories'}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() =>
                            router.push(`/accounts/${accountId}?tab=git`)
                          }
                        >{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line451JsxTextManageGitConnections')}</button>
                      </InlineMeta>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="github-repo">Repository</Label>
                    <RepositoryPicker
                      value={selectedRepo}
                      onValueChange={setSelectedRepo}
                      repos={repos}
                      loading={githubReposQuery.isLoading}
                      disabled={githubReposQuery.isLoading || submitting}
                    />
                    <div className="min-h-4">
                      {selectedRepository ? (
                        <InlineMeta>
                          <span>{selectedRepository.default_branch}</span>
                          <span>
                            {selectedRepository.private ? 'Private' : 'Public'}
                          </span>
                          <span className="font-mono">
                            {selectedRepository.full_name}
                          </span>
                        </InlineMeta>
                      ) : null}
                    </div>
                  </div>

                  {repos.length === 0 && !githubReposQuery.isLoading ? (
                    <EmptyState
                      icon={Github}
                      title={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line484JsxAttrTitleNoRepositoriesAvailable')}
                      description={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line485JsxAttrDescriptionUpdateTheGithubAppInstallationToGrantKortix')}
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

                  <div className="space-y-1.5">
                    <Label htmlFor="github-project-name">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line511JsxTextProjectName')}</Label>
                    <Input
                      id="github-project-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line516JsxAttrPlaceholderUseRepositoryName')}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
              <Button
                type="button"
                variant="ghost"
                onClick={resetAndClose}
                disabled={submitting || isConnectingGitHub}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="gap-1.5"
                disabled={
                  submitting ||
                  !accountId ||
                  !selectedInstallationId ||
                  !selectedRepo
                }
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Github className="h-4 w-4" />
                )}{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line549JsxTextImportRepo')}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
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
          id="github-repo"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-10 w-full justify-between gap-2 px-3 font-normal"
        >
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
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
      >
        <div className="border-b border-border/60 p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tHardcodedUi.raw('componentsProjectsProjectCreateModal.line623JsxAttrPlaceholderSearchRepositories')}
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
          />
        </div>
        {filteredRepos.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectCreateModal.line631JsxTextNoRepositoriesFound')}</div>
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
                  leading={
                    <Check
                      className={cn(
                        'h-4 w-4',
                        selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  }
                  title={<span className="font-mono">{repo.full_name}</span>}
                  badges={
                    repo.private ? (
                      <Badge variant="outline" size="sm">
                        Private
                      </Badge>
                    ) : null
                  }
                  subtitle={
                    <InlineMeta>
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
