'use client';

/**
 * /projects/[id]/skills — Project skills browser.
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

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  FileText,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { FileTree, useFileTree } from '@pierre/trees/react';
import { FILE_TREE_DEFAULT_ITEM_HEIGHT, type FileTreeSortComparator } from '@pierre/trees';

type Skill = ProjectConfigSummary['skills'][number];

/* ─── Page entry ────────────────────────────────────────────────────────── */

export default function ProjectSkillsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <SkillsView projectId={projectId} />;
}

export function SkillsView({ projectId }: { projectId: string }) {
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const defaultBranch = detailQuery.data?.project?.default_branch ?? '';
  const skills = detailQuery.data?.config?.skills ?? [];
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

  // ProjectFilesProvider supplies project + ref to the shared
  // <FileContentRenderer/> in the right pane, so we get the same file
  // rendering (syntax highlight, JSON tree, CSV, etc.) the /files page uses.
  // We wrap the whole view so the inline tree could later opt in too.
  return (
    <ProjectFilesProvider value={{ projectId, ref: defaultBranch }}>
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* ── List column (skills + inline file trees) ─────────────────── */}
      <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-b border-border/60 bg-background md:max-h-none md:w-[300px] md:border-b-0 md:border-r">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h1 className="flex-1 text-sm font-semibold text-foreground">Skills</h1>
          {skills.length > 0 && (
            <Badge variant="secondary" size="sm" className="tabular-nums">
              {skills.length}
            </Badge>
          )}
        </div>

        <div className="border-b border-border/40 px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder="Search skills"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-[12.5px] placeholder:text-muted-foreground/60"
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
            <EmptyList icon={Sparkles} label="No skills yet" />
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
          'group flex w-full items-center rounded-lg px-2 py-1.5 text-left transition-colors',
          expanded
            ? 'bg-muted/70 text-foreground'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
        aria-expanded={expanded}
      >
        <span className="truncate text-[12.5px] font-medium">{skill.name}</span>
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

// SKILL.md pinned to the top of its directory level; otherwise fall through
// to Pierre's default ordering (directories first, then files alphabetically).
const skillSort: FileTreeSortComparator = (a, b) => {
  if (!a.isDirectory && a.basename === 'SKILL.md') return -1;
  if (!b.isDirectory && b.basename === 'SKILL.md') return 1;
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.basename.localeCompare(b.basename);
};

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
  const skillDir = useMemo(() => {
    const idx = skill.path.lastIndexOf('/');
    return idx > 0 ? skill.path.slice(0, idx) : skill.path;
  }, [skill.path]);

  const filesQuery = useQuery({
    queryKey: ['project-skill-files', projectId, skillDir],
    queryFn: () => listProjectFiles(projectId, { path: skillDir }),
    staleTime: 30_000,
  });

  // Paths fed to Pierre are skill-dir relative — that way the tree renders
  // with the skill folder as the (implicit) root, matching the previous UI.
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

  // Pierre's FileTree virtualizes, so the host must have an explicit height
  // for any row to actually paint. Skill folders are usually small (1–20
  // entries) — size to content, with a soft cap so a huge skill folder still
  // scrolls instead of pushing the rest of the page off-screen.
  const visibleRowEstimate = relativePaths.length + countParentDirs(relativePaths);
  const treeHeightPx = Math.min(
    Math.max(visibleRowEstimate, 1) * FILE_TREE_DEFAULT_ITEM_HEIGHT,
    320,
  );

  // `relativePaths` is captured in a ref so `onSelectionChange` (created once
  // when the model is created) can read the current list — otherwise it
  // closes over the empty initial array and rejects every click.
  const relativePathsRef = useRef<readonly string[]>(relativePaths);
  relativePathsRef.current = relativePaths;

  const { model } = useFileTree({
    paths: relativePaths,
    initialExpansion: 'open',
    sort: skillSort,
    onSelectionChange: (paths) => {
      const rel = paths[0];
      if (!rel) return;
      if (!relativePathsRef.current.includes(rel)) return;
      onPickFile(`${skillDir}/${rel}`);
    },
  });

  // CRITICAL: `useFileTree` creates the FileTree model ONCE on mount and
  // ignores options after that (verified in @pierre/trees source). When the
  // file listing resolves async, those new paths never reach the model —
  // `getItem(rel)` returns null and selection silently no-ops. Imperatively
  // syncing paths via `resetPaths()` is the only way to keep the model in
  // step with the React state.
  useEffect(() => {
    model.resetPaths(relativePaths);
  }, [relativePaths, model]);

  // Drive Pierre's selection from the parent's `selectedFilePath`. Runs after
  // the resetPaths effect above so the target path is guaranteed to exist
  // in the model before we ask it to select.
  useEffect(() => {
    const rel = selectedFilePath && selectedFilePath.startsWith(skillDir + '/')
      ? selectedFilePath.slice(skillDir.length + 1)
      : null;
    const current = model.getSelectedPaths()[0] ?? null;
    if (rel === current) return;
    if (current) model.getItem(current)?.deselect();
    if (rel && relativePaths.includes(rel)) {
      // `selectOnlyPath` is single-call select-and-replace, more robust than
      // deselect-then-select against intermediate render races.
      const handle = model.getItem(rel);
      if (handle) handle.select();
    }
  }, [selectedFilePath, skillDir, relativePaths, model]);

  // Pierre's tree reads `--trees-*-override` CSS vars to theme its shadow
  // root. Map them to our Tailwind tokens so the tree blends into the
  // customize panel: transparent background, muted text for idle rows, a
  // crisp `bg-muted` highlight on the selected row, and a beefier per-level
  // indent so nested files actually read as nested.
  const pierreBlendStyle: React.CSSProperties = {
    height: treeHeightPx,
    '--trees-bg-override': 'transparent',
    '--trees-bg-muted-override': 'transparent',
    '--trees-fg-override': 'hsl(var(--foreground))',
    '--trees-fg-muted-override': 'hsl(var(--muted-foreground))',
    '--trees-border-color-override': 'transparent',
    '--trees-selected-bg-override': 'hsl(var(--muted))',
    '--trees-selected-fg-override': 'hsl(var(--foreground))',
    '--trees-selected-focused-border-color-override': 'transparent',
    '--trees-accent-override': 'hsl(var(--primary))',
    // Layout — bump outer padding back to ~0 (we control it via wrapper) and
    // push per-level indent so children of a folder are visibly inset.
    '--trees-padding-inline-override': '0px',
    '--trees-level-gap-override': '14px',
    '--trees-item-padding-x-override': '8px',
  } as React.CSSProperties;

  return (
    <div className="mt-0.5 pl-3">
      {filesQuery.isLoading && !filesQuery.data ? (
        <div className="space-y-1 py-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-5 rounded-md" />
          ))}
        </div>
      ) : filesQuery.isError ? (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          Couldn&apos;t load files.
        </p>
      ) : (
        <FileTree model={model} style={pierreBlendStyle} />
      )}
    </div>
  );
}

