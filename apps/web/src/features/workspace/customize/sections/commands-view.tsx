'use client';

import { useTranslations } from 'next-intl';

/**
 * Commands section — project slash commands browser (Customize overlay).
 *
 * Same two-pane shape as Skills and Agents. Commands live at
 * `.opencode/command/<slug>.md` (or `commands/`); the body is the prompt
 * the agent runs when the user invokes `/<slug>`.
 */

import { useQuery } from '@tanstack/react-query';
import {
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { UnifiedMarkdown } from '@/components/markdown';
import { CustomizeSectionHeader } from '@/features/workspace/customize/customize-section-header';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import {
  editConfigPrompt,
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getProjectDetail,
  readProjectFile,
  type ProjectConfigSummary,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Command = ProjectConfigSummary['commands'][number];

export function CommandsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const commands = detailQuery.data?.config?.commands ?? [];
  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (commands.length === 0) return;
    if (selectedPath && commands.some((c) => c.path === selectedPath)) return;
    setSelectedPath(commands[0].path);
  }, [commands, selectedPath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  const selected = commands.find((c) => c.path === selectedPath) ?? null;
  const configure = useConfigureThread(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="border-border/60 bg-background flex max-h-[42vh] w-full shrink-0 flex-col border-b md:max-h-none md:w-[240px] md:border-r md:border-b-0">
        <CustomizeSectionHeader
          icon={TerminalSquare}
          title="Commands"
          count={commands.length}
          actions={
            <div className="flex items-center gap-1.5">
              <MarketplaceSectionButton projectId={projectId} />
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => configure.start(newConfigPrompt('command'))}
                disabled={configure.pending}
              >
                {configure.pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                New
              </Button>
            </div>
          }
        />

        <div className="border-border/40 border-b px-3 py-2.5">
          <div className="relative">
            <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              placeholder={tHardcodedUi.raw(
                'appProjectsIdCustomizeCommandsPage.line107JsxAttrPlaceholderSearchCommands',
              )}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="placeholder:text-muted-foreground/60 h-8 pl-8 text-sm"
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
              message={(detailQuery.error as Error)?.message ?? 'Failed to load'}
              onRetry={() => detailQuery.refetch()}
            />
          ) : commands.length === 0 ? (
            <EmptyList
              onCreate={() => configure.start(newConfigPrompt('command'))}
              creating={configure.pending}
            />
          ) : filtered.length === 0 ? (
            <NoMatches query={query} />
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((cmd) => (
                <li key={cmd.path}>
                  <CommandRow
                    command={cmd}
                    active={selectedPath === cmd.path}
                    onSelect={() => setSelectedPath(cmd.path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="bg-background flex min-w-0 flex-1 flex-col">
        {selected ? (
          <CommandDetail projectId={projectId} command={selected} />
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

function CommandRow({
  command,
  active,
  onSelect,
}: {
  command: Command;
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
      <span
        className={cn(
          'inline-flex h-4 min-w-[1rem] items-center justify-center rounded font-mono text-xs font-medium',
          active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground/80',
        )}
        aria-hidden
      >
        /
      </span>
      <span className="truncate text-sm font-medium">{command.name}</span>
    </button>
  );
}

/* ─── Detail ────────────────────────────────────────────────────────────── */

function CommandDetail({ projectId, command }: { projectId: string; command: Command }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, command.path],
    queryFn: () => readProjectFile(projectId, command.path),
    staleTime: 30_000,
  });

  const fileName = command.path.split('/').pop() ?? command.path;

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
      <header className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-foreground truncate font-mono text-sm">{fileName}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-muted-foreground/70 min-w-0 flex-1 truncate font-mono text-xs">
          {command.path}
        </span>
        <DetailToolbarActions
          onCopy={onCopy}
          onEdit={() => configure.start(editConfigPrompt('command', command.name, command.path))}
          editing={configure.pending}
          copyDisabled={!fileQuery.data?.content}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          <div className="space-y-2">
            <div className="text-muted-foreground/60 text-xs font-medium tracking-wide uppercase">
              Command
            </div>
            <h1 className="text-foreground flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="text-muted-foreground/40">/</span>
              <span>{command.name}</span>
            </h1>
            {command.description && (
              <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
                {command.description}
              </p>
            )}
          </div>

          <div className="mt-8">
            {fileQuery.isLoading ? (
              <DetailBodySkeleton />
            ) : fileQuery.isError ? (
              <DetailError
                message={(fileQuery.error as Error)?.message ?? 'Failed to read command source'}
                onRetry={() => fileQuery.refetch()}
              />
            ) : body.trim() ? (
              <UnifiedMarkdown content={body} />
            ) : (
              <p className="text-muted-foreground/60 text-sm italic">
                {tHardcodedUi.raw(
                  'appProjectsIdCustomizeCommandsPage.line276JsxTextCommandBodyIsEmptyAddThePromptContent',
                )}
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
  onEdit,
  editing,
  copyDisabled,
}: {
  onCopy: () => void;
  onEdit: () => void;
  editing: boolean;
  copyDisabled: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-7 w-7"
            onClick={onCopy}
            disabled={copyDisabled}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line326JsxTextCopySource')}
        </TooltipContent>
      </Tooltip>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        onClick={onEdit}
        disabled={editing}
      >
        {editing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Pencil className="h-3.5 w-3.5" />
        )}
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsCommandsViewJsxTextEditWithec0f2ca8',
        )}
      </Button>
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
      <div className="border-border/60 h-12 border-b" />
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <EmptyState
      icon={TerminalSquare}
      title={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line393JsxAttrTitleSelectACommand',
      )}
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line394JsxAttrDescriptionPickACommandFromTheListToPreview',
      )}
    />
  );
}

function NoMatches({ query }: { query: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-muted-foreground text-xs">
        {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line403JsxTextNoMatchesFor')}{' '}
        <span className="text-foreground font-mono">{query}</span>.
      </p>
    </div>
  );
}

function EmptyList({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <EmptyState
      icon={TerminalSquare}
      size="sm"
      title={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line415JsxAttrTitleNoCommandsYet',
      )}
      description={
        <>
          {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line418JsxTextCommitA')}{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeCommandsPage.line420JsxTextOpencodeCommandLtSlugGtMd',
            )}
          </code>{' '}
          {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line422JsxTextToAddASlashCommand')}
        </>
      }
      action={
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onCreate}
            disabled={creating}
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsCommandsViewJsxTextCreateA28cc596f',
            )}
          </Button>
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <a href="https://opencode.ai/docs/commands/" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Docs
            </a>
          </Button>
        </div>
      }
    />
  );
}

function DetailError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <InfoBanner
      tone="destructive"
      title={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line451JsxAttrTitleCouldnTLoadSource',
      )}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <InfoBanner
      icon={ShieldAlert}
      title={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line465JsxAttrTitleAccessRequired',
      )}
    >
      {tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line466JsxTextNoPermissionToReadThisRepo',
      )}
    </InfoBanner>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-4">
      <p className="text-destructive text-sm font-medium">
        {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line480JsxTextFailedToLoad')}
      </p>
      <p className="text-destructive/80 mt-1 text-xs">{message}</p>
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
