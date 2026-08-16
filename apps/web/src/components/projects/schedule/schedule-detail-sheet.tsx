'use client';

/**
 * The panel behind a row click.
 *
 * **What changed and why.** This used to be a flat column of seven equal
 * sections — Name, Schedule, Prompt template, Delivery filter, Agent & model,
 * Properties — each with its own Save button that appeared and vanished as you
 * typed, and no `SheetTitle` at all (so the dialog had no accessible name).
 * Everything sat at one level, which is what "no hierarchy, showing random
 * things" describes: the trigger's source file path had the same visual weight
 * as the instruction the agent actually runs.
 *
 * Now the panel answers four questions in order, each in its own titled block:
 * what it does, when it runs (or how it is called), who runs it, and what it
 * remembers between runs. Everything that is a fact rather than a setting —
 * the id, the file it lives in, the last run — moved into a collapsed Details
 * block at the bottom, where it is available without being in the way.
 */

import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import { SharingPicker, type SharingSelection } from '@/features/workspace/shared/sharing-picker';
import { cn } from '@/lib/utils';
import {
  type ProjectTrigger,
  type UpdateProjectTriggerInput,
  listProjectSessions,
  updateProjectTrigger,
} from '@kortix/sdk';
import {
  type ModelKey,
  contract,
  modelKeyToWire,
  qk,
  useRuntimeProviders,
  useVisibleAgents,
  wireToModelKey,
} from '@kortix/sdk/react';
import {
  CaretDownIcon,
  DotsThreeIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  TimerIcon,
  TrashIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  CUSTOM_TIMING_LABEL,
  type SessionMode,
  describeCadence,
  describeLastRun,
  describeRunLocation,
  describeSecurity,
  describeWhen,
  triggerName,
  triggerStatus,
} from './schedule-copy';
import {
  type ConditionRow,
  ConditionsEditor,
  CopyBlock,
  PanelSection,
  PropertyList,
  RunLocationFields,
  SaveButton,
  TimezoneField,
  conditionsToRows,
  rowsToConditions,
  sameConditions,
} from './schedule-fields';

const PLACEHOLDERS = ['{{ message.text }}', '{{ message.source }}', '{{ fired_at }}'];

