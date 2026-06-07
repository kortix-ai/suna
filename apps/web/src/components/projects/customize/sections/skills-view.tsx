'use client';

import { useTranslations } from 'next-intl';

/**
 * Skills section — project skills browser (Customize overlay).
 *
 * Two-pane shape:
 *   • Left  — list column with search + group headers + selectable rows
 *   • Right — selected SKILL.md rendered as markdown (description + body)
 *
 * The repo at `<opencode_config_dir>/skills/<slug>/SKILL.md` is the
 * source of truth — `opencode_config_dir` comes from `[opencode]
 * config_dir` in kortix.toml and defaults to `.kortix/opencode`. Editing
 * happens by committing the file (or via the file viewer for now); the
 * Edit button in the detail toolbar is the future hook for inline editing.
 */

import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createFileTreeIconResolver,
  getBuiltInFileIconColor,
  getBuiltInSpriteSheet,
} from '@pierre/trees';
import {
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import type { Icon } from '@/components/ui/kortix-icons';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  FileContentRenderer,
  ProjectFilesProvider,
} from '@/features/project-files';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listProjectFiles,
  type ProjectConfigSummary,
  type ProjectFileEntry,
} from '@/lib/projects-client';
import {
  useConfigureThread,
  newConfigPrompt,
  editConfigPrompt,
} from '@/components/projects/customize/use-configure-thread';

type Skill = ProjectConfigSummary['skills'][number];
const pierreIconResolver = createFileTreeIconResolver('complete');
const pierreSpriteSheet = getBuiltInSpriteSheet('complete');

/* ─── Page entry ────────────────────────────────────────────────────────── */


