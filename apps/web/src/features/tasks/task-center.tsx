'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type ProjectTask,
  type ProjectTaskStatus,
  type TaskBlocker,
  type TaskEvent,
  type TaskEvidenceRecord,
  type TaskSessionLink,
  createProjectTask,
  getConnectorCatalog,
  getEmailInstallation,
  getProjectDetail,
  getSlackInstallation,
  listProjectTaskBlockers,
  listProjectTaskEvents,
  listProjectTaskEvidence,
  listProjectTaskSessionLinks,
  listProjectTasks,
  requestProjectTaskCompletion,
  resolveProjectTaskBlocker,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  BrowserIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  IdentificationCardIcon,
  KeyIcon,
  LinkIcon,
  PlugIcon,
  PlusIcon,
  RobotIcon,
  ShieldCheckIcon,
  TrayIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import {
  type TaskInboxFilter,
  artifactFirstEvidence,
  candidateDigestForReview,
  evidenceForRequirement,
  isExternalRef,
  isMissingAccessBlocker,
  openTaskBlockers,
  orderSessionLineage,
  selectedTaskForFilter,
  taskCandidateIsVerified,
  taskEventDetail,
  taskFilterCount,
  taskMatchesFilter,
} from './task-center-helpers';

const FILTERS: Array<{ value: TaskInboxFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'review', label: 'Review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

const TASK_SKELETON_KEYS = [
  'task-1',
  'task-2',
  'task-3',
  'task-4',
  'task-5',
  'task-6',
  'task-7',
] as const;

const STATUS_LABEL: Record<ProjectTaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Ready',
  doing: 'In progress',
  blocked: 'Blocked',
  review: 'Needs review',
  done: 'Done',
  cancelled: 'Cancelled',
};

function DelegateTaskModal({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: ProjectTask) => void;
}) {
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const create = useMutation({
    mutationFn: () =>
      createProjectTask(projectId, {
        title: title.trim(),
        body: outcome.trim(),
        intent: outcome.trim(),
        status: 'todo',
        origin: 'web.delegate',
        review_policy: { mode: 'human' },
        verification_requirements: [
          {
            id: 'reviewable-result',
            kind: 'artifact',
            description:
              'Provide a reviewable result or artifact that proves the requested outcome.',
            required: true,
          },
        ],
      }),
    onSuccess: ({ task }) => {
      successToast('Task delegated');
      setTitle('');
      setOutcome('');
      onOpenChange(false);
      onCreated(task);
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to delegate task'),
  });
  const valid = title.trim().length > 0 && outcome.trim().length > 0;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Delegate a task</ModalTitle>
          <ModalDescription>
            Define the outcome. The cloud coordinator claims the task and keeps it open until
            review.
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="delegate-task-title">Task</FieldLabel>
              <Input
                id="delegate-task-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Resolve the production checkout failure"
                autoFocus
                maxLength={256}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="delegate-task-outcome">Verified outcome</FieldLabel>
              <Textarea
                id="delegate-task-outcome"
                value={outcome}
                onChange={(event) => setOutcome(event.target.value)}
                placeholder="Checkout succeeds in production. Submit the deployed revision and a passing browser recording."
                minHeight={120}
                maxHeight={260}
              />
              <FieldDescription>
                State what must be true when the task is complete. The coordinator can refine the
                contract before work starts.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="outline-ghost"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
            {create.isPending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <PlusIcon className="size-4 shrink-0" />
            )}
            Delegate
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function statusBadgeVariant(
  status: ProjectTaskStatus,
): 'outline' | 'warning' | 'success' | 'destructive' | 'muted' | 'beta' {
  if (status === 'done') return 'success';
  if (status === 'blocked') return 'destructive';
  if (status === 'review') return 'warning';
  if (status === 'doing') return 'beta';
  if (status === 'cancelled') return 'muted';
  return 'outline';
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

function exactTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date, 'MMM d, yyyy, h:mm a');
}