/** A copy-pasteable request for whoever is wiring the other end up. */
function buildSampleRequest(url: string): string {
  return [
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Kortix-Signature: sha256=$(echo -n '$BODY' | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\`,
    `  -d '$BODY'`,
    ``,
    `# $BODY   is the JSON you want to send, e.g. {"event":"deploy.succeeded"}`,
    `# $SECRET is the signing key you saved for this webhook`,
  ].join('\n');
}

export function ScheduleDetailSheet({
  projectId,
  trigger,
  canWrite,
  open,
  onOpenChange,
  onRun,
  running,
  onDelete,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger | null;
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: () => void;
  running: boolean;
  onDelete: () => void;
  onMutated: () => void;
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateProjectTrigger(projectId, trigger!.slug, { enabled }),
    onSuccess: (_data, enabled) => {
      successToast(enabled ? 'Resumed' : 'Paused');
      onMutated();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Could not update'),
  });

  if (!trigger) return null;

  const isCron = trigger.type === 'cron';
  const status = triggerStatus(trigger.enabled);
  const KindIcon = isCron ? TimerIcon : WebhooksLogoIcon;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `overflow-y-auto` on the CONTENT, not on a flex child.

          This sheet used to be `flex flex-col` with the scrolling delegated to
          `SheetBody` (`flex-1 min-h-0 overflow-y-auto`). That is the textbook
          pattern and the merged classes were provably correct — and it still
          would not scroll. The one sheet in this app that reliably scrolls a
          long body (`app/admin/accounts/page.tsx:1139`) does not use the flex
          pattern at all: it scrolls the content element itself. So this does
          the same, rather than keep defending a chain that reads right and
          behaves wrong.

          `!overflow-y-auto` is the important part, and the `!` is load-bearing:
          `sheetVariants`' base sets `overflow-hidden`, and twMerge does NOT
          treat that as conflicting with `overflow-y-auto` — they are different
          utility groups, so BOTH survive the merge. `overflow: hidden` then
          still clamps the y axis depending on which rule the stylesheet emits
          last. Verified by computing the merged string: without the `!`, the
          class list contains `overflow-hidden … overflow-y-auto` together.
          The important flag settles it regardless of source order. */}
      <SheetContent side="right" className="w-full gap-0 !overflow-y-auto p-0 sm:max-w-xl">
        {/* `text-left` is not redundant: SheetHeader's base is
            `text-center sm:text-left`, which would centre the description on
            a phone while the title row beside it stays left-aligned. */}
        {/* Sticky, because the content element is now what scrolls: without
            this the Run now / Pause actions would scroll away and you would
            have to come back up to reach them. `bg-sidebar` matches the
            sheet's own surface so content passes behind it, not through it. */}
        <SheetHeader className="bg-sidebar sticky top-0 z-10 space-y-3 px-4 pt-4 pb-4 text-left">
          <div className="flex min-w-0 items-center gap-3 pr-10">
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-sm',
                status.tileClassName,
              )}
              aria-hidden="true"
            >
              <KindIcon weight="fill" className={cn('size-5 shrink-0', status.iconClassName)} />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTitle className="truncate text-base font-semibold tracking-tight">
                  {triggerName(trigger)}
                </SheetTitle>
                <Badge variant={status.active ? 'kortix' : 'muted'} size="sm">
                  {status.label}
                </Badge>
              </div>
              <SheetDescription className="text-xs">{describeWhen(trigger)}</SheetDescription>
            </div>
          </div>

          {canWrite ? (
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="gap-1.5" onClick={onRun} disabled={running}>
                {running ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon weight="fill" className="size-3.5 shrink-0" />
                )}
                Run now
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => toggle.mutate(!trigger.enabled)}
                disabled={toggle.isPending}
              >
                {toggle.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : status.active ? (
                  <PauseIcon weight="fill" className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon weight="fill" className="size-3.5 shrink-0" />
                )}
                {status.active ? 'Pause' : 'Resume'}
              </Button>
              <div className="min-w-2 flex-1" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="More actions">
                    <DotsThreeIcon className="size-4 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <TrashIcon className="size-3.5 shrink-0" />
                    Delete {isCron ? 'schedule' : 'webhook'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </SheetHeader>

        {/* `items-stretch` overrides SheetBody's `items-start`, which would
            otherwise shrink-wrap every panel to its content width. */}
        {/* `items-stretch` overrides SheetBody's `items-start`, which would
            otherwise shrink-wrap every panel to its content width.

            Deliberately NOT a scroll container any more: the content element
            above owns scrolling now, and a second `overflow-y-auto` here would
            recreate exactly the nested-scroller bug this sheet already had —
            the wheel going to whichever surface the cursor sits over. `flex-1`
            and `min-h-0` go with it; they only meant anything while this was
            the flex child that scrolled. */}
        <SheetBody className="items-stretch gap-0 space-y-4 overflow-visible px-4 pt-0 pb-8">
          <WhatItDoesPanel
            projectId={projectId}
            trigger={trigger}
            canWrite={canWrite}
            onMutated={onMutated}
          />

          {isCron ? (
            <WhenItRunsPanel
              projectId={projectId}
              trigger={trigger}
              canWrite={canWrite}
              onMutated={onMutated}
            />
          ) : (
            <>
              <AddressPanel
                projectId={projectId}
                trigger={trigger}
                canWrite={canWrite}
                onMutated={onMutated}
              />
              <ConditionsPanel
                projectId={projectId}
                trigger={trigger}
                canWrite={canWrite}
                onMutated={onMutated}
              />
            </>
          )}

          <AgentPanel
            projectId={projectId}
            trigger={trigger}
            canWrite={canWrite}
            onMutated={onMutated}
          />

          <MemoryPanel
            projectId={projectId}
            trigger={trigger}
            canWrite={canWrite}
            onMutated={onMutated}
          />

          <AccessPanel
            projectId={projectId}
            trigger={trigger}
            canWrite={canWrite}
            onMutated={onMutated}
          />

          <DetailsPanel trigger={trigger} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/* ─── What it does — name + instruction ─────────────────────────────────── */

function WhatItDoesPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const [name, setName] = useState(trigger.name);
  const [instruction, setInstruction] = useState(trigger.prompt_template);

  useEffect(() => {
    setName(trigger.name);
  }, [trigger.name]);
  useEffect(() => {
    setInstruction(trigger.prompt_template);
  }, [trigger.prompt_template]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, {
        name: name.trim(),
        prompt_template: instruction,
      }),
    onSuccess: () => {
      successToast('Saved');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not save'),
  });

  if (!canWrite) {
    return (
      <PanelSection title="What it does" description="The instruction sent to the agent each run.">
        <p className="text-foreground text-sm leading-relaxed whitespace-pre-wrap">
          {trigger.prompt_template}
        </p>
      </PanelSection>
    );
  }

  const dirty =
    (name.trim() !== trigger.name && name.trim().length > 0) ||
    instruction !== trigger.prompt_template;
  const valid = name.trim().length > 0 && instruction.trim().length > 0;

  return (
    <PanelSection
      title="What it does"
      description="The instruction sent to the agent each time this runs."
      action={
        <SaveButton dirty={dirty && valid} pending={save.isPending} onSave={() => save.mutate()} />
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="schedule-name" className="text-xs">
          Name
        </Label>
        <Input
          id="schedule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="Daily standup digest"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-instruction" className="text-xs">
          Instruction
        </Label>
        <Textarea
          id="schedule-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={5}
          className="resize-y leading-relaxed"
          placeholder="Write today's status report and save it to /workspace/reports/"
        />
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          You can drop details from the incoming message straight into the instruction:{' '}
          {PLACEHOLDERS.map((p, i) => (
            <span key={p}>
              {i > 0 ? ', ' : ''}
              <code className="font-mono">{p}</code>
            </span>
          ))}
          .
        </p>
      </div>
    </PanelSection>
  );
}