export function SkillsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const defaultBranch = detailQuery.data?.project?.default_branch ?? '';
  const skills = useMemo(
    () => detailQuery.data?.config?.skills ?? [],
    [detailQuery.data?.config?.skills],
  );
  const isForbidden =
    detailQuery.isError &&
    /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  // Two cursors: which skill is selected (drives the inline-expanded tree),
  // and which file inside that skill is rendered in the right pane. Switching
  // skills resets the file cursor to the skill's SKILL.md so the right pane
  // always opens on the canonical doc.
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (skills.length === 0) return;
    if (selectedSkillPath && skills.some((s) => s.path === selectedSkillPath)) return;
    setSelectedSkillPath(skills[0].path);
    setSelectedFilePath(skills[0].path);
  }, [skills, selectedSkillPath]);

  const onPickSkill = (skill: Skill) => {
    setSelectedSkillPath(skill.path);
    setSelectedFilePath(skill.path);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [skills, query]);

  const selectedSkill = skills.find((s) => s.path === selectedSkillPath) ?? null;
  const activeFilePath = selectedFilePath ?? selectedSkill?.path ?? null;
  const configure = useConfigureThread(projectId);

  // ProjectFilesProvider supplies project + ref to the shared
  // <FileContentRenderer/> in the right pane, so we get the same file
  // rendering (syntax highlight, JSON tree, CSV, etc.) the /files page uses.
  // We wrap the whole view so the inline tree could later opt in too.
  return (
    <ProjectFilesProvider value={{ projectId, ref: defaultBranch }}>
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* ── List column (skills + inline file trees) ─────────────────── */}
      <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-b border-border/60 bg-background md:max-h-none md:w-[240px] md:border-b-0 md:border-r">
        <CustomizeSectionHeader
          icon={Sparkles}
          title="Skills"
          count={skills.length}
          actions={
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => configure.start(newConfigPrompt('skill'))}
              disabled={configure.pending}
            >
              {configure.pending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              New
            </Button>
          }
        />

        <div className="border-b border-border/40 px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line149JsxAttrPlaceholderSearchSkills')}
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
              message={(detailQuery.error as Error)?.message ?? 'Failed to load skills'}
              onRetry={() => detailQuery.refetch()}
            />
          ) : skills.length === 0 ? (
            <EmptyList
              icon={Sparkles}
              label={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line168JsxAttrLabelNoSkillsYet')}
              onCreate={() => configure.start(newConfigPrompt('skill'))}
              creating={configure.pending}
            />
          ) : filtered.length === 0 ? (
            <NoMatches query={query} />
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((skill) => (
                <li key={skill.path}>
                  <SkillListItem
                    projectId={projectId}
                    skill={skill}
                    expanded={selectedSkillPath === skill.path}
                    selectedFilePath={activeFilePath}
                    onPickSkill={() => onPickSkill(skill)}
                    onPickFile={setSelectedFilePath}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ── Detail column (selected file content) ──────────────────────
          min-h-0 + min-w-0 are load-bearing: without min-h-0 the inner
          scroll div can't shrink below its content, so the right pane
          never scrolls. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {selectedSkill && activeFilePath && defaultBranch ? (
          <SkillFileViewer
            projectId={projectId}
            skill={selectedSkill}
            selectedPath={activeFilePath}
          />
        ) : detailQuery.isLoading ? (
          <DetailSkeleton />
        ) : (
          <DetailEmpty />
        )}
      </section>
    </div>
    </ProjectFilesProvider>
  );
}

/* ─── List items (skill row + inline file tree) ─────────────────────────── */

function SkillListItem({
  projectId,
  skill,
  expanded,
  selectedFilePath,
  onPickSkill,
  onPickFile,
}: {
  projectId: string;
  skill: Skill;
  expanded: boolean;
  selectedFilePath: string | null;
  onPickSkill: () => void;
  onPickFile: (path: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onPickSkill}
        className={cn(
          'group flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left transition-colors',
          expanded
            ? 'bg-muted/70 text-foreground'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
        aria-expanded={expanded}
      >
        <span className="truncate text-sm font-medium">{skill.name}</span>
      </button>

      {expanded && (
        <InlineSkillTree
          projectId={projectId}
          skill={skill}
          selectedFilePath={selectedFilePath}
          onPickFile={onPickFile}
        />
      )}
    </div>
  );
}

function InlineSkillTree({
  projectId,
  skill,
  selectedFilePath,
  onPickFile,
}: {
  projectId: string;
  skill: Skill;
  selectedFilePath: string | null;
  onPickFile: (path: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const skillDir = useMemo(() => {
    const idx = skill.path.lastIndexOf('/');
    return idx > 0 ? skill.path.slice(0, idx) : skill.path;
  }, [skill.path]);

  const filesQuery = useQuery({
    queryKey: ['project-skill-files', projectId, skillDir],
    queryFn: () => listProjectFiles(projectId, { path: skillDir }),
    staleTime: 30_000,
  });

  const relativePaths = useMemo<readonly string[]>(() => {
    const fromApi = (filesQuery.data ?? [])
      .map((f: ProjectFileEntry) => f.path)
      .filter((p) => p === skill.path || p.startsWith(skillDir + '/'));
    // Always keep SKILL.md in the tree, even before the file listing lands.
    const ensured = fromApi.length > 0 ? fromApi : [skill.path];
    const seen = new Set<string>();
    const rels: string[] = [];
    for (const full of ensured) {
      const rel = full === skillDir ? '' : full.slice(skillDir.length + 1);
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        rels.push(rel);
      }
    }
    return rels;
  }, [filesQuery.data, skillDir, skill.path]);

  const treeRows = useMemo(() => buildInlineSkillRows(relativePaths), [relativePaths]);

  return (
    <div className="mt-1 pl-3 pr-1">
      <span
        className="pointer-events-none absolute h-0 w-0 overflow-hidden"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: pierreSpriteSheet }}
      />
      {filesQuery.isLoading && !filesQuery.data ? (
        <div className="space-y-1 py-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-5 rounded-md" />
          ))}
        </div>
      ) : filesQuery.isError ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line320JsxTextCouldnAposTLoadFiles')}</p>
      ) : (
        <div className="py-1">
            <div className="py-0.5">
              {treeRows.map((row) => {
                const fullPath = row.kind === 'file' ? `${skillDir}/${row.path}` : null;
                const selected = fullPath === selectedFilePath;
                return (
                  <button
                    key={row.path}
                    type="button"
                    disabled={row.kind === 'directory'}
                    onClick={() => {
                      if (fullPath) onPickFile(fullPath);
                    }}
                    className={cn(
                      'group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors',
                      row.kind === 'directory'
                        ? 'cursor-default text-muted-foreground/75'
                        : 'cursor-pointer text-muted-foreground hover:bg-muted/45 hover:text-foreground',
                      selected && 'bg-muted text-foreground',
                    )}
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                  >
                    <PierreTreeIcon
                      path={row.path}
                      kind={row.kind}
                      className={cn(
                        'h-4 w-4 shrink-0',
                        row.kind === 'directory' && 'text-muted-foreground/70',
                      )}
                    />
                    <span className="min-w-0 truncate">{row.name}</span>
                  </button>
                );
              })}
            </div>
        </div>
      )}
    </div>
  );
}

interface InlineSkillRow {
  depth: number;
  kind: 'directory' | 'file';
  name: string;
  path: string;
}