function TaskCenterSkeleton() {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      <div className="space-y-2 border-r p-4">
        <Skeleton className="h-7 w-64 rounded-md" />
        {TASK_SKELETON_KEYS.map((key) => (
          <Skeleton key={key} className="h-20 w-full rounded-md" />
        ))}
      </div>
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-2/3 rounded-md" />
        <Skeleton className="h-20 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    </div>
  );
}

interface ReadinessItemProps {
  icon: typeof IdentificationCardIcon;
  label: string;
  description: string;
  ready: boolean | null;
  href: string;
}

function ReadinessItem({ icon: Icon, label, description, ready, href }: ReadinessItemProps) {
  return (
    <li className="flex min-h-10 items-center gap-3 px-3 py-2.5">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          ready === true
            ? 'bg-kortix-green/15 text-kortix-green'
            : 'bg-muted/50 text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="text-muted-foreground truncate text-xs">{description}</p>
      </div>
      {ready === true ? (
        <CheckCircleIcon className="text-kortix-green size-4 shrink-0" />
      ) : ready === false ? (
        <Button asChild variant="ghost" size="xs">
          <Link href={href}>Set up</Link>
        </Button>
      ) : (
        <Badge size="xs" variant="muted">
          Unknown
        </Badge>
      )}
    </li>
  );
}

