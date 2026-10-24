'use client';

import type { ReactNode } from 'react';

import { agentsInSpace, bindingSpace, type ProjectDomain } from '@kortix/sdk';
import { useArtifacts, useFeatureFlag, useProjectApps, useProjectConfig, useProjectGoals } from '@kortix/sdk/react';

import { appStatus } from '../../apps/app-shared';
import { useTranslations } from '../../i18n';
import { GoalHealthDot, goalHref } from '../../internal/goals/goal-meta';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { useUiLink } from '../../providers/ui-provider';
import { SpaceBlocks } from './space-blocks';
import { SpaceRoom } from './space-room';

/** Items each "In this space" list shows before "View all". */
const RAIL_LIMIT = 5;

/**
 * The inside of a space, below the composer on the project home: the space's
 * room beside what is bound to the space (Goals, Apps, Artifacts), then the
 * space's agent-configurable blocks.
 *
 * A resource is in the space when its binding resolves there (`bindingSpace`:
 * its `space`, else its agent's space). Apps and Goals are complete lists and
 * filter here; Artifacts filter on the server, because that list is paged.
 * A `chat` block for the space's own room is not drawn twice.
 */
export function SpaceHome({ projectId, space }: { projectId: string; space: ProjectDomain }) {
  const slug = space.name;
  const config = useProjectConfig(projectId);
  const agents = config?.agents ?? [];
  const goalsOn = useFeatureFlag(projectId, 'goals').enabled;
  const artifactsOn = useFeatureFlag(projectId, 'artifacts').enabled;
  const roomsOn = useFeatureFlag(projectId, 'agent_rooms').enabled;
  const apps = useProjectApps(projectId);
  const goals = useProjectGoals(goalsOn ? projectId : null);
  const artifacts = useArtifacts(artifactsOn ? projectId : null, {
    space: slug,
    agents: agentsInSpace(slug, agents),
    limit: RAIL_LIMIT,
  });
  const tApps = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('spaces');

  const spaceApps = (apps.data ?? []).filter((app) => bindingSpace(app.display, agents) === slug);
  const spaceGoals = goalsOn ? (goals.data ?? []).filter((goal) => bindingSpace(goal.goal, agents) === slug) : [];
  const spaceArtifacts = artifactsOn ? (artifacts.data ?? []) : [];
  const blocks = (space.blocks ?? []).filter(
    (block) => !(block.type === 'chat' && (block.room?.trim() || slug) === slug),
  );
  const hasRail = spaceApps.length + spaceGoals.length + spaceArtifacts.length > 0;
  const goalsHref = uiRoutes().goals(projectId);
  const artifactsHref = uiRoutes().artifacts(projectId);
  const appsHref = uiRoutes().apps(projectId);
  const filtered = (href: string | null) => (href ? `${href}?space=${encodeURIComponent(slug)}` : null);

  return (
    <div className="flex w-full flex-col gap-4">
      {roomsOn || hasRail ? (
        <div
          className={cn('grid w-full items-start gap-4 px-4', roomsOn && hasRail && 'lg:grid-cols-[minmax(0,1fr)_15rem]')}
        >
          {roomsOn ? (
            <SpaceRoom projectId={projectId} roomName={slug} topic={space.description} className="min-w-0" />
          ) : null}
          {hasRail ? (
            <aside aria-label={t('inThisSpace')} className="flex min-w-0 flex-col gap-4">
              <RailList title={t('goals')} total={spaceGoals.length} href={filtered(goalsHref)}>
                {spaceGoals.slice(0, RAIL_LIMIT).map((goal) => (
                  <RailRow key={`${goal.scope}/${goal.slug}`} href={goalHref(projectId, goal)} mark={<GoalHealthDot goal={goal} />}>
                    {goal.goal?.objective ?? goal.slug}
                  </RailRow>
                ))}
              </RailList>
              {/* The Apps page has no space filter: "View all" opens the full list. */}
              <RailList title={t('apps')} total={spaceApps.length} href={appsHref}>
                {spaceApps.slice(0, RAIL_LIMIT).map((app) => (
                  <RailRow
                    key={app.app_id}
                    href={appsHref ? `${appsHref}?app=${encodeURIComponent(app.app_id)}` : null}
                    mark={<span className={cn('inline-block size-2 shrink-0 rounded-full', appStatus(app, tApps).dot)} />}
                  >
                    {app.name}
                  </RailRow>
                ))}
              </RailList>
              <RailList title={t('artifacts')} total={spaceArtifacts.length} href={filtered(artifactsHref)}>
                {spaceArtifacts.slice(0, RAIL_LIMIT).map((artifact) => (
                  <RailRow
                    key={artifact.artifact_id}
                    href={artifactsHref ? `${artifactsHref}/${artifact.artifact_id}` : null}
                    meta={artifact.type === 'doc' ? t('doc') : t('page')}
                  >
                    {artifact.title}
                  </RailRow>
                ))}
              </RailList>
            </aside>
          ) : null}
        </div>
      ) : null}
      {blocks.length ? <SpaceBlocks projectId={projectId} blocks={blocks} /> : null}
    </div>
  );
}

/** One "In this space" list: a muted title, "View all", and up to RAIL_LIMIT rows. Hidden when empty. */
function RailList({
  title,
  total,
  href,
  children,
}: {
  title: string;
  total: number;
  href: string | null;
  children: ReactNode;
}) {
  const Link = useUiLink();
  const t = useTranslations('spaces');
  if (total === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
        {href ? (
          <Link href={href} className="text-muted-foreground hover:text-foreground text-xs transition-colors">
            {t('viewAll')}
          </Link>
        ) : null}
      </div>
      <ul className="bg-background border-border divide-border flex flex-col divide-y rounded-md border">{children}</ul>
    </section>
  );
}

function RailRow({
  href,
  mark,
  meta,
  children,
}: {
  href: string | null;
  mark?: ReactNode;
  meta?: string;
  children: ReactNode;
}) {
  const Link = useUiLink();
  const body = (
    <>
      {mark}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{children}</span>
      {meta ? <span className="text-muted-foreground shrink-0 text-xs">{meta}</span> : null}
    </>
  );
  const row = 'flex min-w-0 items-center gap-2 px-3 py-2';
  return (
    <li>
      {href ? (
        <Link href={href} className={cn(row, 'hover:bg-muted/40 transition-colors')}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}
