'use client';

import { useTranslations } from 'next-intl';

/**
 * Skills section — project skills browser (Customize overlay).
 *
 * Two-pane shape:
 *   • Left  — a real, recursive file tree of the skills directory
 *             (`<opencode_config_dir>/skills/`): folders, skills, and the files
 *             inside each skill, all rendered as one VS Code–style tree.
 *   • Right — the selected file rendered (SKILL.md as markdown, code with syntax
 *             highlighting, etc.) via the shared <FileContentRenderer/>.
 *
 * The repo is the source of truth — `opencode_config_dir` comes from `[opencode]
 * config_dir` in kortix.toml and defaults to `.kortix/opencode`. The tree starts
 * fully collapsed; nothing is auto-expanded. Editing happens via the agent
 * (the "Edit with agent" action) or by committing the file.
 */

import {
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createFileTreeIconResolver,
  getBuiltInFileIconColor,
  getBuiltInSpriteSheet,
} from '@pierre/trees';
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
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
  FileContentRenderer,
  ProjectFilesProvider,
} from '@/features/project-files';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listProjectFiles,
  type ProjectConfigSummary,
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

  // The tree is rooted at the skills directory (`<opencode>/skills`), derived
  // from any known skill's path.
  const skillsRoot = useMemo(() => deriveSkillsRoot(skills), [skills]);

  // One listing gives every file under the skills dir, recursively
  // (`git ls-tree -r`). Directories are synthesized from the path segments.
  const filesQuery = useQuery({
    queryKey: ['project-skill-tree', projectId, defaultBranch, skillsRoot],
    queryFn: () =>
      listProjectFiles(projectId, {
        path: skillsRoot ?? undefined,
        ref: defaultBranch || undefined,
      }),
    enabled: Boolean(skillsRoot),
    staleTime: 30_000,
  });

  // Right pane cursor + per-folder expand state. The tree opens fully collapsed
  // (empty set), so a fresh visit shows only the top-level skill folders.
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [query, setQuery] = useState('');

  const togglePath = (path: string) =>
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Paths relative to the skills root. Seed from the config's SKILL.md paths so
  // the skill folders show instantly, then enrich with the full listing.
  const relPaths = useMemo<string[]>(() => {
    if (!skillsRoot) return [];
    const prefix = `${skillsRoot}/`;
    const strip = (paths: readonly string[]) =>
      paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    const fromListing = strip((filesQuery.data ?? []).map((f) => f.path));
    if (fromListing.length > 0) return fromListing;
    return strip(skills.map((s) => s.path));
  }, [filesQuery.data, skills, skillsRoot]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const visiblePaths = useMemo(
    () => (searching ? relPaths.filter((p) => p.toLowerCase().includes(q)) : relPaths),
    [relPaths, searching, q],
  );
  const tree = useMemo(() => buildFileTree(visiblePaths), [visiblePaths]);

  // While searching, every directory in the (already match-filtered) tree opens
  // so matches are visible; otherwise honor the user's expand state.
  const isExpanded = (path: string) => (searching ? true : expandedPaths.has(path));

  const owningSkill = useMemo(
    () => findOwningSkill(skills, selectedFilePath),
    [skills, selectedFilePath],
  );
  const configure = useConfigureThread(projectId);

  return (
    <ProjectFilesProvider value={{ projectId, ref: defaultBranch }}>
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* ── File tree column ─────────────────────────────────────────── */}
      <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-b border-border/60 bg-background md:max-h-none md:w-[260px] md:border-b-0 md:border-r">
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

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
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
          ) : tree.length === 0 ? (
            searching ? <NoMatches query={query} /> : <ListSkeleton />
          ) : (
            <>
              {/* Pierre sprite sheet — the source for the file-type icons. */}
              <span
                className="pointer-events-none absolute h-0 w-0 overflow-hidden"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: pierreSpriteSheet }}
              />
              {tree.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  skillsRoot={skillsRoot ?? ''}
                  isExpanded={isExpanded}
                  onToggle={togglePath}
                  selectedFilePath={selectedFilePath}
                  onSelectFile={setSelectedFilePath}
                />
              ))}
            </>
          )}
        </div>
      </aside>

      {/* ── Detail column (selected file content) ──────────────────────
          min-h-0 + min-w-0 are load-bearing: without min-h-0 the inner
          scroll div can't shrink below its content, so the right pane
          never scrolls. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {selectedFilePath && defaultBranch ? (
          <SkillFileViewer
            projectId={projectId}
            skill={owningSkill}
            selectedPath={selectedFilePath}
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

/* ─── File tree ──────────────────────────────────────────────────────────────
   A genuine recursive file tree of the skills directory. Every node is either a
   directory (synthesized from path segments) or a file. One row shape — indent
   rails, then [chevron | spacer] · icon · label — so folders, skills, and the
   files within them all line up in a single column, VS Code style. */

interface FileNode {
  name: string;
  /** Path relative to the skills root (also the unique key). */
  path: string;
  isDir: boolean;
  children: FileNode[];
}

/** The skills directory itself (`…/skills`), derived from a known skill path. */
function deriveSkillsRoot(skills: readonly Skill[]): string | null {
  const marker = '/skills/';
  for (const s of skills) {
    const idx = s.path.indexOf(marker);
    if (idx !== -1) return s.path.slice(0, idx + '/skills'.length);
  }
  return null;
}

function buildFileTree(relPaths: readonly string[]): FileNode[] {
  const roots: FileNode[] = [];
  const byPath = new Map<string, FileNode>();
  for (const rel of relPaths) {
    const parts = rel.split('/').filter(Boolean);
    let siblings = roots;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: parts[i]!, path: prefix, isDir: !isFile, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  sortNodes(roots);
  return roots;
}

function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    // SKILL.md floats to the top of its folder as the canonical doc.
    if (!a.isDir && a.name === 'SKILL.md') return -1;
    if (!b.isDir && b.name === 'SKILL.md') return 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.isDir) sortNodes(node.children);
}

