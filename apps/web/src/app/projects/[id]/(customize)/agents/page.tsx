'use client';

/**
 * /projects/[id]/agents — Project agents browser.
 *
 * Mirrors the Skills page two-pane shape:
 *   • Left  — agent list with search + selectable rows
 *   • Right — selected agent file rendered as markdown
 *
 * The repo at `<opencode_config_dir>/agents/<name>.md` is the source of
 * truth — `opencode_config_dir` comes from `[opencode] config_dir` in
 * kortix.toml and defaults to `.kortix/opencode`. The Edit button is the
 * future hook for inline editing.
 */

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Copy,
  ExternalLink,
  FileText,
  Pencil,
  Search,
  ShieldAlert,
  Star,
} from 'lucide-react';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  readProjectFile,
  type ProjectConfigSummary,
} from '@/lib/projects-client';

type Agent = ProjectConfigSummary['agents'][number];

/* ─── Page entry ────────────────────────────────────────────────────────── */

export default function ProjectAgentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <AgentsView projectId={projectId} />;
}

export function AgentsView({ projectId }: { projectId: string }) {
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const agents = detailQuery.data?.config?.agents ?? [];
  const defaultAgent = detailQuery.data?.config?.open_code_default_agent ?? null;
  const isForbidden =
    detailQuery.isError &&
    /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Auto-select first agent on first load — prefer the default agent if
  // we can identify it, otherwise the first in the list.
  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedPath && agents.some((a) => a.path === selectedPath)) return;
    const preferred =
      agents.find((a) => a.name === defaultAgent) ?? agents[0];
    setSelectedPath(preferred.path);
  }, [agents, defaultAgent, selectedPath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q) ?? false),
    );
  }, [agents, query]);

  const selected = agents.find((a) => a.path === selectedPath) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-b border-border/60 bg-background md:max-h-none md:w-[300px] md:border-b-0 md:border-r">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h1 className="flex-1 text-sm font-semibold text-foreground">Agents</h1>
          {agents.length > 0 && (
            <Badge variant="secondary" size="sm" className="tabular-nums">
              {agents.length}
            </Badge>
          )}
        </div>

        <div className="border-b border-border/40 px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder="Search agents"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-sm placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {detailQuery.isLoading ? (
            <ListSkeleton />
          ) : isForbidden ? (
            <ForbiddenNotice />
          ) : detailQuery.isError ? (
            <ErrorNotice
              message={(detailQuery.error as Error)?.message ?? 'Failed to load agents'}
              onRetry={() => detailQuery.refetch()}
            />
          ) : agents.length === 0 ? (
            <EmptyList />
          ) : filtered.length === 0 ? (
            <NoMatches query={query} />
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((agent) => (
                <li key={agent.path}>
                  <AgentRow
                    agent={agent}
                    isDefault={defaultAgent === agent.name}
                    active={selectedPath === agent.path}
                    onSelect={() => setSelectedPath(agent.path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        {selected ? (
          <AgentDetail
            projectId={projectId}
            agent={selected}
            isDefault={defaultAgent === selected.name}
          />
        ) : detailQuery.isLoading ? (
          <DetailSkeleton />
        ) : (
          <DetailEmpty />
        )}
      </section>
    </div>
  );
}

/* ─── List bits ─────────────────────────────────────────────────────────── */

function AgentRow({
  agent,
  isDefault,
  active,
  onSelect,
}: {
  agent: Agent;
  isDefault: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-muted/70 text-foreground'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
      )}
    >
      <span className="truncate text-sm font-medium">{agent.name}</span>
      {isDefault && (
        <Star
          className={cn(
            'ml-auto h-3 w-3 shrink-0 fill-current',
            active ? 'text-foreground' : 'text-muted-foreground/60',
          )}
        />
      )}
    </button>
  );
}

/* ─── Detail ────────────────────────────────────────────────────────────── */

function AgentDetail({
  projectId,
  agent,
  isDefault,
}: {
  projectId: string;
  agent: Agent;
  isDefault: boolean;
}) {
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, agent.path],
    queryFn: () => readProjectFile(projectId, agent.path),
    staleTime: 30_000,
  });

  const fileHref = `/projects/${projectId}/files?path=${encodeURIComponent(
    agent.path,
  )}`;
  const fileName = agent.path.split('/').pop() ?? agent.path;
  const modeLabel = agent.mode ? formatMode(agent.mode) : null;

  const onCopy = async () => {
    if (!fileQuery.data?.content) return;
    try {
      await navigator.clipboard.writeText(fileQuery.data.content);
      toast.success('Source copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  const { body } = useMemo(
    () => splitFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="truncate text-sm font-mono text-foreground">{fileName}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70">
          {agent.path}
        </span>
        <DetailToolbarActions
          onCopy={onCopy}
          fileHref={fileHref}
          copyDisabled={!fileQuery.data?.content}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
              Agent
              {modeLabel && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="font-medium normal-case tracking-normal text-muted-foreground"
                >
                  {modeLabel}
                </Badge>
              )}
              {isDefault && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="font-medium normal-case tracking-normal text-muted-foreground"
                >
                  <Star className="fill-current" />
                  Default
                </Badge>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {agent.name}
            </h1>
            {agent.description && (
              <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground">
                {agent.description}
              </p>
            )}
          </div>

          <div className="mt-8">
            {fileQuery.isLoading ? (
              <DetailBodySkeleton />
            ) : fileQuery.isError ? (
              <DetailError
                message={
                  (fileQuery.error as Error)?.message ??
                  'Failed to read agent source'
                }
                onRetry={() => fileQuery.refetch()}
              />
            ) : body.trim() ? (
              <UnifiedMarkdown content={body} />
            ) : (
              <p className="text-sm italic text-muted-foreground/60">
                Agent body is empty. Add prompt content below the frontmatter.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function DetailToolbarActions({
  onCopy,
  fileHref,
  copyDisabled,
}: {
  onCopy: () => void;
  fileHref: string;
  copyDisabled: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            disabled
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Inline editing coming soon
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onCopy}
            disabled={copyDisabled}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Copy source
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <Link href={fileHref}>
              <FileText className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Open in file viewer
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/* ─── Loading / empty / error ───────────────────────────────────────────── */

function ListSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-7 rounded-md" />
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <>
      <div className="h-12 border-b border-border/60" />
      <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-8">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80" />
        <div className="pt-6">
          <DetailBodySkeleton />
        </div>
      </div>
    </>
  );
}

function DetailBodySkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-10/12" />
      <Skeleton className="h-4 w-9/12" />
    </div>
  );
}

function DetailEmpty() {
  return (
    <EmptyState
      icon={Bot}
      title="Select an agent"
      description="Pick an agent from the list to preview it."
    />
  );
}

function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-xs text-muted-foreground">
        No matches for{' '}
        <span className="font-mono text-foreground">{query}</span>.
      </p>
    </div>
  );
}