/** Count unique ancestor directories implied by a set of relative file paths. */
function countParentDirs(paths: readonly string[]): number {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs.size;
}

/* ─── File viewer (right pane) ─────────────────────────────────────────── */

function SkillFileViewer({
  projectId,
  skill: _skill,
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
  const fileHref = `/projects/${projectId}/files?path=${encodeURIComponent(selectedPath)}`;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="truncate text-sm font-mono text-foreground">
          {fileName}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
          {selectedPath}
        </span>
        <DetailToolbarActions fileHref={fileHref} />
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
  fileHref,
}: {
  fileHref: string;
}) {
  // Copy / edit live inside the shared FileContentRenderer chrome (when
  // showHeader is enabled there). Here we only own the "deep link to the
  // file viewer" action, since the rest of the customize chrome shows it
  // consistently across sections.
  return (
    <div className="flex items-center gap-0.5">
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
        <TooltipContent side="bottom" className="text-[10px]">
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
      icon={Sparkles}
      title="Select a skill"
      description="Pick a SKILL.md from the list to preview it."
    />
  );
}

function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-[11.5px] text-muted-foreground">
        No matches for{' '}
        <span className="font-mono text-foreground">{query}</span>.
      </p>
    </div>
  );
}

function EmptyList({
  icon,
  label,
}: {
  icon: Icon;
  label: string;
}) {
  return (
    <EmptyState
      icon={icon}
      size="sm"
      title={label}
      description={
        <>
          Commit a{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
            .kortix/opencode/skills/&lt;slug&gt;/SKILL.md
          </code>{' '}
          and it&apos;ll show up here.
        </>
      }
      action={
        <Button asChild variant="ghost" size="sm" className="gap-1.5">
          <a
            href="https://opencode.ai/docs/skills/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3 w-3" />
            OpenCode skills docs
          </a>
        </Button>
      }
    />
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
      <p className="text-[12.5px] font-medium text-red-600 dark:text-red-400">Failed to load</p>
      <p className="mt-1 text-[11px] text-red-600/80 dark:text-red-400/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

