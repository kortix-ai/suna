'use client';

import type { AgentProfile, AgentProfileAutomation } from '@kortix/sdk';
import type { useAgentProfileMutations } from '@kortix/sdk/react';
import {
  CalendarDotsIcon,
  PauseCircleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';

import {
  activeProfileSections,
  nextScheduleRuns,
  slugifyCapabilityName,
} from './agent-profile-utils';

type ProfileMutations = ReturnType<typeof useAgentProfileMutations>;

interface AutomationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  mutations: ProfileMutations;
  onConflict: () => void;
}

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const RUN_FORMATTERS = new Map(
  TIMEZONES.map((timeZone) => [
    timeZone,
    new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }),
  ]),
);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRun(value: string, timeZone: string): string {
  const formatter =
    RUN_FORMATTERS.get(timeZone) ??
    new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    });
  return formatter.format(new Date(value));
}

function AutomationEditorModal({
  open,
  onOpenChange,
  profile,
  automation,
  onSave,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  automation: AgentProfileAutomation | null;
  onSave: (automation: AgentProfileAutomation) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(automation?.name ?? '');
  const [prompt, setPrompt] = useState(automation?.prompt ?? '');
  const [cron, setCron] = useState(
    automation && !automation.schedule.includes('T') ? automation.schedule : '0 0 9 * * 1-5',
  );
  const [runAt, setRunAt] = useState<string | null>(
    automation?.schedule.includes('T') ? automation.schedule : null,
  );
  const [timezone, setTimezone] = useState(automation?.timezone ?? 'UTC');
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const schedule = runAt ?? cron;
  const nextRuns = useMemo(() => {
    if (!enabled) return [];
    try {
      return nextScheduleRuns(schedule, timezone);
    } catch {
      return [];
    }
  }, [enabled, schedule, timezone]);
  const slug = automation?.slug ?? slugifyCapabilityName(name);
  const canSave = Boolean(
    name.trim() && prompt.trim() && slug && (!enabled || nextRuns.length > 0),
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{automation ? 'Edit schedule' : 'New schedule'}</ModalTitle>
          <ModalDescription>
            Every run uses <span className="text-foreground font-medium">{profile.agent_name}</span>
            .
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[72vh] space-y-5 overflow-y-auto pt-5">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="automation-name">Name</FieldLabel>
              <Input
                id="automation-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Weekly customer summary"
                maxLength={500}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="automation-prompt">Task</FieldLabel>
              <Textarea
                id="automation-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Summarize open customer issues and send the report to the support team."
                minHeight={112}
                maxHeight={220}
              />
            </Field>
            <Field>
              <FieldLabel>Schedule</FieldLabel>
              <ScheduleBuilder
                value={cron}
                onChange={setCron}
                allowOnce
                runAt={runAt}
                onRunAtChange={setRunAt}
              />
              {!runAt ? (
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger aria-label="Schedule timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </Field>
            <Field>
              <div className="flex min-h-10 items-center justify-between gap-3">
                <div>
                  <FieldLabel htmlFor="automation-enabled">Enable after publication</FieldLabel>
                  <FieldDescription>Draft schedules never run before publication.</FieldDescription>
                </div>
                <Switch id="automation-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </Field>
            <section className="space-y-2" aria-labelledby="next-runs-heading">
              <h3 id="next-runs-heading" className="text-sm font-medium">
                Next runs
              </h3>
              {nextRuns.length > 0 ? (
                <ol className="border-border divide-border divide-y border-y">
                  {nextRuns.map((run, index) => (
                    <li key={run} className="flex min-h-9 items-center gap-3 text-xs">
                      <span className="text-muted-foreground w-4 tabular-nums">{index + 1}</span>
                      <time className="tabular-nums" dateTime={run}>
                        {formatRun(run, timezone)}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {enabled ? 'Choose a valid future schedule.' : 'This schedule is paused.'}
                </p>
              )}
            </section>
          </FieldGroup>
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave || pending}
            onClick={() =>
              onSave({
                slug,
                name: name.trim(),
                prompt: prompt.trim(),
                enabled,
                schedule,
                timezone: runAt ? 'UTC' : timezone,
                next_runs: nextRuns,
                status: enabled ? 'pending_publication' : 'paused',
              })
            }
          >
            {pending ? <Loading className="size-3" /> : null}
            Save to draft
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function AgentProfileAutomationsDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: AutomationsDialogProps) {
  const automations = activeProfileSections(profile).automations ?? [];
  const [editorTarget, setEditorTarget] = useState<AgentProfileAutomation | null | undefined>(
    undefined,
  );
  const [removeTarget, setRemoveTarget] = useState<AgentProfileAutomation | null>(null);
  const [safetyPending, setSafetyPending] = useState<string | null>(null);

  const stage = async (next: AgentProfileAutomation[], message: string) => {
    try {
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: { automations: next },
      });
      successToast(message);
      setEditorTarget(undefined);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Schedule draft could not be updated'));
    }
  };

  const save = (automation: AgentProfileAutomation) => {
    void stage(
      [...automations.filter((entry) => entry.slug !== automation.slug), automation],
      `${automation.name} saved to the draft`,
    );
  };

  const pause = async (automation: AgentProfileAutomation) => {
    setSafetyPending(automation.slug);
    try {
      if (automation.status === 'active') {
        await mutations.pauseAutomation.mutateAsync(automation.slug);
      }
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: {
          automations: automations.map((entry) =>
            entry.slug === automation.slug
              ? { ...entry, enabled: false, status: 'paused', next_runs: [] }
              : entry,
          ),
        },
      });
      successToast(`${automation.name} paused`);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Schedule could not be paused'));
    } finally {
      setSafetyPending(null);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setSafetyPending(removeTarget.slug);
    try {
      if (removeTarget.status === 'active') {
        await mutations.pauseAutomation.mutateAsync(removeTarget.slug);
      }
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: {
          automations: automations.filter((entry) => entry.slug !== removeTarget.slug),
        },
      });
      successToast(`${removeTarget.name} removed from the draft`);
      setRemoveTarget(null);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Schedule could not be removed'));
    } finally {
      setSafetyPending(null);
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent variant="base" className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Automations</ModalTitle>
            <ModalDescription>Schedule tasks for {profile.agent_name}.</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] space-y-4 overflow-y-auto pt-5">
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setEditorTarget(null)}>
                <PlusIcon className="size-3.5" />
                New schedule
              </Button>
            </div>
            {automations.length === 0 ? (
              <div className="border-border flex min-h-28 items-center justify-center gap-3 border-y py-5 text-center">
                <CalendarDotsIcon className="text-muted-foreground size-5" />
                <p className="text-muted-foreground text-sm">No schedules for this agent.</p>
              </div>
            ) : (
              <div className="divide-border divide-y">
                {automations.map((automation) => (
                  <article key={automation.slug} className="flex gap-3 py-3">
                    <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                      <CalendarDotsIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{automation.name}</h3>
                        <Badge
                          size="xs"
                          variant={
                            automation.status === 'active'
                              ? 'success'
                              : automation.status === 'paused'
                                ? 'muted'
                                : 'warning'
                          }
                        >
                          {automation.status === 'pending_publication'
                            ? 'Draft'
                            : automation.status === 'active'
                              ? 'Active'
                              : 'Paused'}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-1 truncate text-xs">
                        {automation.next_runs[0]
                          ? `Next: ${formatRun(automation.next_runs[0], automation.timezone)}`
                          : automation.schedule}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-start gap-1">
                      {automation.enabled ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Pause ${automation.name}`}
                          disabled={safetyPending === automation.slug}
                          onClick={() => void pause(automation)}
                        >
                          {safetyPending === automation.slug ? (
                            <Loading className="size-3.5" />
                          ) : (
                            <PauseCircleIcon className="size-4" />
                          )}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${automation.name}`}
                        onClick={() => setEditorTarget(automation)}
                      >
                        <PencilSimpleIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${automation.name}`}
                        onClick={() => setRemoveTarget(automation)}
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </ModalBody>
          <ModalFooter className="border-border border-t py-3">
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {editorTarget !== undefined ? (
        <AutomationEditorModal
          key={editorTarget?.slug ?? 'new'}
          open
          onOpenChange={(next) => !next && setEditorTarget(undefined)}
          profile={profile}
          automation={editorTarget}
          onSave={save}
          pending={mutations.updateDraft.isPending}
        />
      ) : null}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(next) => !next && setRemoveTarget(null)}
        title="Remove schedule"
        description={
          removeTarget
            ? `${removeTarget.name} pauses immediately and is removed when this draft is published.`
            : ''
        }
        confirmLabel="Pause and remove"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-3.5" />}
        isPending={!!removeTarget && safetyPending === removeTarget.slug}
        onConfirm={() => void remove()}
      />
    </>
  );
}