function buildInlineSkillRows(paths: readonly string[]): InlineSkillRow[] {
  const dirs = new Map<string, InlineSkillRow>();
  const files = new Map<string, InlineSkillRow>();
  for (const p of paths) {
    const parts = p.split('/');
    const fileName = parts.at(-1);
    if (!fileName) continue;
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      if (!dirs.has(path)) {
        dirs.set(path, {
          depth: i - 1,
          kind: 'directory',
          name: parts[i - 1]!,
          path,
        });
      }
    }
    files.set(p, {
      depth: parts.length - 1,
      kind: 'file',
      name: fileName,
      path: p,
    });
  }

  const allRows = [...dirs.values(), ...files.values()];
  allRows.sort((a, b) => {
    if (a.kind === 'file' && a.name === 'SKILL.md') return -1;
    if (b.kind === 'file' && b.name === 'SKILL.md') return 1;
    const parentA = parentPath(a.path);
    const parentB = parentPath(b.path);
    if (parentA === parentB && a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });
  return allRows;
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function PierreTreeIcon({
  path,
  kind,
  className,
}: {
  path: string;
  kind: InlineSkillRow['kind'];
  className?: string;
}) {
  const icon =
    kind === 'directory'
      ? pierreIconResolver.resolveIcon('file-tree-icon-chevron')
      : pierreIconResolver.resolveIcon('file-tree-icon-file', path);
  const color =
    kind === 'file' && icon.token
      ? getBuiltInFileIconColor(icon.token)
      : undefined;
  const name = icon.name.replace(/^#/, '');
  const width = icon.width ?? 16;
  const height = icon.height ?? 16;

  return (
    <svg
      aria-hidden="true"
      className={className}
      data-icon-name={icon.remappedFrom ?? icon.name}
      data-icon-token={icon.token}
      viewBox={icon.viewBox ?? `0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ color }}
    >
      <use href={`#${name}`} />
    </svg>
  );
}

/* ─── File viewer (right pane) ─────────────────────────────────────────── */

function SkillFileViewer({
  projectId,
  skill,
  selectedPath,
}: {
  projectId: string;
  skill: Skill;
  selectedPath: string;
}) {
  // Header (filename + path + actions) stays as ours so it matches the
  // rest of the customize chrome. The body delegates to the same
  // <FileContentRenderer/> that the /files page uses, which gives us
  // Markdown preview, syntax-highlighted code, JSON tree, CSV table,
  // image preview, etc. — for free, kept in sync with the file viewer.
  const fileName = selectedPath.split('/').pop() ?? selectedPath;
  const configure = useConfigureThread(projectId);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="truncate text-sm font-mono text-foreground">
          {fileName}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70">
          {selectedPath}
        </span>
        <DetailToolbarActions
          onEdit={() => configure.start(editConfigPrompt('skill', skill.name, skill.path))}
          editing={configure.pending}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* keyed on selectedPath so the renderer hard-resets when the
            user switches files — avoids stale state from the previous
            file's mode toggles bleeding into the next preview. */}
        <FileContentRenderer
          key={selectedPath}
          filePath={selectedPath}
          showHeader={false}
          readOnly
        />
      </div>
    </>
  );
}

function DetailToolbarActions({
  onEdit,
  editing,
}: {
  onEdit: () => void;
  editing: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
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
        Edit with agent
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <EmptyState
      icon={Sparkles}
      title={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line590JsxAttrTitleSelectASkill')}
      description={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line591JsxAttrDescriptionPickASkillMdFromTheListTo')}
    />
  );
}

function NoMatches({ query }: { query: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line600JsxTextNoMatchesFor')}{' '}
        <span className="font-mono text-foreground">{query}</span>.
      </p>
    </div>
  );
}

function EmptyList({
  icon,
  label,
  onCreate,
  creating,
}: {
  icon: Icon;
  label: string;
  onCreate: () => void;
  creating: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <EmptyState
      icon={icon}
      size="sm"
      title={label}
      description={
        <>{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line621JsxTextCommitA')}{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line623JsxTextKortixOpencodeSkillsLtSlugGtSkillMd')}</code>{' '}{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line625JsxTextAndItAposLlShowUpHere')}</>
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
            Create a skill
          </Button>
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <a
              href="https://opencode.ai/docs/skills/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-3 w-3" />
              Docs
            </a>
          </Button>
        </div>
      }
    />
  );
}

function ForbiddenNotice() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <InfoBanner icon={ShieldAlert} title={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line646JsxAttrTitleAccessRequired')}>{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line647JsxTextNoPermissionToReadThisRepo')}</InfoBanner>
  );
}

function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-4">
      <p className="text-sm font-medium text-destructive">{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line661JsxTextFailedToLoad')}</p>
      <p className="mt-1 text-xs text-destructive/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