function EmptyList() {
  return (
    <EmptyState
      icon={Bot}
      size="sm"
      title="No agents yet"
      description={
        <>
          Commit a{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            .kortix/opencode/agents/&lt;name&gt;.md
          </code>{' '}
          and it&apos;ll show up here.
        </>
      }
      action={
        <Button asChild variant="ghost" size="sm" className="gap-1.5">
          <a
            href="https://opencode.ai/docs/agents/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3 w-3" />
            OpenCode agents docs
          </a>
        </Button>
      }
    />
  );
}

function DetailError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <InfoBanner
      tone="destructive"
      title="Couldn't load source"
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </InfoBanner>
  );
}

function ForbiddenNotice() {
  return (
    <InfoBanner icon={ShieldAlert} title="Access required">
      No permission to read this repo.
    </InfoBanner>
  );
}

function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="px-3 py-4">
      <p className="text-sm font-medium text-destructive">Failed to load</p>
      <p className="mt-1 text-xs text-destructive/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  const afterTerminator = raw.slice(end + 4);
  return {
    frontmatter: raw.slice(3, end).replace(/^\n/, ''),
    body: afterTerminator.replace(/^\r?\n/, ''),
  };
}

function formatMode(mode: string): string {
  const m = mode.toLowerCase();
  if (m === 'primary') return 'Primary';
  if (m === 'subagent') return 'Subagent';
  return mode;
}
