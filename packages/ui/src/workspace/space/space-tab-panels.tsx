'use client';

import { useState, type ReactNode } from 'react';

import { useQuery } from '@tanstack/react-query';

import {
  agentsInSpace,
  bindingSpace,
  listProjectDirectory,
  type ProjectSpace,
  type SpaceTab,
} from '@kortix/sdk';
import {
  qk,
  useAppAccess,
  useArtifact,
  useArtifacts,
  useFeatureFlag,
  useProjectApps,
  useProjectConfig,
  useProjectGoals,
} from '@kortix/sdk/react';
import { ArrowSquareOutIcon, FileTextIcon, FolderSimpleIcon } from '@phosphor-icons/react';

import { AppPreview } from '../../apps/app-preview';
import { appCan, appStatus } from '../../apps/app-shared';
import { useTranslations } from '../../i18n';
import { GoalHealthDot, goalHref } from '../../internal/goals/goal-meta';
import { useFilePreviewStore } from '../../internal/stores/file-preview-store';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { UiLink as Link } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { SpaceBlocks } from './space-blocks';
import { SpaceRoom } from './space-room';

/** Same sandbox as the Artifacts viewer: the content server's CSP decides the rest. */
const ARTIFACT_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** A tab's name: its `label`, else its target, else its type. */
export function useTabLabel(tab: SpaceTab): string {
  const t = useTranslations('spaces');
  if (tab.label?.trim()) return tab.label.trim();
  if (tab.type === 'app' && tab.app) return tab.app;
  if (tab.type === 'link' && tab.url) return hostOf(tab.url);
  if (tab.type === 'files' && tab.path) return tab.path.split('/').filter(Boolean).at(-1) ?? t('tabs.files');
  return t(`tabs.${tab.type}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The content of one tab; `tab` null is the room. */
export function SpaceTabPanel({
  projectId,
  space,
  tab,
}: {
  projectId: string;
  space: ProjectSpace;
  tab: SpaceTab | null;
}) {
  if (!tab) return <RoomTab projectId={projectId} space={space} />;
  switch (tab.type) {
    case 'goals':
      return <GoalsTab projectId={projectId} slug={space.name} />;
    case 'apps':
      return <AppsTab projectId={projectId} slug={space.name} />;
    case 'artifacts':
      return <ArtifactsTab projectId={projectId} slug={space.name} />;
    case 'files':
      return <FilesTab key={tab.path} projectId={projectId} root={tab.path ?? ''} />;
    case 'board':
      return <BoardTab projectId={projectId} tab={tab} />;
    case 'app':
      return <AppTab projectId={projectId} slug={tab.app ?? ''} />;
    case 'artifact':
      return <ArtifactTab projectId={projectId} artifactId={tab.artifact ?? ''} />;
    case 'link':
      return <LinkTab tab={tab} />;
  }
}

function RoomTab({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces');
  const rooms = useFeatureFlag(projectId, 'agent_rooms');
  if (!rooms.isLoading && !rooms.enabled) {
    return (
      <Centered>
        <EmptyState size="sm" title={t('roomsOff')} description={t('roomsOffHint')} />
      </Centered>
    );
  }
  return <SpaceRoom projectId={projectId} roomName={space.name} topic={space.description} fill className="h-full" />;
}

/** A list tab's frame: one column, the page rhythm. */
function ListFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 pb-20 md:px-8">{children}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-64 items-center justify-center px-4 py-8">{children}</div>;
}

function ViewAll({ href }: { href: string | null }) {
  const t = useTranslations('spaces');
  if (!href) return null;
  return (
    <div className="flex justify-end">
      <Button asChild size="sm" variant="ghost">
        <Link href={href}>{t('viewAll')}</Link>
      </Button>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="border-border divide-border flex flex-col divide-y rounded-md border">{children}</ul>;
}

function Row({ href, mark, meta, children }: { href: string | null; mark?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  const body = (
    <>
      {mark}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{children}</span>
      {meta ? <span className="text-muted-foreground shrink-0 text-xs">{meta}</span> : null}
    </>
  );
  const row = 'flex min-w-0 items-center gap-3 px-4 py-2.5';
  return (
    <li>
      {href ? (
        <Link href={href} className={cn(row, 'hover:bg-hover transition-colors')}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('spaces');
  return (
    <ErrorState
      size="sm"
      title={t('loadError')}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('retry')}
        </Button>
      }
    />
  );
}

const filtered = (href: string | null, slug: string) => (href ? `${href}?space=${encodeURIComponent(slug)}` : null);

function GoalsTab({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const agents = useProjectConfig(projectId)?.agents ?? [];
  const goals = useProjectGoals(projectId);
  const rows = (goals.data ?? []).filter((goal) => bindingSpace(goal.goal, agents) === slug);
  return (
    <ListFrame>
      {goals.isError ? (
        <Failed onRetry={() => goals.refetch()} />
      ) : goals.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('empty.goals')} />
      ) : (
        <>
          <Rows>
            {rows.map((goal) => (
              <Row key={`${goal.scope}/${goal.slug}`} href={goalHref(projectId, goal)} mark={<GoalHealthDot goal={goal} />}>
                {goal.goal?.objective ?? goal.slug}
              </Row>
            ))}
          </Rows>
          <ViewAll href={filtered(uiRoutes().goals(projectId), slug)} />
        </>
      )}
    </ListFrame>
  );
}

function AppsTab({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const tApps = useTranslations('hardcodedUi.i18nComplete');
  const agents = useProjectConfig(projectId)?.agents ?? [];
  const apps = useProjectApps(projectId);
  const appsHref = uiRoutes().apps(projectId);
  const rows = (apps.data ?? []).filter((app) => bindingSpace(app.display, agents) === slug);
  return (
    <ListFrame>
      {apps.isError ? (
        <Failed onRetry={() => apps.refetch()} />
      ) : apps.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('empty.apps')} />
      ) : (
        <Rows>
          {rows.map((app) => (
            <Row
              key={app.app_id}
              href={appsHref ? `${appsHref}?app=${encodeURIComponent(app.app_id)}` : null}
              mark={<span className={cn('inline-block size-2 shrink-0 rounded-full', appStatus(app, tApps).dot)} />}
              meta={appStatus(app, tApps).label}
            >
              {app.name}
            </Row>
          ))}
        </Rows>
      )}
    </ListFrame>
  );
}

function ArtifactsTab({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const agents = useProjectConfig(projectId)?.agents ?? [];
  const list = useArtifacts(projectId, { space: slug, agents: agentsInSpace(slug, agents), limit: 50 });
  const href = uiRoutes().artifacts(projectId);
  const rows = list.data ?? [];
  return (
    <ListFrame>
      {list.isError ? (
        <Failed onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('empty.artifacts')} />
      ) : (
        <>
          <Rows>
            {rows.map((artifact) => (
              <Row
                key={artifact.artifact_id}
                href={href ? `${href}/${artifact.artifact_id}` : null}
                mark={<FileTextIcon className="text-muted-foreground size-4 shrink-0" />}
                meta={artifact.type === 'doc' ? t('doc') : t('page')}
              >
                {artifact.title}
              </Row>
            ))}
          </Rows>
          <ViewAll href={filtered(href, slug)} />
        </>
      )}
    </ListFrame>
  );
}

/** One project folder: folders open in place, files open in the file viewer. */
function FilesTab({ projectId, root }: { projectId: string; root: string }) {
  const t = useTranslations('spaces');
  const clean = root.replace(/^\/+|\/+$/g, '');
  const [path, setPath] = useState(clean);
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const listing = useQuery({
    queryKey: [...qk.project.files(projectId), 'space-folder', path],
    queryFn: () => listProjectDirectory(projectId, { path: path || undefined }),
    retry: false,
  });
  const entries = [...(listing.data?.entries ?? [])].sort(
    (a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1),
  );
  const parent = path === clean ? null : path.split('/').slice(0, -1).join('/');
  const name = (entry: string) => entry.split('/').at(-1) ?? entry;
  return (
    <ListFrame>
      <p className="text-muted-foreground truncate font-mono text-xs">{path || '/'}</p>
      {listing.isError ? (
        <Failed onRetry={() => listing.refetch()} />
      ) : listing.isLoading ? (
        <LoadingRows />
      ) : (
        <Rows>
          {parent !== null ? (
            <FolderRow onOpen={() => setPath(parent)} icon={<FolderSimpleIcon className="text-muted-foreground size-4 shrink-0" />}>
              ..
            </FolderRow>
          ) : null}
          {entries.length === 0 ? (
            <li className="text-muted-foreground px-4 py-2.5 text-sm">{t('empty.folder')}</li>
          ) : (
            entries.map((entry) => (
              <FolderRow
                key={entry.path}
                onOpen={() => (entry.type === 'directory' ? setPath(entry.path) : openPreview(entry.path))}
                icon={
                  entry.type === 'directory' ? (
                    <FolderSimpleIcon className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
                  )
                }
              >
                {name(entry.path)}
              </FolderRow>
            ))
          )}
        </Rows>
      )}
    </ListFrame>
  );
}

function FolderRow({ onOpen, icon, children }: { onOpen: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-hover flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left transition-colors"
      >
        {icon}
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">{children}</span>
      </button>
    </li>
  );
}

function BoardTab({ projectId, tab }: { projectId: string; tab: SpaceTab }) {
  const t = useTranslations('spaces');
  const blocks = tab.blocks ?? [];
  if (!blocks.length) {
    return (
      <Centered>
        <EmptyState size="sm" title={t('empty.board')} description={t('empty.boardHint')} />
      </Centered>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl py-6 pb-20 md:px-4">
      <SpaceBlocks projectId={projectId} blocks={blocks} />
    </div>
  );
}

/** A pinned App, live and interactive, filling the tab. */
function AppTab({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const apps = useProjectApps(projectId);
  const app = apps.data?.find((candidate) => candidate.slug === slug);
  const live = !!app && !!app.active_deployment_id && appCan(app, 'preview') && app.viewer_can_access !== false;
  const access = useAppAccess(projectId, live && app ? app.app_id : null, { policy: false, session: live });
  if (apps.isLoading) return <Centered><Skeleton className="h-64 w-full max-w-4xl rounded-md" /></Centered>;
  if (!app) {
    return (
      <Centered>
        <EmptyState size="sm" title={t('missing.app', { slug })} />
      </Centered>
    );
  }
  return (
    <AppPreview
      app={app}
      url={access.session.data?.url ?? null}
      accessError={access.session.isError}
      interactive
      className="h-full"
    />
  );
}

/** A pinned Artifact, its current state in a sandboxed frame. */
function ArtifactTab({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const t = useTranslations('spaces');
  const artifact = useArtifact(projectId, artifactId);
  const href = uiRoutes().artifacts(projectId);
  if (artifact.isLoading) return <Centered><Skeleton className="h-64 w-full max-w-4xl rounded-md" /></Centered>;
  if (!artifact.data) {
    return (
      <Centered>
        <EmptyState size="sm" title={t('missing.artifact')} />
      </Centered>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2 md:px-8">
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{artifact.data.title}</span>
        {href ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`${href}/${artifact.data.artifact_id}`}>
              <ArrowSquareOutIcon />
              {t('openArtifact')}
            </Link>
          </Button>
        ) : null}
      </div>
      <iframe
        src={artifact.data.view_url}
        title={artifact.data.title}
        sandbox={ARTIFACT_SANDBOX}
        className="bg-background min-h-0 w-full flex-1"
      />
    </div>
  );
}

/** A link: embedded in a sandboxed frame, or a card that opens it. */
function LinkTab({ tab }: { tab: SpaceTab }) {
  const t = useTranslations('spaces');
  const url = tab.url ?? '';
  const safe = /^https?:\/\//i.test(url);
  if (safe && tab.embed) {
    return (
      <iframe
        src={url}
        title={tab.label || hostOf(url)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="bg-background h-full w-full"
      />
    );
  }
  return (
    <Centered>
      <EmptyState
        size="sm"
        title={tab.label || hostOf(url)}
        description={<span className="font-mono wrap-anywhere">{url}</span>}
        action={
          safe ? (
            <Button asChild size="sm" variant="outline">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ArrowSquareOutIcon />
                {t('openLink', { host: hostOf(url) })}
              </a>
            </Button>
          ) : null
        }
      />
    </Centered>
  );
}
