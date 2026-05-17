'use client';

/**
 * /projects/[id]/skills — Project skills browser.
 *
 * Two-pane shape:
 *   • Left  — list column with search + group headers + selectable rows
 *   • Right — selected SKILL.md rendered as markdown (description + body)
 *
 * The repo at `.opencode/skills/<slug>/SKILL.md` is the source of truth.
 * Editing happens by committing the file (or via the file viewer for now);
 * the Edit button in the detail toolbar is the future hook for inline
 * editing.
 */

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  FileText,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

function SkillsView({ projectId }: { projectId: string }) {
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
    <div className="flex h-full min-h-0">
      {/* ── List column (skills + inline file trees) ─────────────────── */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60 bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h1 className="flex-1 text-sm font-semibold text-foreground">Skills</h1>
          {skills.length > 0 && (
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {skills.length}
            </span>
          )}
        </div>

        <div className="border-b border-border/40 px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder="Search skills"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 rounded-md border-border/60 bg-background pl-7 text-[12.5px] placeholder:text-muted-foreground/60"
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
          'group flex w-full items-center rounded-md px-2 py-1.5 text-left transition-colors',
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

  const tree = useMemo(
    () => buildTree(filesQuery.data ?? [], skillDir, skill.path),
    [filesQuery.data, skillDir, skill.path],
  );

  // Indent so the tree's rows line up just below the skill row's text;
  // the border-left gives a subtle "this belongs to the row above" cue.
  return (
    <div className="ml-3 mt-0.5 border-l border-border/50 pl-1.5">
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
        <FileTreeNode
          node={tree}
          depth={0}
          selectedPath={selectedFilePath}
          onSelect={onPickFile}
        />
      )}
    </div>
  );
}

/* ─── File tree primitives ─────────────────────────────────────────────── */

interface TreeNode {
  /** Display name — file's basename or directory's segment. */
  name: string;
  /** Full repo-relative path (only set for files). */
  path: string | null;
  /** Children sorted: directories first then files, both alphabetical. */
  children: TreeNode[];
}

function buildTree(
  files: ProjectFileEntry[],
  rootDir: string,
  fallbackSkillPath?: string,
): TreeNode {
  const root: TreeNode = { name: '', path: null, children: [] };

  // The API can return paths from the whole repo if `path` is empty; filter
  // defensively to the skill dir even though we scope the fetch.
  const filtered = files
    .map((f) => f.path)
    .filter((p) => p === rootDir || p.startsWith(rootDir + '/'));

  // If the file fetch hasn't returned yet (or returned nothing), keep at
  // least the SKILL.md entry so the user always sees a clickable row.
  if (filtered.length === 0 && fallbackSkillPath) {
    filtered.push(fallbackSkillPath);
  }

  for (const fullPath of filtered) {
    const rel = fullPath.slice(rootDir.length + 1);
    if (!rel) continue;
    const segments = rel.split('/');
    let cursor = root;
    segments.forEach((seg, i) => {
      const isLeaf = i === segments.length - 1;
      let child = cursor.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: isLeaf ? fullPath : null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }

  sortNode(root);
  return root;
}

function sortNode(node: TreeNode) {
  node.children.sort((a, b) => {
    const aIsDir = a.path === null;
    const bIsDir = b.path === null;
    // SKILL.md pinned to top of its level.
    if (!aIsDir && a.name === 'SKILL.md') return -1;
    if (!bIsDir && b.name === 'SKILL.md') return 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1; // dirs first
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortNode(c);
}

function FileTreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Render only children — the root node is a virtual container with
  // empty name.
  return (
    <ul className="space-y-0.5">
      {node.children.map((child) => (
        <li key={child.name + (child.path ?? '')}>
          {child.path ? (
            <FileLeaf
              node={child}
              depth={depth}
              active={selectedPath === child.path}
              onSelect={() => onSelect(child.path!)}
            />
          ) : (
            <DirNode
              node={child}
              depth={depth}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function DirNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {/* Trailing slash is the only signal this is a directory — keeps the
            row aligned with file rows at the same depth. */}
        <span className="truncate text-[12px] font-medium">{node.name}/</span>
      </button>
      {open && (
        <FileTreeNode
          node={node}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

function FileLeaf({
  node,
  depth,
  active,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center rounded-md py-1 pr-2 text-left transition-colors',
        active
          ? 'bg-muted/70 text-foreground'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="truncate text-[12px]">{node.name}</span>
    </button>
  );
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
    <div className="flex h-full items-center justify-center">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border/60 bg-background">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          Select a skill
        </p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Pick a SKILL.md from the list to preview it.
        </p>
      </div>
    </div>
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
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="px-3 py-8 text-center">
      <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-background">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2.5 text-[12.5px] font-medium text-foreground">{label}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Commit a{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          .opencode/skills/&lt;slug&gt;/SKILL.md
        </code>{' '}
        and it&apos;ll show up here.
      </p>
      <Button asChild variant="ghost" size="sm" className="mt-3 gap-1.5">
        <a
          href="https://opencode.ai/docs/skills/"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink className="h-3 w-3" />
          OpenCode skills docs
        </a>
      </Button>
    </div>
  );
}

function ForbiddenNotice() {
  return (
    <div className="flex items-start gap-2 px-3 py-4">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="space-y-0.5 text-[11.5px]">
        <p className="font-medium text-foreground">Access required</p>
        <p className="text-muted-foreground">No permission to read this repo.</p>
      </div>
    </div>
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
      <p className="text-[12.5px] font-medium text-destructive">Failed to load</p>
      <p className="mt-1 text-[11px] text-destructive/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