function CoworkerReadiness({
  projectId,
  openBlockers,
}: {
  projectId: string;
  openBlockers: readonly TaskBlocker[] | null;
}) {
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const servicesQuery = useQuery({
    queryKey: [...qk.project.scope(projectId), 'coworker-readiness'],
    queryFn: async () => {
      const [connectors, slack, email] = await Promise.all([
        getConnectorCatalog(projectId),
        getSlackInstallation(projectId),
        getEmailInstallation(projectId),
      ]);
      return { connectors, slack, email };
    },
    ...contract('config'),
  });

  const hasCoordinatorConfig =
    projectQuery.data?.config.agents.some((agent) => agent.name === 'agi') === true;
  const connectors = servicesQuery.data?.connectors ?? [];
  const usableConnectors = connectors.filter((connector) => connector.actions.length > 0);
  const hasConnectors = usableConnectors.length > 0;
  const hasChannel =
    usableConnectors.some((connector) => connector.provider === 'channel') ||
    !!servicesQuery.data?.slack ||
    !!servicesQuery.data?.email;
  const hasPersistentBrowser = usableConnectors.some(
    (connector) =>
      connector.provider === 'computer' ||
      /browser|computer/i.test(`${connector.slug} ${connector.name}`),
  );
  const missingAccess = openBlockers?.filter(isMissingAccessBlocker).length ?? null;
  const loading = projectQuery.isLoading || servicesQuery.isLoading;
  const identityReady = projectQuery.isError ? null : hasCoordinatorConfig;
  const toolsReady = servicesQuery.isError ? null : hasConnectors;
  const channelReady = servicesQuery.isError ? null : hasChannel;
  const browserReady = servicesQuery.isError ? null : hasPersistentBrowser;

  if (loading) return <Skeleton className="h-28 w-full rounded-md" />;

  return (
    <div className="bg-popover overflow-hidden rounded-md border" data-testid="coworker-readiness">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-foreground text-sm font-medium">Coworker readiness</p>
            <p className="text-muted-foreground text-xs">
              Configuration, tools, channels, and access.
            </p>
          </div>
          {missingAccess !== null && missingAccess > 0 ? (
            <Badge variant="warning" size="xs" className="tabular-nums">
              {missingAccess} access {missingAccess === 1 ? 'request' : 'requests'}
            </Badge>
          ) : null}
        </div>
      </div>
      <ul className="divide-y">
        <ReadinessItem
          icon={IdentificationCardIcon}
          label="Coordinator configuration"
          description={
            identityReady === null
              ? 'Identity status is unavailable.'
              : hasCoordinatorConfig
                ? 'The project coordinator is configured.'
                : 'Activate AGI.'
          }
          ready={identityReady}
          href={`/projects/${projectId}/agent`}
        />
        <ReadinessItem
          icon={PlugIcon}
          label="Tools"
          description={
            toolsReady === null
              ? 'Connector status is unavailable.'
              : hasConnectors
                ? `${usableConnectors.length} connectors expose callable actions.`
                : 'Add project connectors.'
          }
          ready={toolsReady}
          href={`/projects/${projectId}/connectors`}
        />
        <ReadinessItem
          icon={EnvelopeSimpleIcon}
          label="Channels"
          description={
            channelReady === null
              ? 'Channel status is unavailable.'
              : hasChannel
                ? 'A communication channel is connected.'
                : 'Connect Slack or email.'
          }
          ready={channelReady}
          href={`/projects/${projectId}/customize/channels`}
        />
        <ReadinessItem
          icon={BrowserIcon}
          label="Persistent browser"
          description={
            browserReady === null
              ? 'Computer status is unavailable.'
              : hasPersistentBrowser
                ? 'A connector exposes callable computer actions.'
                : 'Assign a persistent computer.'
          }
          ready={browserReady}
          href={`/projects/${projectId}/customize/computers`}
        />
        <ReadinessItem
          icon={KeyIcon}
          label="Required access"
          description={
            missingAccess === null
              ? 'Access status is unavailable.'
              : missingAccess === 0
                ? 'No unresolved access requests.'
                : 'Human action is required.'
          }
          ready={missingAccess === null ? null : missingAccess === 0}
          href="#task-blockers"
        />
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: ProjectTask;
  selected: boolean;
  onSelect: () => void;
}) {
  const iconTone =
    task.status === 'done'
      ? 'bg-kortix-green/15 text-kortix-green'
      : task.status === 'blocked'
        ? 'bg-kortix-red/15 text-kortix-red'
        : task.status === 'review'
          ? 'bg-kortix-orange/15 text-kortix-orange'
          : 'bg-primary/[0.06] text-foreground';

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'flex min-h-20 w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-left transition-[background-color,border-color,transform] duration-150 active:scale-[0.96]',
          selected
            ? 'border-primary/15 bg-primary/[0.06]'
            : 'bg-popover hover:bg-foreground/[0.03]',
        )}
      >
        <span
          className={cn('flex size-8 shrink-0 items-center justify-center rounded-sm', iconTone)}
        >
          {task.status === 'done' ? (
            <CheckCircleIcon className="size-4" />
          ) : task.status === 'blocked' ? (
            <WarningCircleIcon className="size-4" />
          ) : (
            <CircleIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="block truncate text-sm font-medium">{task.title}</span>
          <span className="flex items-center gap-1.5">
            <Badge size="xs" variant={statusBadgeVariant(task.status)}>
              {STATUS_LABEL[task.status]}
            </Badge>
            <span className="text-muted-foreground truncate text-xs tabular-nums">
              {relativeTime(task.updated_at)}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function EvidenceCard({ evidence }: { evidence: TaskEvidenceRecord }) {
  const content = (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          evidence.state === 'passed'
            ? 'bg-kortix-green/15 text-kortix-green'
            : evidence.state === 'failed'
              ? 'bg-kortix-red/15 text-kortix-red'
              : 'bg-muted/50 text-muted-foreground',
        )}
      >
        {evidence.kind === 'artifact' || evidence.kind === 'deployment' ? (
          <LinkIcon className="size-5" />
        ) : evidence.state === 'passed' ? (
          <CheckCircleIcon className="size-5" />
        ) : (
          <XCircleIcon className="size-5" />
        )}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge size="xs" variant="outline">
            {evidence.kind}
          </Badge>
          <Badge
            size="xs"
            variant={
              evidence.state === 'passed'
                ? 'success'
                : evidence.state === 'failed'
                  ? 'destructive'
                  : 'muted'
            }
          >
            {evidence.state}
          </Badge>
        </span>
        <span className="text-foreground block truncate text-sm font-medium">
          {evidence.summary || evidence.ref}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{evidence.ref}</span>
        <span
          className="text-muted-foreground block truncate font-mono text-xs"
          title={evidence.candidate_digest}
        >
          Candidate {evidence.candidate_digest}
        </span>
      </span>
    </div>
  );

  return (
    <li className="bg-popover flex min-h-16 items-center gap-3 rounded-md border px-3 py-3">
      {content}
      {isExternalRef(evidence.ref) ? (
        <Button asChild variant="ghost" size="icon" aria-label="Open evidence">
          <a href={evidence.ref} target="_blank" rel="noopener noreferrer">
            <ArrowSquareOutIcon className="size-4" />
          </a>
        </Button>
      ) : null}
    </li>
  );
}

