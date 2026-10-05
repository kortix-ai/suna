'use client';

import type { CaptureWorkflowDetail } from '@kortix/sdk';
import {
  useCaptureDevices,
  useCaptureEpisodes,
  useCaptureWorkflow,
  useReviewCaptureWorkflow,
} from '@kortix/sdk/react';
import { ArrowSquareOutIcon, CheckIcon, GitBranchIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { CapturePage } from '../area/capture-area-shell';
import {
  captureHref,
  deviceName,
  useCaptureArea,
  useCaptureDirectory,
} from '../area/use-capture-area';
import {
  WorkflowStatusBadge,
  useHours,
  usePercent,
  useRunDuration,
} from '../intelligence/workflow-ui';
import { SkillExportModal } from './skill-export-modal';

/**
 * One workflow (`/capture/[accountId]/workflows/[workflowId]`), Capture admins
 * and viewers: the canonical procedure with its variables and decisions, the
 * variants, who runs it, every run (each opens the device timeline at that
 * moment). Admins review it and export it as a skill.
 */
export function WorkflowDetailView({
  accountId,
  workflowId,
}: {
  accountId: string;
  workflowId: string;
}) {
  const t = useTranslations('capture.workflow');
  const tw = useTranslations('capture.workflows');
  const area = useCaptureArea(accountId);
  const router = useRouter();
  const member = area.role === 'member';
  useEffect(() => {
    if (member) router.replace(captureHref(accountId, 'devices'));
  }, [member, accountId, router]);
  const query = useCaptureWorkflow(member ? null : accountId, workflowId);
  const breadcrumb = (
    <nav aria-label={t('breadcrumb')} className="flex min-w-0 items-center gap-2 text-xs">
      <Link
        href={captureHref(accountId, 'workflows')}
        className="text-muted-foreground hover:text-foreground"
      >
        {tw('title')}
      </Link>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <span className="text-foreground truncate">{query.data?.name ?? '…'}</span>
    </nav>
  );
  if (member || !area.role) return null;
  if (query.isLoading) {
    return (
      <CapturePage title={<Skeleton className="h-7 w-72 rounded-md" />} breadcrumb={breadcrumb}>
        <Skeleton className="h-20 rounded-md" />
        <Skeleton className="h-96 rounded-md" />
      </CapturePage>
    );
  }
  if (query.isError || !query.data) {
    return (
      <CapturePage title={tw('title')} breadcrumb={breadcrumb}>
        <div className="bg-background rounded-md border px-4 py-12">
          <ErrorState
            size="sm"
            title={t('notFound')}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={captureHref(accountId, 'workflows')}>{t('back')}</Link>
              </Button>
            }
          />
        </div>
      </CapturePage>
    );
  }
  return <Workflow accountId={accountId} workflow={query.data} breadcrumb={breadcrumb} />;
}