/* ─── When it runs — schedules only ─────────────────────────────────────── */

function WhenItRunsPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState(trigger.cron ?? '0 0 9 * * *');
  const [runAt, setRunAt] = useState<string | null>(trigger.run_at);
  const [timezone, setTimezone] = useState(trigger.timezone);

  useEffect(() => {
    if (editing) return;
    setCron(trigger.cron ?? '0 0 9 * * *');
    setRunAt(trigger.run_at);
    setTimezone(trigger.timezone);
  }, [trigger.cron, trigger.run_at, trigger.timezone, editing]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(
        projectId,
        trigger.slug,
        // `run_at` and `cron` are mutually exclusive, so switching between
        // them means explicitly clearing the other.
        runAt
          ? { run_at: runAt, cron: null, timezone }
          : { cron: cron.trim(), run_at: null, timezone },
      ),
    onSuccess: () => {
      successToast('Schedule updated');
      setEditing(false);
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update the schedule'),
  });

  const action = !canWrite ? null : editing ? (
    <ButtonGroup>
      <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={save.isPending || (!runAt && !cron.trim())}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
        Save
      </Button>
    </ButtonGroup>
  ) : (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
      <PencilSimpleIcon className="size-3.5 shrink-0" />
      Edit
    </Button>
  );

  if (canWrite && editing) {
    return (
      <PanelSection title="When it runs" action={action}>
        <ScheduleBuilder
          value={cron}
          onChange={setCron}
          allowOnce
          runAt={runAt}
          onRunAtChange={setRunAt}
        />
        {!runAt && <TimezoneField value={timezone} onChange={setTimezone} />}
      </PanelSection>
    );
  }

  // Only surface the raw expression when the plain summary can't carry it —
  // otherwise the sentence above is the whole truth and cron syntax is noise.
  const custom =
    !trigger.run_at && trigger.cron ? describeCadence(trigger.cron) === CUSTOM_TIMING_LABEL : false;

  return (
    <PanelSection title="When it runs" action={action}>
      <PropertyList
        rows={[
          { label: 'Runs', value: describeWhen(trigger) },
          ...(trigger.run_at ? [] : [{ label: 'Timezone', value: trigger.timezone }]),
          ...(custom
            ? [
                {
                  label: 'Timing',
                  value: <code className="font-mono text-xs">{trigger.cron}</code>,
                },
              ]
            : []),
        ]}
      />
    </PanelSection>
  );
}

