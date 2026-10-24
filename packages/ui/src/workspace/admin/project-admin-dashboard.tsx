'use client';

/**
 * /projects/[id]/admin — the project's wp-admin-style overview.
 *
 * Kortix configuration is agent-centric: authorization is a per-agent grant on
 * the agent's `scope`, so a standalone connector, secret, skill, model, trigger
 * or reminder is inert until an agent is granted it. The day-to-day flow
 * (Customize) is organised around the agent; this dashboard is the OTHER view:
 * a full-project inventory where a manager SEES every resource at once.
 *
 * Read-only on purpose. Each section lists its resource with the few facts that
 * identify it, and links to the capability page that already owns the edit UI
 * (`capabilityLinkHref`, `agentHref`, `remindersHref`, `reviewHref`). Nothing
 * here mutates; nothing here is a second editor.
 *
 * Every section reads the SAME React Query entry its capability page reads
 * (`useProjectConfig`, `useProjectTriggers`, `useProjectReminders`,
 * `useProjectSecrets`, `useReviewSummary`, `qk.project.connectors`), so the two
 * surfaces can never disagree about what a project holds.
 *
 * Gated on `project.settings.write` (`PROJECT_SETTINGS_WRITE`): this is the
 * project-admin view, not a member surface. A viewer without it gets a plain
 * access message, never a page of 403s.
 */

import type { ComponentType, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  listConnectors,
  type AdminConnector,
  type ProjectTrigger,
  type ProjectReminder,
  type ProjectSecret,
} from '@kortix/sdk';
import {
  contract,
  qk,
  useProjectConfig,
  useProjectModels,
  useProjectReminders,
  useProjectSecrets,
  useProjectTriggers,
  useReviewSummary,
} from '@kortix/sdk/react';
import {
  ArrowRightIcon,
  BellIcon,
  ClockIcon,
  CpuIcon,
  KeyIcon,
  LockKeyIcon,
  PlugIcon,
  RobotIcon,
  SparkleIcon,
  TrayIcon,
} from '@phosphor-icons/react';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../../customize/shared/capability-page-shell';
import {
  agentHref,
  capabilityLinkHref,
  remindersHref,
  reviewHref,
  type CapabilityTab,
} from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan, type CanResult } from '../../internal/lib/use-project-can';

/** How many rows a section shows before it defers to "View all N". */
const MAX_ROWS = 6;

/** A verdict the engine actually returned — not a probe in flight or an error. */
function deniedAccess(result: CanResult): boolean {
  return !result.isLoading && !result.isError && !result.allowed;
}

export function ProjectAdminDashboard({ projectId }: { projectId: string }) {
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);

  if (deniedAccess(canAdmin)) {
    return (
      <CapabilityPageShell
        title="Admin"
        description="A full-project overview of every resource."
      >
        <div className="bg-popover flex flex-col items-center gap-2 rounded-md border px-4 py-16 text-center">
          <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-md">
            <LockKeyIcon className="size-5" />
          </span>
          <h2 className="text-foreground text-sm font-medium">You don&apos;t have access</h2>
          <p className="text-muted-foreground max-w-sm text-sm text-balance">
            The admin overview needs the project settings permission. Ask a project manager
            to grant it.
          </p>
        </div>
      </CapabilityPageShell>
    );
  }

  return (
    <CapabilityPageShell
      title="Admin"
      description="A full-project overview of every resource an agent can be granted."
      wide
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AgentsSection projectId={projectId} />
        <SkillsSection projectId={projectId} />
        <ConnectorsSection projectId={projectId} />
        <TriggersSection projectId={projectId} />
        <RemindersSection projectId={projectId} />
        <ModelsSection projectId={projectId} />
        <SecretsSection projectId={projectId} />
        <ReviewSection projectId={projectId} />
      </div>
    </CapabilityPageShell>
  );
}

/* ------------------------------------------------------------------ frame */

interface ResourceCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** The capability page that owns editing this resource. Null = host serves
   *  no customize pages; the Manage link is then omitted. */
  href: string | null;
  /** Total resources, shown as the count beside the title. Undefined = still
   *  loading. */
  count: number | undefined;
  children: ReactNode;
}

/** One dashboard widget: a flush bordered panel with a header seam and a body.
 *  Hand-composed (not `Card`) so the header and the list sit edge-to-edge with
 *  one hairline between them — the sanctioned panel-with-flush-child pattern. */