function Workflow({
  accountId,
  workflow: w,
  breadcrumb,
}: {
  accountId: string;
  workflow: CaptureWorkflowDetail;
  breadcrumb: ReactNode;
}) {
  const t = useTranslations('capture.workflow');
  const tw = useTranslations('capture.workflows');
  const locale = useLocale();
  const area = useCaptureArea(accountId);
  const people = useCaptureDirectory(accountId, true);
  const duration = useRunDuration();
  const hours = useHours();
  const percent = usePercent();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : '–';
  const reviewer = w.reviewed_by ? people.personOf(w.reviewed_by) : null;
  const meta = [
    t('firstSeen', { date: date(w.first_seen_at) }),
    reviewer && w.reviewed_at
      ? t('reviewedBy', { name: reviewer.email ?? t('aMember'), date: date(w.reviewed_at) })
      : null,
    t('runsTotal', { count: w.runs_total }),
  ].filter(Boolean);
  const variantOf = new Map(w.variants.map((v) => [v.key, v]));

  return (
    <CapturePage
      breadcrumb={breadcrumb}
      title={
        <span className="flex flex-wrap items-center gap-3">
          {w.name}
          <WorkflowStatusBadge status={w.status} />
        </span>
      }
      description={
        <span className="flex flex-col gap-1">
          {w.goal || w.outcome ? (
            <span>
              {w.goal ? t('goal', { goal: w.goal }) : null}{' '}
              {w.outcome ? t('outcome', { outcome: w.outcome }) : null}
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">{meta.join(' · ')}</span>
        </span>
      }
      actions={
        area.isAdmin ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setReviewOpen(true)}
            >
              <CheckIcon className="size-3.5 shrink-0" />
              {t('review')}
            </Button>
            <Button size="sm" onClick={() => setSkillOpen(true)}>
              {w.skill ? t('exportAgain') : t('exportSkill')}
            </Button>
          </>
        ) : null
      }
    >
      {w.skill ? (
        <p className="bg-popover text-muted-foreground rounded-md border px-4 py-3 text-xs">
          {t('skillLine', { date: date(w.skill.exported_at) })}{' '}
          <code className="text-foreground font-mono">{w.skill.path}</code>{' '}
          <Link
            href={`/projects/${w.skill.project_id}`}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {t('openProject')}
          </Link>
        </p>
      ) : null}

      <dl className="bg-background grid grid-cols-2 rounded-md border sm:grid-cols-4 xl:grid-cols-7">
        <Stat label={tw('col.runs')} value={Math.round(w.runs_per_week)} />
        <Stat label={t('typical')} value={duration(w.duration_p50_s)} />
        <Stat label={tw('col.people')} value={w.people_count} />
        <Stat label={tw('col.apps')} value={w.apps.join(', ') || '–'} />
        <Stat
          label={t('success')}
          value={w.success_rate === null ? '–' : percent(w.success_rate)}
        />
        <Stat label={t('determinism')} value={percent(w.determinism)} />
        <Stat
          label={tw('col.automation')}
          value={tw('perWeekShort', { hours: hours(w.automation_hours_per_week) })}
        />
      </dl>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="capture-steps"
          className="bg-background min-w-0 rounded-md border"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-3">
            <h2 id="capture-steps" className="text-foreground text-sm font-medium">
              {t('procedure', { count: w.steps.length })}
            </h2>
            <span className="text-muted-foreground text-xs">{t('variablesHint')}</span>
          </div>
          {w.steps.length === 0 ? (
            <p className="text-muted-foreground border-t px-4 py-6 text-center text-xs">
              {t('noSteps')}
            </p>
          ) : (
            <ol>
              {w.steps.map((step) => (
                <li key={step.index} className="flex gap-3 border-t px-4 py-3">
                  <span className="text-muted-foreground w-5 shrink-0 pt-0.5 text-xs tabular-nums">
                    {step.index}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                      <span className="text-foreground font-medium">{step.verb}</span>
                      <span className="text-foreground">{step.object}</span>
                      {(step.variables ?? []).map((v) => (
                        <Badge
                          key={v}
                          variant="outline"
                          size="sm"
                          className="font-mono normal-case"
                        >
                          {`{${v}}`}
                        </Badge>
                      ))}
                    </p>
                    {step.params ? (
                      <p className="text-muted-foreground text-xs">{step.params}</p>
                    ) : null}
                    {step.decision ? (
                      <p className="bg-popover text-foreground flex items-start gap-2 rounded-sm border px-2.5 py-1.5 text-xs">
                        <GitBranchIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                        {t('decision', {
                          question: step.decision.question,
                          variant: step.decision.variant,
                          share: percent(step.decision.share),
                        })}
                      </p>
                    ) : null}
                  </div>
                  {step.app ? (
                    <span className="text-muted-foreground shrink-0 text-xs">{step.app}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="capture-variants" className="bg-background rounded-md border">
            <div className="space-y-0.5 px-4 pt-4 pb-3">
              <h2 id="capture-variants" className="text-foreground text-sm font-medium">
                {t('variants')}
              </h2>
              <p className="text-muted-foreground text-xs">{t('variantsHint')}</p>
            </div>
            {w.variants.map((v) => (
              <div key={v.key} className="space-y-2 border-t px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground text-sm font-medium">
                    {v.key} · {v.name}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {percent(v.share)}
                  </span>
                </div>
                <div
                  className="flex gap-0.5"
                  aria-label={t('variantSteps', { count: v.steps_count, differ: v.differs.length })}
                  role="img"
                >
                  {Array.from({ length: Math.max(v.steps_count, 1) }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        'h-1.5 flex-1 rounded-full',
                        v.differs.includes(i + 1) ? 'bg-foreground' : 'bg-muted-foreground/25',
                      )}
                    />
                  ))}
                </div>
                {v.note ? <p className="text-muted-foreground text-xs">{v.note}</p> : null}
              </div>
            ))}
          </section>

          <section aria-labelledby="capture-who" className="bg-background rounded-md border">
            <h2 id="capture-who" className="text-foreground px-4 pt-4 pb-3 text-sm font-medium">
              {t('who')}
            </h2>
            <ul>
              {w.people.map((p) => {
                const person = people.personOf(p.user_id);
                return (
                  <li key={p.user_id} className="flex items-center gap-3 border-t px-4 py-2.5">
                    <UserAvatar email={person.email ?? ''} size="sm" />
                    <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                      {person.isYou ? t('you') : (person.email ?? t('aMember'))}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {t('personRuns', { count: p.runs, duration: duration(p.duration_p50_s) })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>

      <RunsSection
        accountId={accountId}
        workflow={w}
        variantName={(key) => variantOf.get(key ?? '')?.name ?? key ?? '–'}
      />

      {area.isAdmin ? (
        <>
          <ReviewModal
            accountId={accountId}
            workflow={w}
            open={reviewOpen}
            onOpenChange={setReviewOpen}
          />
          <SkillExportModal
            accountId={accountId}
            workflow={w}
            open={skillOpen}
            onOpenChange={setSkillOpen}
          />
        </>
      ) : null}
    </CapturePage>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground text-base font-medium text-pretty tabular-nums">{value}</dd>
    </div>
  );
}

const RUNS_PAGE = 20;

/** Every run of the workflow, newest first, 20 at a time; each opens its device timeline at the run's start. */
function RunsSection({
  accountId,
  workflow,
  variantName,
}: {
  accountId: string;
  workflow: CaptureWorkflowDetail;
  variantName: (key: string | null) => string;
}) {
  const t = useTranslations('capture.workflow');
  const tDevices = useTranslations('capture.devices');
  const locale = useLocale();
  const duration = useRunDuration();
  const people = useCaptureDirectory(accountId, true);
  const episodes = useCaptureEpisodes(accountId, {
    workflowId: workflow.workflow_id,
    scope: 'account',
    limit: 100,
  });
  const devices = useCaptureDevices(accountId, { scope: 'account' });
  const deviceById = new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d]));
  const all = episodes.data?.episodes ?? [];
  const [shown, setShown] = useState(RUNS_PAGE);
  const rows = all.slice(0, shown);
  const grid =
    'grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,10rem)_9rem_5rem_minmax(7rem,1fr)_minmax(8rem,1fr)_8rem] items-center gap-4';
  return (
    <section
      aria-labelledby="capture-runs"
      className="bg-background overflow-hidden rounded-md border"
    >
      <div className="space-y-0.5 px-4 pt-4 pb-3">
        <h2 id="capture-runs" className="text-foreground text-sm font-medium">
          {t('runs')}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t('runsHint', { count: workflow.runs_total })}
        </p>
      </div>
      {episodes.isLoading ? (
        <div className="space-y-2 border-t px-4 py-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 rounded-md" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="border-t px-4 py-8">
          <EmptyState size="sm" title={t('noRuns')} />
        </div>
      ) : (
        <div className="overflow-x-auto border-t">
          <div className="min-w-4xl">
            <div className={`${grid} text-muted-foreground border-b px-4 py-2 text-xs`}>
              <span>{t('col.person')}</span>
              <span>{t('col.device')}</span>
              <span>{t('col.started')}</span>
              <span>{t('col.duration')}</span>
              <span>{t('col.variant')}</span>
              <span>{t('col.outcome')}</span>
              <span className="sr-only">{t('col.open')}</span>
            </div>
            <ul>
              {rows.map((ep) => {
                const person = people.personOf(ep.user_id);
                const device = ep.device_id ? deviceById.get(ep.device_id) : undefined;
                return (
                  <li
                    key={ep.episode_id}
                    className={`${grid} border-b px-4 py-2.5 text-sm last:border-b-0`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <UserAvatar email={person.email ?? ''} size="xs" />
                      <span className="truncate">
                        {person.isYou ? t('you') : (person.email ?? t('aMember'))}
                      </span>
                    </span>
                    <span className="text-muted-foreground truncate">
                      {device ? deviceName(device, tDevices('unnamed')) : '–'}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {new Date(ep.start_at).toLocaleString(locale, {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="text-xs tabular-nums">{duration(ep.duration_s)}</span>
                    <span className="truncate">{variantName(ep.variant_key)}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {ep.outcome ?? '–'}
                    </span>
                    <span className="text-right">
                      {ep.device_id ? (
                        <Button asChild variant="ghost" size="sm" className="gap-1.5">
                          <Link
                            href={captureHref(
                              accountId,
                              'devices',
                              `/${ep.device_id}?at=${encodeURIComponent(ep.start_at)}`,
                            )}
                          >
                            {t('openTimeline')}
                            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                          </Link>
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          {all.length > shown ? (
            <div className="border-t px-4 py-2.5">
              <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + RUNS_PAGE)}>
                {t('moreRuns', { count: Math.min(RUNS_PAGE, all.length - shown) })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Review: rename and restate the workflow; it then reads as reviewed. */
function ReviewModal({
  accountId,
  workflow,
  open,
  onOpenChange,
}: {
  accountId: string;
  workflow: CaptureWorkflowDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('capture.workflow');
  const review = useReviewCaptureWorkflow(accountId);
  const [name, setName] = useState(workflow.name);
  const [goal, setGoal] = useState(workflow.goal ?? '');
  const [outcome, setOutcome] = useState(workflow.outcome ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    review.mutate(
      {
        workflowId: workflow.workflow_id,
        review: { name: name.trim(), goal: goal.trim(), outcome: outcome.trim() },
      },
      {
        onSuccess: () => {
          successToast(t('reviewed'));
          onOpenChange(false);
        },
        onError: (error) => errorToast(error instanceof Error ? error.message : t('reviewFailed')),
      },
    );
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('reviewTitle')}</ModalTitle>
          <ModalDescription>{t('reviewDescription')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="capture-wf-name">{t('reviewName')}</FieldLabel>
                <Input
                  id="capture-wf-name"
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="capture-wf-goal">{t('reviewGoal')}</FieldLabel>
                <Textarea
                  id="capture-wf-goal"
                  rows={2}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="capture-wf-outcome">{t('reviewOutcome')}</FieldLabel>
                <Textarea
                  id="capture-wf-outcome"
                  rows={2}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || review.isPending}>
              {review.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('markReviewed')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