/* ─── Address — webhooks only ───────────────────────────────────────────── */

function AddressPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const url = trigger.webhook_url ?? '';
  const sample = useMemo(() => buildSampleRequest(url), [url]);
  const security = describeSecurity(trigger);

  const [secretName, setSecretName] = useState(trigger.secret_env ?? '');
  useEffect(() => {
    setSecretName(trigger.secret_env ?? '');
  }, [trigger.secret_env]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, { secret_env: secretName.trim() }),
    onSuccess: () => {
      successToast('Signing key updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update the signing key'),
  });

  const dirty = secretName.trim().length > 0 && secretName.trim() !== (trigger.secret_env ?? '');

  return (
    <PanelSection
      title="Address"
      description="Give this to the other app. It starts a run whenever it receives a request."
      action={
        canWrite ? (
          <SaveButton dirty={dirty} pending={save.isPending} onSave={() => save.mutate()} />
        ) : null
      }
    >
      <CopyBlock value={url} label="Copy address" copiedLabel="Address copied" />

      <InfoBanner tone={security.signed ? 'success' : 'warning'} className="text-xs">
        {security.detail}
      </InfoBanner>

      {canWrite ? (
        <div className="space-y-1.5">
          <Label htmlFor="webhook-signing-key" className="text-xs">
            Signing key
          </Label>
          <Input
            id="webhook-signing-key"
            value={secretName}
            onChange={(e) => setSecretName(e.target.value.toUpperCase())}
            placeholder="WEBHOOK_MY_TRIGGER_SECRET"
            className="font-mono text-sm"
          />
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            The name of a saved secret holding the key both sides sign with. Add the secret under
            Secrets first — the key itself is never stored here.
          </p>
        </div>
      ) : null}

      {/* Borderless on purpose — a bordered box here would be a second
          rounded surface inside the panel, and the sample is a reference
          most people never open. */}
      <Disclosure className="group">
        <DisclosureTrigger>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -mx-2 w-[calc(100%+1rem)] justify-between px-2"
          >
            Sample request
            <CaretDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="space-y-2 pt-2">
            <CopyBlock
              value={sample}
              multiline
              label="Copy sample request"
              copiedLabel="Sample request copied"
            />
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              The signature has to cover the request body exactly as it is sent, byte for byte.
            </p>
          </div>
        </DisclosureContent>
      </Disclosure>
    </PanelSection>
  );
}

/* ─── Conditions — webhooks only ────────────────────────────────────────── */

function ConditionsPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const [rows, setRows] = useState<ConditionRow[]>(() => conditionsToRows(trigger.filter));

  // The list refetches every 10s and `trigger.filter` is a fresh object each
  // time — resetting on its identity would wipe whatever is being typed. Key
  // the reset off its value instead.
  const saved = JSON.stringify(trigger.filter ?? {});
  useEffect(() => {
    setRows(conditionsToRows(JSON.parse(saved) as Record<string, string>));
  }, [saved]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, { filter: rowsToConditions(rows) }),
    onSuccess: () => {
      successToast('Conditions saved');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not save the conditions'),
  });

  if (!canWrite) {
    const entries = Object.entries(trigger.filter ?? {});
    return (
      <PanelSection title="Only run when" description="Requests that don't match are ignored.">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No conditions — every request starts a run.
          </p>
        ) : (
          <PropertyList
            rows={entries.map(([path, value]) => ({
              label: path,
              value: <code className="font-mono text-xs">{value}</code>,
            }))}
          />
        )}
      </PanelSection>
    );
  }

  return (
    <PanelSection
      title="Only run when"
      description="Ignore requests you don't care about. Leave empty to run on all of them."
      action={
        <SaveButton
          dirty={!sameConditions(rowsToConditions(rows), trigger.filter)}
          pending={save.isPending}
          onSave={() => save.mutate()}
        />
      }
    >
      <ConditionsEditor rows={rows} onChange={setRows} disabled={save.isPending} />
    </PanelSection>
  );
}