/** The skill that owns a file (nearest ancestor dir holding a SKILL.md), used to
 *  scope the "Edit with agent" action. */
function findOwningSkill(
  skills: readonly Skill[],
  fullPath: string | null,
): Skill | null {
  if (!fullPath) return null;
  let best: Skill | null = null;
  let bestLen = -1;
  for (const s of skills) {
    const dir = s.path.slice(0, s.path.lastIndexOf('/'));
    if ((fullPath === s.path || fullPath.startsWith(`${dir}/`)) && dir.length > bestLen) {
      best = s;
      bestLen = dir.length;
    }
  }
  return best;
}

function FileTreeNode({
  node,
  depth,
  skillsRoot,
  isExpanded,
  onToggle,
  selectedFilePath,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  skillsRoot: string;
  isExpanded: (path: string) => boolean;
  onToggle: (path: string) => void;
  selectedFilePath: string | null;
  onSelectFile: (fullPath: string) => void;
}) {
  if (!node.isDir) {
    const fullPath = `${skillsRoot}/${node.path}`;
    return (
      <TreeRow
        depth={depth}
        selected={fullPath === selectedFilePath}
        onClick={() => onSelectFile(fullPath)}
      >
        <TreeRowSpacer />
        <PierreFileIcon path={node.name} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </TreeRow>
    );
  }

  const open = isExpanded(node.path);
  return (
    <>
      <TreeRow depth={depth} ariaExpanded={open} onClick={() => onToggle(node.path)}>
        <TreeChevron open={open} />
        {open ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </TreeRow>
      {open &&
        node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            skillsRoot={skillsRoot}
            isExpanded={isExpanded}
            onToggle={onToggle}
            selectedFilePath={selectedFilePath}
            onSelectFile={onSelectFile}
          />
        ))}
    </>
  );
}

/* ─── Shared tree-row primitives ─────────────────────────────────────────────
   Full-bleed, flush rows so the indent rails read as continuous verticals;
   indent grows 16px per level; selection is a tinted-primary bar, never a flat
   grey fill (design-system rule). */

const INDENT_STEP = 16; // px per nesting level — matches the project file tree
const GUTTER = 8; // px before the first chevron at the root

/** Faint vertical indent guides, one hairline per ancestor level — the way VS
 *  Code draws them. Root rows (depth 0) get none, just the gutter. */
function TreeGuides({ depth }: { depth: number }) {
  return (
    <span
      className="flex shrink-0 self-stretch"
      style={{ paddingLeft: GUTTER }}
      aria-hidden="true"
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="shrink-0 self-stretch border-l border-border/50"
          style={{ width: INDENT_STEP }}
        />
      ))}
    </span>
  );
}

/** Disclosure chevron for expandable rows. */
function TreeChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-fast',
        open && 'rotate-90',
      )}
    />
  );
}

/** A chevron-width spacer so files keep their icon aligned under folder icons. */
function TreeRowSpacer() {
  return <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
}

/** The shared row: full-bleed, fixed-height, indent rails on the left, then a
 *  gapped [chevron | spacer] · icon · label cluster. */
function TreeRow({
  depth,
  selected,
  ariaExpanded,
  onClick,
  children,
}: {
  depth: number;
  selected?: boolean;
  ariaExpanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      className={cn(
        'group flex h-7 w-full cursor-pointer items-center text-left text-sm transition-colors duration-fast',
        selected
          ? 'bg-primary/[0.08] text-primary'
          : 'text-foreground/80 hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {/* TreeGuides always emits the left gutter (plus a rail per level), so the
          content cluster never adds its own left padding. */}
      <TreeGuides depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
        {children}
      </span>
    </button>
  );
}

/** A file-type icon from Pierre's sprite sheet (colored per extension). */
function PierreFileIcon({ path, className }: { path: string; className?: string }) {
  const icon = pierreIconResolver.resolveIcon('file-tree-icon-file', path);
  const color = icon.token ? getBuiltInFileIconColor(icon.token) : undefined;
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
  skill: Skill | null;
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
        {skill && (
          <DetailToolbarActions
            onEdit={() => configure.start(editConfigPrompt('skill', skill.name, skill.path))}
            editing={configure.pending}
          />
        )}
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
    <div className="space-y-1 px-2">
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
    <div className="px-2">
      <InfoBanner icon={ShieldAlert} title={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line646JsxAttrTitleAccessRequired')}>{tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line647JsxTextNoPermissionToReadThisRepo')}</InfoBanner>
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