function VerificationPanel({
  task,
  evidence,
  candidateDigest,
}: {
  task: ProjectTask;
  evidence: readonly TaskEvidenceRecord[];
  candidateDigest: string | null;
}) {
  const requirements = task.verification_requirements ?? [];
  const revision = task.contract_revision ?? 1;
  if (requirements.length === 0) {
    return (
      <InfoBanner tone="warning" icon={WarningCircleIcon} title="No verification contract">
        This task cannot show required proof until its outcome contract defines verification checks.
      </InfoBanner>
    );
  }

  return (
    <div className="bg-popover overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-sm font-medium">Verification contract</p>
          <p className="text-muted-foreground text-xs tabular-nums">Revision {revision}</p>
        </div>
        <Badge variant="outline" size="sm" className="tabular-nums">
          {
            requirements.filter(
              (item) =>
                item.required && evidenceForRequirement(evidence, item, revision, candidateDigest),
            ).length
          }
          /{requirements.filter((item) => item.required).length} required
        </Badge>
      </div>
      <ul className="divide-y">
        {requirements.map((requirement) => {
          const proof = evidenceForRequirement(evidence, requirement, revision, candidateDigest);
          return (
            <li key={requirement.id} className="flex min-h-12 items-start gap-3 px-4 py-3">
              {proof ? (
                <CheckCircleIcon className="text-kortix-green mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm">{requirement.description}</p>
                <p className="text-muted-foreground text-xs">
                  {requirement.kind} &bull; {requirement.required ? 'Required' : 'Optional'}
                </p>
              </div>
              <Badge size="xs" variant={proof ? 'success' : 'muted'}>
                {proof ? 'Verified' : 'Pending'}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BlockersPanel({
  projectId,
  taskId,
  blockers,
  canWrite,
  isLoading,
  isError,
}: {
  projectId: string;
  taskId: string;
  blockers: readonly TaskBlocker[];
  canWrite: boolean;
  isLoading: boolean;
  isError: boolean;
}) {
  const queryClient = useQueryClient();
  const open = openTaskBlockers(blockers);
  const resolve = useMutation({
    mutationFn: (blockerId: string) => resolveProjectTaskBlocker(projectId, taskId, blockerId),
    onSuccess: () => {
      successToast('Blocker resolved');
      void queryClient.invalidateQueries({ queryKey: qk.project.taskBlockers(projectId, taskId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.tasks(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.taskEvents(projectId, taskId) });
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to resolve blocker'),
  });

  return (
    <section id="task-blockers" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Blockers</h3>
        <Badge
          size="xs"
          variant={!isLoading && !isError && open.length > 0 ? 'warning' : 'muted'}
          className="tabular-nums"
        >
          {isLoading || isError ? '—' : open.length} open
        </Badge>
      </div>
      {isLoading ? (
        <Skeleton className="h-20 w-full rounded-md" />
      ) : isError ? (
        <InfoBanner tone="destructive" icon={WarningCircleIcon} title="Blocker status unavailable">
          Retry before you decide that this task is unblocked.
        </InfoBanner>
      ) : open.length === 0 ? (
        <div className="bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-3 text-xs">
          <CheckCircleIcon className="text-kortix-green size-4 shrink-0" />
          No human action is blocking this task.
        </div>
      ) : (
        <ul className="space-y-2">
          {open.map((blocker) => (
            <li key={blocker.blocker_id} className="bg-popover rounded-md border px-4 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge size="xs" variant="warning">
                      {blocker.category}
                    </Badge>
                    {blocker.next_reminder_at ? (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        Reminder {relativeTime(blocker.next_reminder_at)}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-pretty">{blocker.requested_action}</p>
                  {blocker.attempts_made.length > 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {blocker.attempts_made.length} autonomous attempts recorded.
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canWrite || resolve.isPending}
                  onClick={() => resolve.mutate(blocker.blocker_id)}
                >
                  {resolve.isPending ? <Loading className="size-4 shrink-0" /> : null}
                  {canWrite ? 'Mark resolved' : 'Manager action'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityTimeline({ events }: { events: readonly TaskEvent[] }) {
  if (events.length === 0) {
    return <EmptyState size="sm" icon={ClockCounterClockwiseIcon} title="No task events" />;
  }
  const newestFirst = [...events].reverse();
  return (
    <ol className="space-y-0">
      {newestFirst.map((event, index) => (
        <li key={event.event_id} className="relative flex gap-3 pb-5 last:pb-0">
          {index < newestFirst.length - 1 ? (
            <span className="bg-border absolute top-5 bottom-0 left-[7px] w-px" aria-hidden />
          ) : null}
          <span className="bg-popover mt-1.5 size-4 shrink-0 rounded-full border" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{event.event_type.replace(/[._]/g, ' ')}</p>
            {taskEventDetail(event) ? (
              <p
                className="text-muted-foreground truncate text-xs"
                title={taskEventDetail(event) ?? undefined}
              >
                {taskEventDetail(event)}
              </p>
            ) : null}
            <p
              className="text-muted-foreground text-xs tabular-nums"
              title={exactTime(event.created_at)}
            >
              {relativeTime(event.created_at)} &bull; {event.actor_type}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SessionLineage({
  projectId,
  sessions,
}: {
  projectId: string;
  sessions: readonly TaskSessionLink[];
}) {
  if (sessions.length === 0) {
    return <EmptyState size="sm" icon={RobotIcon} title="No sessions linked" />;
  }
  const lineage = orderSessionLineage(sessions);
  return (
    <ul className="space-y-2">
      {lineage.map(({ session, depth }) => (
        <li
          key={`${session.session_id}:${session.role}`}
          className={cn(depth === 1 && 'ml-5', depth >= 2 && 'ml-10')}
        >
          <Button
            asChild
            variant="outline"
            className="h-auto min-h-12 w-full justify-start px-3 py-2"
          >
            <Link href={`/projects/${projectId}/sessions/${session.session_id}`}>
              <RobotIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium">{session.role}</span>
                <span className="text-muted-foreground block truncate font-mono text-xs">
                  {session.session_id}
                </span>
                {session.parent_session_id ? (
                  <span className="text-muted-foreground block truncate text-xs">
                    Child of {session.parent_session_id}
                  </span>
                ) : null}
              </span>
              <ArrowSquareOutIcon className="size-4 shrink-0" />
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function TaskDetail({
  projectId,
  task,
  canWrite,
}: {
  projectId: string;
  task: ProjectTask;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const evidenceQuery = useQuery({
    queryKey: qk.project.taskEvidence(projectId, task.task_id),
    queryFn: async () => (await listProjectTaskEvidence(projectId, task.task_id)).evidence,
    refetchInterval: task.status === 'done' || task.status === 'cancelled' ? false : 15_000,
    ...contract('inventory'),
  });
  const blockersQuery = useQuery({
    queryKey: qk.project.taskBlockers(projectId, task.task_id),
    queryFn: async () => (await listProjectTaskBlockers(projectId, task.task_id)).blockers,
    refetchInterval: task.status === 'done' || task.status === 'cancelled' ? false : 15_000,
    ...contract('inventory'),
  });
  const eventsQuery = useQuery({
    queryKey: qk.project.taskEvents(projectId, task.task_id),
    queryFn: async () => (await listProjectTaskEvents(projectId, task.task_id, 200)).events,
    refetchInterval: task.status === 'done' || task.status === 'cancelled' ? false : 15_000,
    ...contract('inventory'),
  });
  const sessionsQuery = useQuery({
    queryKey: qk.project.taskSessions(projectId, task.task_id),
    queryFn: async () => (await listProjectTaskSessionLinks(projectId, task.task_id)).sessions,
    refetchInterval: task.status === 'done' || task.status === 'cancelled' ? false : 15_000,
    ...contract('inventory'),
  });

  const evidence = artifactFirstEvidence(evidenceQuery.data ?? []);
  const blockers = blockersQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const candidateDigest = candidateDigestForReview(task, evidence, eventsQuery.data ?? []);
  const candidateVerified = taskCandidateIsVerified(task, evidence, candidateDigest);
  const blockersClear = blockersQuery.isSuccess && openTaskBlockers(blockers).length === 0;
  const coordinator = sessions.find((session) => session.role === 'coordinator');
  const complete = useMutation({
    mutationFn: () => {
      if (!candidateDigest || !task.claim_session_id) {
        throw new Error('The task needs a claimed session and candidate evidence before review.');
      }
      return requestProjectTaskCompletion(projectId, task.task_id, {
        candidate_digest: candidateDigest,
        session_id: task.claim_session_id,
      });
    },
    onSuccess: () => {
      successToast('Task verified and closed');
      void queryClient.invalidateQueries({ queryKey: qk.project.tasks(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.task(projectId, task.task_id) });
      void queryClient.invalidateQueries({
        queryKey: qk.project.taskEvents(projectId, task.task_id),
      });
    },
    onError: (error) => errorToast(error instanceof Error ? error.message : 'Verification failed'),
  });

  return (
    <article className="min-h-full p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-20">
        <header className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge size="sm" variant={statusBadgeVariant(task.status)}>
                  {STATUS_LABEL[task.status]}
                </Badge>
                <Badge size="sm" variant="outline" className="tabular-nums">
                  Priority {task.priority}
                </Badge>
                {task.review_policy?.mode === 'human' ? (
                  <Badge size="sm" variant="outline">
                    Human review
                  </Badge>
                ) : null}
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-balance">{task.title}</h2>
              {task.intent || task.body ? (
                <p className="text-muted-foreground text-sm text-pretty">
                  {task.intent || task.body}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {coordinator ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/projects/${projectId}/sessions/${coordinator.session_id}`}>
                    Open coordinator
                  </Link>
                </Button>
              ) : null}
              {task.status === 'review' ? (
                <Button
                  size="sm"
                  disabled={
                    !canWrite ||
                    !candidateVerified ||
                    !blockersClear ||
                    !task.claim_session_id ||
                    complete.isPending
                  }
                  onClick={() => complete.mutate()}
                >
                  {complete.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : (
                    <ShieldCheckIcon className="size-4 shrink-0" />
                  )}
                  Verify and close
                </Button>
              ) : null}
            </div>
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            <span>Updated {relativeTime(task.updated_at)}</span>
            <span>Contract revision {task.contract_revision ?? 1}</span>
            {task.claim_expires_at ? (
              <span>Lease expires {relativeTime(task.claim_expires_at)}</span>
            ) : null}
          </div>
        </header>

        <Tabs defaultValue="review" className="gap-6">
          <TabsList type="underline" size="sm">
            <TabsTrigger value="review" className="w-fit flex-none">
              Review
            </TabsTrigger>
            <TabsTrigger value="activity" className="w-fit flex-none">
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="review" className="space-y-6">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">Submitted evidence</h3>
                  <p className="text-muted-foreground text-xs">
                    Artifacts appear before implementation checks.
                  </p>
                </div>
                <Badge size="xs" variant="muted" className="tabular-nums">
                  {evidence.length}
                </Badge>
              </div>
              {evidenceQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-20 w-full rounded-md" />
                  <Skeleton className="h-20 w-full rounded-md" />
                </div>
              ) : evidenceQuery.isError ? (
                <ErrorState size="sm" title="Failed to load evidence" />
              ) : evidence.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={TrayIcon}
                  title="No evidence submitted"
                  description="The task remains open until the worker submits proof."
                />
              ) : (
                <ul className="space-y-2">
                  {evidence.map((item) => (
                    <EvidenceCard key={item.evidence_id} evidence={item} />
                  ))}
                </ul>
              )}
            </section>

            <VerificationPanel task={task} evidence={evidence} candidateDigest={candidateDigest} />
            <BlockersPanel
              projectId={projectId}
              taskId={task.task_id}
              blockers={blockers}
              canWrite={canWrite}
              isLoading={blockersQuery.isLoading}
              isError={blockersQuery.isError}
            />
          </TabsContent>

          <TabsContent value="activity" className="grid gap-8 lg:grid-cols-2">
            <section className="space-y-4">
              <h3 className="text-sm font-medium">Event timeline</h3>
              {eventsQuery.isLoading ? (
                <Skeleton className="h-48 w-full rounded-md" />
              ) : eventsQuery.isError ? (
                <ErrorState size="sm" title="Failed to load task events" />
              ) : (
                <ActivityTimeline events={eventsQuery.data ?? []} />
              )}
            </section>
            <section className="space-y-4">
              <h3 className="text-sm font-medium">Session lineage</h3>
              {sessionsQuery.isLoading ? (
                <Skeleton className="h-48 w-full rounded-md" />
              ) : sessionsQuery.isError ? (
                <ErrorState size="sm" title="Failed to load session lineage" />
              ) : (
                <SessionLineage projectId={projectId} sessions={sessions} />
              )}
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </article>
  );
}

export function TaskCenter({ projectId }: { projectId: string }) {
  const gate = useFeatureFlag(projectId, 'agi');
  const canReadTasks = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TASK_READ);
  const canWriteTasks = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TASK_WRITE);
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<TaskInboxFilter>('open');
  const [delegateOpen, setDelegateOpen] = useState(false);
  const tasksQuery = useQuery({
    queryKey: qk.project.tasks(projectId),
    queryFn: async () => (await listProjectTasks(projectId, { limit: 500 })).tasks,
    enabled: gate.enabled && canReadTasks.allowed,
    refetchInterval: gate.enabled ? 10_000 : false,
    ...contract('inventory'),
  });
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const requestedTaskId = searchParams.get('task');
  const filteredTasks = useMemo(
    () => tasks.filter((task) => taskMatchesFilter(task, filter)),
    [filter, tasks],
  );
  const selectedTask = useMemo(
    () => selectedTaskForFilter(tasks, filter, requestedTaskId),
    [filter, requestedTaskId, tasks],
  );
  const allOpenBlockersQuery = useQuery({
    queryKey: [...qk.project.tasks(projectId), 'open-blockers'],
    queryFn: async () => {
      // A blocker insert remains authoritative when an expired lease prevents
      // the best-effort status transition to `blocked`. Inspect every active
      // task so readiness never converts that state into a false success.
      const active = tasks.filter((task) => taskMatchesFilter(task, 'open'));
      const blockers = await Promise.all(
        active.map(
          async (task) => (await listProjectTaskBlockers(projectId, task.task_id)).blockers,
        ),
      );
      return blockers.flat().filter((blocker) => blocker.status === 'open');
    },
    enabled: gate.enabled && canReadTasks.allowed && tasks.length > 0,
    refetchInterval: gate.enabled ? 30_000 : false,
    ...contract('inventory'),
  });

  useEffect(() => {
    if (!selectedTask || selectedTask.task_id === requestedTaskId) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('task', selectedTask.task_id);
    router.replace(`/projects/${projectId}/tasks?${next.toString()}`, { scroll: false });
  }, [projectId, requestedTaskId, router, searchParams, selectedTask]);

  const selectTask = (taskId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('task', taskId);
    router.replace(`/projects/${projectId}/tasks?${next.toString()}`, { scroll: false });
  };

  let content: ReactNode;
  if (gate.isLoading) {
    content = <TaskCenterSkeleton />;
  } else if (!gate.enabled) {
    content = (
      <div className="mx-auto w-full max-w-3xl p-4 py-10 lg:py-20">
        <FeatureGateScreen
          featureName="AI coworker"
          description="AI coworker adds durable tasks, verification evidence, blocker reminders, and continual cloud execution to this project."
        />
      </div>
    );
  } else if (!canReadTasks.allowed && !canReadTasks.isLoading) {
    content = (
      <div className="p-6">
        <ErrorState
          title="Task access required"
          description="Your project role cannot read AI coworker tasks."
        />
      </div>
    );
  } else if (tasksQuery.isLoading || canReadTasks.isLoading) {
    content = <TaskCenterSkeleton />;
  } else if (tasksQuery.isError) {
    content = (
      <div className="p-6">
        <ErrorState
          title="Failed to load tasks"
          description={tasksQuery.error instanceof Error ? tasksQuery.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void tasksQuery.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  } else {
    content = (
      <div className="grid min-h-full lg:h-full lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <aside className="border-border/60 space-y-4 border-b p-4 lg:h-full lg:overflow-y-auto lg:border-r lg:border-b-0">
          <CoworkerReadiness
            projectId={projectId}
            openBlockers={
              allOpenBlockersQuery.isSuccess
                ? (allOpenBlockersQuery.data ?? [])
                : tasks.length === 0
                  ? []
                  : null
            }
          />
          <Tabs value={filter} onValueChange={(value) => setFilter(value as TaskInboxFilter)}>
            <TabsListCompact className="w-full">
              {FILTERS.map((item) => (
                <TabsTriggerCompact key={item.value} value={item.value} className="min-w-0">
                  {item.label}
                  <span className="tabular-nums">{taskFilterCount(tasks, item.value)}</span>
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>
          {filteredTasks.length === 0 ? (
            <EmptyState
              size="sm"
              icon={TrayIcon}
              title={`No ${filter} tasks`}
              description="The coworker creates durable tasks when work begins."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDelegateOpen(true)}
                  disabled={!canWriteTasks.allowed}
                >
                  <PlusIcon className="size-4 shrink-0" />
                  Delegate task
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2" aria-label="Task inbox">
              {filteredTasks.map((task) => (
                <TaskRow
                  key={task.task_id}
                  task={task}
                  selected={task.task_id === selectedTask?.task_id}
                  onSelect={() => selectTask(task.task_id)}
                />
              ))}
            </ul>
          )}
        </aside>
        {selectedTask ? (
          <TaskDetail
            key={selectedTask.task_id}
            projectId={projectId}
            task={selectedTask}
            canWrite={canWriteTasks.allowed}
          />
        ) : tasks.length > 0 ? (
          <div className="flex min-h-80 items-center justify-center p-6">
            <EmptyState
              icon={TrayIcon}
              title={`No ${filter} tasks to review`}
              description="Choose another filter to review existing work."
            />
          </div>
        ) : (
          <div className="flex min-h-80 items-center justify-center p-6">
            <EmptyState
              icon={RobotIcon}
              title="Give your coworker its first task"
              description="The task stays open until its verification contract passes."
              action={
                <Button onClick={() => setDelegateOpen(true)} disabled={!canWriteTasks.allowed}>
                  <PlusIcon className="size-4 shrink-0" />
                  Delegate task
                </Button>
              }
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <CustomizeSectionWrapper
        title="Tasks"
        description="Review outcomes, unblock work, and verify completion."
        action={
          gate.enabled ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDelegateOpen(true)}
                disabled={!canWriteTasks.allowed}
              >
                <PlusIcon className="size-4 shrink-0" />
                Delegate task
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: qk.project.tasks(projectId) })
                }
              >
                <ClockCounterClockwiseIcon className="size-4 shrink-0" />
                Refresh
              </Button>
            </div>
          ) : undefined
        }
        fill
        showSidebarToggleButton
      >
        {content}
      </CustomizeSectionWrapper>
      <DelegateTaskModal
        projectId={projectId}
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        onCreated={(task) => {
          void queryClient.invalidateQueries({ queryKey: qk.project.tasks(projectId) });
          setFilter('open');
          selectTask(task.task_id);
        }}
      />
    </>
  );
}