/* ─── Which agent ───────────────────────────────────────────────────────── */

function AgentPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const agents = useVisibleAgents({ projectId });
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const selectedModel = trigger.model ? wireToModelKey(trigger.model) : null;

  const saveAgent = useMutation({
    mutationFn: (agent: string) => updateProjectTrigger(projectId, trigger.slug, { agent }),
    onSuccess: () => {
      successToast('Agent updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update the agent'),
  });

  const saveModel = useMutation({
    mutationFn: (model: ModelKey | null) =>
      updateProjectTrigger(projectId, trigger.slug, {
        model: model ? modelKeyToWire(model) : null,
      }),
    onSuccess: () => {
      successToast('Model updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update the model'),
  });

  if (!canWrite) {
    return (
      <PanelSection title="Who runs it">
        <PropertyList
          rows={[
            { label: 'Agent', value: trigger.agent },
            { label: 'Model', value: trigger.model ?? "The agent's usual model" },
          ]}
        />
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Who runs it" description="The agent and model used for every run.">
      <div className="space-y-1.5">
        <Label className="text-xs">Agent</Label>
        {/* `AgentSelector` comes from the chat composer, where it is a floating
            pill in a rounded input bar. Wrapping it in `rounded-full bg-card
            inline-flex` carried that chrome into a settings sheet, where every
            other control is a full-width `rounded-md` bordered panel — so it
            read as a stray chip rather than a field. Same component, this
            surface's chrome. */}
        <div className="bg-popover flex w-full items-center rounded-md border px-2 py-1.5">
          <AgentSelector
            agents={agents}
            selectedAgent={trigger.agent}
            onSelect={(next) => next && saveAgent.mutate(next)}
            disabled={saveAgent.isPending}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">Model</Label>
          {trigger.model ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={saveModel.isPending}
              onClick={() => saveModel.mutate(null)}
            >
              Use the agent&apos;s usual model
            </Button>
          ) : null}
        </div>
        {/* Same treatment as the Agent control above — one shape for both, so
            the two rows read as a pair of fields rather than two loose chips. */}
        <div className="bg-popover flex w-full items-center rounded-md border px-2 py-1.5">
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={selectedModel}
            unsetLabel="Agent's usual model"
            onSelect={(next) => saveModel.mutate(next)}
          />
        </div>
      </div>
    </PanelSection>
  );
}

/* ─── Memory between runs (session_mode) ────────────────────────────────── */

function MemoryPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const [mode, setMode] = useState<SessionMode>(trigger.session_mode);
  const [pinned, setPinned] = useState<string | null>(trigger.session_id);
  const [key, setKey] = useState(trigger.session_key ?? '');

  useEffect(() => {
    setMode(trigger.session_mode);
    setPinned(trigger.session_id);
    setKey(trigger.session_key ?? '');
  }, [trigger.session_mode, trigger.session_id, trigger.session_key]);

  const sessions = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled: canWrite && mode === 'pinned',
    ...contract('inventory'),
  });

  const save = useMutation({
    mutationFn: (input: UpdateProjectTriggerInput) =>
      updateProjectTrigger(projectId, trigger.slug, input),
    onSuccess: () => {
      successToast('Updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update'),
  });

  if (!canWrite) {
    return (
      <PanelSection title="Memory between runs">
        <p className="text-foreground text-sm">{describeRunLocation(trigger)}</p>
      </PanelSection>
    );
  }

  return (
    <PanelSection
      title="Memory between runs"
      description="Whether the agent picks up where it left off, or starts clean."
    >
      <RunLocationFields
        mode={mode}
        onModeChange={(next) => {
          setMode(next);
          setPinned(null);
          // Pinned and per-conversation both need a second value before the
          // write can be valid — stage them and save once it is supplied.
          if (next === 'pinned' || next === 'keyed') return;
          setKey('');
          save.mutate({ session_mode: next, session_id: null, session_key: null });
        }}
        pinnedSessionId={pinned}
        onPinnedSessionChange={(sid) => {
          setPinned(sid);
          save.mutate({ session_mode: 'pinned', session_id: sid, session_key: null });
        }}
        sessionKey={key}
        onSessionKeyChange={setKey}
        sessionKeyAction={
          <SaveButton
            dirty={
              key.trim().length > 0 &&
              !(trigger.session_mode === 'keyed' && key.trim() === trigger.session_key)
            }
            pending={save.isPending}
            onSave={() =>
              save.mutate({
                session_mode: 'keyed',
                session_key: key.trim(),
                session_id: null,
              })
            }
          />
        }
        sessions={sessions.data ?? []}
        sessionsLoading={sessions.isLoading}
        disabled={save.isPending}
      />
    </PanelSection>
  );
}

