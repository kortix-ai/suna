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

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Spinner as Loader2, Pencil, Plus, Search, Shield as ShieldAlert, Sparkles } from '@mynaui/icons-react';
import { useMemo, useState } from 'react';

import { buildFileTree, FileTree, FileTreeSprite } from '@/components/file-tree';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { MarketplaceSectionButton } from '@/components/projects/customize/marketplace-section-button';
import {
  editConfigPrompt,
  newConfigPrompt,
  useConfigureThread,
} from '@/components/projects/customize/use-configure-thread';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import type { Icon } from '@/components/ui/kortix-icons';
import { Skeleton } from '@/components/ui/skeleton';
import { FileContentRenderer, ProjectFilesProvider } from '@/features/project-files';
import {
  getProjectDetail,
  listProjectFiles,
  type ProjectConfigSummary,
} from '@/lib/projects-client';

type Skill = ProjectConfigSummary['skills'][number];

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
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

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
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set<string>());
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
        <aside className="border-border/60 bg-background flex max-h-[42vh] w-full shrink-0 flex-col border-b md:max-h-none md:w-[260px] md:border-r md:border-b-0">
          <CustomizeSectionHeader
            icon={Sparkles}
            title="Skills"
            count={skills.length}
            actions={
              <div className="flex items-center gap-1.5">
                <MarketplaceSectionButton projectId={projectId} />
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
              </div>
            }
          />

          <div className="border-border/40 border-b px-3 py-2.5">
            <div className="relative">
              <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
              <Input
                placeholder={tHardcodedUi.raw(
                  'appProjectsIdCustomizeSkillsPage.line149JsxAttrPlaceholderSearchSkills',
                )}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="placeholder:text-muted-foreground/60 h-8 pl-8 text-sm"
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
                label={tHardcodedUi.raw(
                  'appProjectsIdCustomizeSkillsPage.line168JsxAttrLabelNoSkillsYet',
                )}
                onCreate={() => configure.start(newConfigPrompt('skill'))}
                creating={configure.pending}
              />
            ) : tree.length === 0 ? (
              searching ? (
                <NoMatches query={query} />
              ) : (
                <ListSkeleton />
              )
            ) : (
              <>
                <FileTreeSprite />
                <FileTree
                  nodes={tree}
                  rootPath={skillsRoot ?? ''}
                  isExpanded={isExpanded}
                  onToggle={togglePath}
                  selectedPath={selectedFilePath}
                  onSelectFile={setSelectedFilePath}
                />
              </>
            )}
          </div>
        </aside>

        {/* ── Detail column (selected file content) ──────────────────────
          min-h-0 + min-w-0 are load-bearing: without min-h-0 the inner
          scroll div can't shrink below its content, so the right pane
          never scrolls. */}
        <section className="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
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

/* ─── Skills tree helpers ──────────────────────────────────────────────────
   The recursive tree itself lives in the shared `@/components/file-tree`
   module; these helpers stay here because they're skills-specific. */

/** The skills directory itself (`…/skills`), derived from a known skill path. */
function deriveSkillsRoot(skills: readonly Skill[]): string | null {
  const marker = '/skills/';
  for (const s of skills) {
    const idx = s.path.indexOf(marker);
    if (idx !== -1) return s.path.slice(0, idx + '/skills'.length);
  }
  return null;
}

/** The skill that owns a file (nearest ancestor dir holding a SKILL.md), used to
 *  scope the "Edit with agent" action. */
function findOwningSkill(skills: readonly Skill[], fullPath: string | null): Skill | null {
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
      <header className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-foreground truncate font-mono text-sm">{fileName}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-muted-foreground/70 min-w-0 flex-1 truncate font-mono text-xs">
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

function DetailToolbarActions({ onEdit, editing }: { onEdit: () => void; editing: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsSkillsViewJsxTextEditWithc3582225',
        )}
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
      icon={Sparkles}
      title={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line590JsxAttrTitleSelectASkill')}
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeSkillsPage.line591JsxAttrDescriptionPickASkillMdFromTheListTo',
      )}
    />
  );
}

function NoMatches({ query }: { query: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-muted-foreground text-xs">
        {tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line600JsxTextNoMatchesFor')}{' '}
        <span className="text-foreground font-mono">{query}</span>.
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <EmptyState
      icon={icon}
      size="sm"
      title={label}
      description={
        <>
          {tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line621JsxTextCommitA')}{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeSkillsPage.line623JsxTextKortixOpencodeSkillsLtSlugGtSkillMd',
            )}
          </code>{' '}
          {tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line625JsxTextAndItAposLlShowUpHere')}
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
              'autoComponentsProjectsCustomizeSectionsSkillsViewJsxTextCreateA722fbf3c',
            )}
          </Button>
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <a href="https://opencode.ai/docs/skills/" target="_blank" rel="noopener noreferrer">
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
      <InfoBanner
        icon={ShieldAlert}
        title={tHardcodedUi.raw(
          'appProjectsIdCustomizeSkillsPage.line646JsxAttrTitleAccessRequired',
        )}
      >
        {tHardcodedUi.raw(
          'appProjectsIdCustomizeSkillsPage.line647JsxTextNoPermissionToReadThisRepo',
        )}
      </InfoBanner>
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="px-3 py-4">
      <p className="text-destructive text-sm font-medium">
        {tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line661JsxTextFailedToLoad')}
      </p>
      <p className="text-destructive/80 mt-1 text-xs">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