function ResourceCard({ icon: Icon, title, href, count, children }: ResourceCardProps) {
  return (
    <section className="bg-popover flex flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-4" />
        </span>
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        {count !== undefined ? <CountBadge count={count} /> : null}
        {href ? (
          <Button asChild variant="ghost" size="sm" className="ml-auto gap-1">
            <Link href={href}>
              Manage
              <ArrowRightIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** The body state machine shared by every list section. */
function CardBody({
  isLoading,
  isError,
  onRetry,
  isEmpty,
  emptyLabel,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
  isEmpty: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 px-4 py-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-4 py-6">
        <ErrorState
          size="sm"
          title="Couldn't load"
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (isEmpty) {
    return <p className="text-muted-foreground px-4 py-4 text-xs">{emptyLabel}</p>;
  }
  return <ul className="py-1.5">{children}</ul>;
}

/** One list row: a name, muted supporting text, and trailing meta (a badge).
 *  A link when `rowHref` is set, inert text otherwise. */
function ResourceRow({
  rowHref,
  name,
  meta,
  trailing,
}: {
  rowHref?: string | null;
  name: string;
  meta?: string | null;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-foreground truncate text-sm">{name}</span>
        {meta ? (
          <span className="text-muted-foreground truncate text-xs">{meta}</span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );
  if (rowHref) {
    return (
      <li>
        <Link
          href={rowHref}
          className="hover:bg-muted-foreground/5 duration-fast flex items-center gap-2 rounded-md px-4 py-1.5 transition-colors"
        >
          {body}
        </Link>
      </li>
    );
  }
  return <li className="flex items-center gap-2 px-4 py-1.5">{body}</li>;
}

/** "View all N" footer when a resource has more rows than the card shows. */
function MoreRow({ moreHref, hidden }: { moreHref: string | null; hidden: number }) {
  if (hidden <= 0) return null;
  const label = `View all (+${hidden} more)`;
  if (!moreHref) return <li className="text-muted-foreground px-4 py-1.5 text-xs">{label}</li>;
  return (
    <li>
      <Link
        href={moreHref}
        className="text-muted-foreground hover:text-foreground duration-fast block px-4 py-1.5 text-xs transition-colors"
      >
        {label}
      </Link>
    </li>
  );
}

function capHref(projectId: string, key: CapabilityTab['key']): string | null {
  return capabilityLinkHref(projectId, key);
}

/* --------------------------------------------------------------- sections */

function AgentsSection({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const agents = (config?.agents ?? []).filter((a) => !a.hidden);
  const link = capHref(projectId, 'agent');
  return (
    <ResourceCard icon={RobotIcon} title="Agents" href={link} count={config ? agents.length : undefined}>
      <CardBody
        isLoading={!config}
        isError={false}
        isEmpty={agents.length === 0}
        emptyLabel="No agents declared yet."
      >
        {agents.slice(0, MAX_ROWS).map((a) => (
          <ResourceRow
            key={a.name}
            rowHref={agentHref(projectId, a.name)}
            name={a.name}
            meta={a.model ?? a.description ?? undefined}
            trailing={a.platform ? <Badge variant="outline" size="xs">Platform</Badge> : undefined}
          />
        ))}
        <MoreRow moreHref={link} hidden={agents.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

function SkillsSection({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const skills = config?.skills ?? [];
  const link = capHref(projectId, 'skills');
  return (
    <ResourceCard icon={SparkleIcon} title="Skills" href={link} count={config ? skills.length : undefined}>
      <CardBody
        isLoading={!config}
        isError={false}
        isEmpty={skills.length === 0}
        emptyLabel="No skills in this project yet."
      >
        {skills.slice(0, MAX_ROWS).map((s) => (
          <ResourceRow key={s.path} rowHref={link} name={s.name} meta={s.description ?? undefined} />
        ))}
        <MoreRow moreHref={link} hidden={skills.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

const CONNECTOR_STATUS: Record<
  AdminConnector['status'],
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' }
> = {
  active: { label: 'Active', variant: 'success' },
  needs_auth: { label: 'Needs auth', variant: 'warning' },
  disabled: { label: 'Disabled', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
};

function ConnectorsSection({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const connectors = query.data?.connectors ?? [];
  const link = capHref(projectId, 'connectors');
  return (
    <ResourceCard
      icon={PlugIcon}
      title="Connectors"
      href={link}
      count={query.isLoading ? undefined : connectors.length}
    >
      <CardBody
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => query.refetch()}
        isEmpty={connectors.length === 0}
        emptyLabel="No connectors configured yet."
      >
        {connectors.slice(0, MAX_ROWS).map((c) => {
          const status = CONNECTOR_STATUS[c.status];
          return (
            <ResourceRow
              key={c.slug}
              rowHref={link}
              name={c.name}
              meta={c.provider}
              trailing={<Badge variant={status.variant} size="xs">{status.label}</Badge>}
            />
          );
        })}
        <MoreRow moreHref={link} hidden={connectors.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

function triggerMeta(t: ProjectTrigger): string {
  if (t.type === 'cron') return t.cron ? `cron · ${t.cron}` : 'schedule';
  return t.type;
}

function TriggersSection({ projectId }: { projectId: string }) {
  const query = useProjectTriggers(projectId);
  const triggers = query.data?.triggers ?? [];
  const link = capHref(projectId, 'triggers');
  return (
    <ResourceCard
      icon={ClockIcon}
      title="Triggers"
      href={link}
      count={query.isLoading ? undefined : triggers.length}
    >
      <CardBody
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => query.refetch()}
        isEmpty={triggers.length === 0}
        emptyLabel="No triggers defined yet."
      >
        {triggers.slice(0, MAX_ROWS).map((t) => (
          <ResourceRow
            key={t.slug}
            rowHref={link}
            name={t.name}
            meta={triggerMeta(t)}
            trailing={
              t.enabled ? (
                <Badge variant="success" size="xs">On</Badge>
              ) : (
                <Badge variant="outline" size="xs">Paused</Badge>
              )
            }
          />
        ))}
        <MoreRow moreHref={link} hidden={triggers.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

const REMINDER_STATE: Record<
  ProjectReminder['state'],
  { label: string; variant: 'success' | 'outline' }
> = {
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'outline' },
  done: { label: 'Done', variant: 'outline' },
};

function reminderSchedule(r: ProjectReminder): string | null {
  if (r.every) return `every ${r.every}`;
  if (r.cron) return `cron · ${r.cron}`;
  if (r.at) return 'once';
  return null;
}

function RemindersSection({ projectId }: { projectId: string }) {
  const query = useProjectReminders(projectId);
  const reminders = query.data?.reminders ?? [];
  const link = remindersHref(projectId);
  return (
    <ResourceCard
      icon={BellIcon}
      title="Reminders"
      href={link}
      count={query.isLoading ? undefined : reminders.length}
    >
      <CardBody
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => query.refetch()}
        isEmpty={reminders.length === 0}
        emptyLabel="No reminders scheduled yet."
      >
        {reminders.slice(0, MAX_ROWS).map((r) => {
          const state = REMINDER_STATE[r.state];
          return (
            <ResourceRow
              key={r.id}
              rowHref={link}
              name={r.name || r.prompt}
              meta={reminderSchedule(r)}
              trailing={<Badge variant={state.variant} size="xs">{state.label}</Badge>}
            />
          );
        })}
        <MoreRow moreHref={link} hidden={reminders.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

function ModelsSection({ projectId }: { projectId: string }) {
  const models = useProjectModels(projectId);
  const link = capHref(projectId, 'models');
  return (
    <ResourceCard icon={CpuIcon} title="Models" href={link} count={models.length}>
      <CardBody
        isLoading={false}
        isError={false}
        isEmpty={models.length === 0}
        emptyLabel="No models available yet."
      >
        {models.slice(0, MAX_ROWS).map((m) => (
          <ResourceRow
            key={`${m.providerID}/${m.modelID}`}
            rowHref={link}
            name={m.modelName}
            meta={m.provider ?? m.providerName}
          />
        ))}
        <MoreRow moreHref={link} hidden={models.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

function secretConfigured(s: ProjectSecret): boolean {
  return s.configured || s.effective_source !== 'none';
}

function SecretsSection({ projectId }: { projectId: string }) {
  const query = useProjectSecrets(projectId);
  const secrets = query.data?.items ?? [];
  const link = capHref(projectId, 'secrets');
  return (
    <ResourceCard
      icon={KeyIcon}
      title="Secrets"
      href={link}
      count={query.isLoading ? undefined : secrets.length}
    >
      <CardBody
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => query.refetch()}
        isEmpty={secrets.length === 0}
        emptyLabel="No secrets stored yet."
      >
        {secrets.slice(0, MAX_ROWS).map((s) => (
          <ResourceRow
            key={s.identifier}
            rowHref={link}
            name={s.name}
            meta={s.identifier === s.name ? undefined : s.identifier}
            trailing={
              secretConfigured(s) ? (
                <Badge variant="success" size="xs">Set</Badge>
              ) : (
                <Badge variant="outline" size="xs">Unset</Badge>
              )
            }
          />
        ))}
        <MoreRow moreHref={link} hidden={secrets.length - MAX_ROWS} />
      </CardBody>
    </ResourceCard>
  );
}

function ReviewSection({ projectId }: { projectId: string }) {
  const query = useReviewSummary(projectId);
  const needsYou = query.data?.needs_you_total ?? 0;
  const link = reviewHref(projectId);
  return (
    <ResourceCard
      icon={TrayIcon}
      title="Review"
      href={link}
      count={query.isLoading ? undefined : needsYou}
    >
      <CardBody
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => query.refetch()}
        isEmpty={false}
        emptyLabel=""
      >
        <ResourceRow
          rowHref={link}
          name={needsYou === 0 ? 'Nothing waiting on you' : `${needsYou} waiting on you`}
          meta={needsYou === 0 ? 'The inbox is clear' : 'Open the review inbox'}
        />
      </CardBody>
    </ResourceCard>
  );
}