function accessSummary(access: ProjectTrigger['session_access']): string {
  if (access.mode === 'project') return 'Every project member can open trigger-created sessions.';
  if (access.mode === 'members') {
    const count = access.memberIds.length + access.groupIds.length;
    return `${count} selected ${count === 1 ? 'member or group can' : 'members or groups can'} open trigger-created sessions.`;
  }
  return 'Only the trigger agent can open trigger-created sessions.';
}

function AccessPanel({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const [selection, setSelection] = useState<SharingSelection>(trigger.session_access);

  useEffect(() => {
    setSelection(trigger.session_access);
  }, [trigger.session_access]);

  const save = useMutation({
    mutationFn: () => updateProjectTrigger(projectId, trigger.slug, { session_access: selection }),
    onSuccess: () => {
      successToast('Session access updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not update session access'),
  });

  if (!canWrite) {
    return (
      <PanelSection
        title="Session access"
        description="Who can open sessions created by this trigger."
      >
        <p className="text-foreground text-sm">{accessSummary(trigger.session_access)}</p>
        {trigger.session_mode === 'pinned' ? (
          <p className="text-muted-foreground text-xs">
            The pinned session keeps its own sharing settings.
          </p>
        ) : null}
      </PanelSection>
    );
  }

  const dirty =
    selection.mode !== trigger.session_access.mode ||
    selection.memberIds.join(',') !== trigger.session_access.memberIds.join(',') ||
    selection.groupIds.join(',') !== trigger.session_access.groupIds.join(',');

  return (
    <PanelSection
      title="Session access"
      description="Who can open sessions created by this trigger. Saving also updates its prior sessions."
      action={<SaveButton dirty={dirty} pending={save.isPending} onSave={() => save.mutate()} />}
    >
      <SharingPicker
        projectId={projectId}
        value={selection}
        onChange={setSelection}
        showHeading={false}
        copy={{
          heading: 'Who can access sessions created by this trigger',
          private: {
            label: 'Only the trigger agent',
            desc: 'No teammates can open these sessions unless you add them.',
          },
          members: {
            label: 'Selected teammates',
            desc: 'Choose members and groups that can open these sessions.',
          },
          project: {
            label: 'Whole project',
            desc: 'Every project member can open these sessions.',
          },
        }}
      />
      {trigger.session_mode === 'pinned' ? (
        <InfoBanner tone="info" className="text-xs">
          The pinned session keeps its own sharing settings. This policy applies if the trigger
          creates a fallback session.
        </InfoBanner>
      ) : null}
    </PanelSection>
  );
}

/* ─── Details — facts, not settings ─────────────────────────────────────── */

function DetailsPanel({ trigger }: { trigger: ProjectTrigger }) {
  return (
    <Disclosure className="group bg-popover overflow-hidden rounded-md border">
      <DisclosureTrigger>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground w-full justify-between rounded-none px-4 py-3"
        >
          Details
          <CaretDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="border-border/60 border-t px-4 py-4">
          <PropertyList
            rows={[
              {
                label: 'ID',
                value: <code className="font-mono text-xs">{trigger.slug}</code>,
              },
              {
                label: 'Saved in',
                value: <code className="font-mono text-xs">{trigger.path}</code>,
              },
              {
                label: 'Last run',
                value: (
                  <span className="tabular-nums">
                    {trigger.last_fired_at
                      ? new Date(trigger.last_fired_at).toLocaleString()
                      : describeLastRun(null)}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
