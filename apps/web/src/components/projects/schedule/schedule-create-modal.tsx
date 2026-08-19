'use client';

/**
 * Creating a trigger — a schedule or a webhook.
 *
 * **What changed and why.** The wizard used to open on "Trigger source" —
 * a Cron / Webhook picker that could never be used, because both entry points
 * always passed a fixed type. Step one then asked for a cron expression or a
 * signing secret before asking what the thing was for, and step two dumped
 * seven equal sections on you (Name, Prompt, Agent, Model, Session strategy,
 * Delivery filter, Activation).
 *
 * Schedules and Webhooks merged into one Triggers page, so that Cron/Webhook
 * picker is no longer dead weight — it's back as this wizard's real first
 * step, now that there IS a choice to make. After that it asks what you want
 * to happen, then how it should be triggered — the order people actually
 * think in. Everything that has a sane default (memory between runs,
 * conditions, a custom id, starting paused) sits under one Advanced block on
 * the last step instead of on the main path.
 */

import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import { SharingPicker, type SharingSelection } from '@/features/workspace/shared/sharing-picker';
import { cn } from '@/lib/utils';
import { createProjectTrigger, listProjectSessions, upsertProjectSecret } from '@kortix/sdk';
import {
  type ModelKey,
  contract,
  modelKeyToWire,
  qk,
  useRuntimeProviders,
  useVisibleAgents,
} from '@kortix/sdk/react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  KIND_COPY,
  type SessionMode,
  type TriggerKind,
  describeCadence,
  describeOneOff,
} from './schedule-copy';
import {
  type ConditionRow,
  ConditionsEditor,
  RunLocationFields,
  TimezoneField,
  rowsToConditions,
} from './schedule-fields';

type Step = 'type' | 'what' | 'how';

/** A random signing key, hex-encoded. */
function generateSigningKey(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Saved-secret names are UPPER_SNAKE_CASE — mirror the API's own rule so a
 *  typed name can't fail on save. */
function normalizeSecretName(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'automation'
  );
}

export function ScheduleCreateModal({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
}) {
  const [kind, setKind] = useState<TriggerKind | null>(null);
  const copy = kind ? KIND_COPY[kind] : null;
  const isCron = kind === 'cron';

  const [step, setStep] = useState<Step>('type');
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [agentName, setAgentName] = useState<string | null>(null);
  const [model, setModel] = useState<ModelKey | null>(null);

  const [cron, setCron] = useState('0 0 9 * * *');
  const [runAt, setRunAt] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');

  const [signingKey, setSigningKey] = useState('');
  const [secretName, setSecretName] = useState('');

  const [mode, setMode] = useState<SessionMode>('fresh');
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState('');
  const [conditions, setConditions] = useState<ConditionRow[]>([]);
  const [customId, setCustomId] = useState('');
  const [startActive, setStartActive] = useState(true);
  const [sessionAccess, setSessionAccess] = useState<SharingSelection>({
    mode: 'private',
    memberIds: [],
    groupIds: [],
  });

  const [error, setError] = useState<string | null>(null);

  const agents = useVisibleAgents({ projectId });
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const sessions = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled: open && mode === 'pinned',
    ...contract('inventory'),
  });

  useEffect(() => {
    if (open) return;
    setStep('type');
    setKind(null);
    setName('');
    setInstruction('');
    setAgentName(null);
    setModel(null);
    setCron('0 0 9 * * *');
    setRunAt(null);
    setTimezone('UTC');
    setSigningKey('');
    setSecretName('');
    setMode('fresh');
    setPinnedSessionId(null);
    setSessionKey('');
    setConditions([]);
    setCustomId('');
    setStartActive(true);
    setSessionAccess({ mode: 'private', memberIds: [], groupIds: [] });
    setError(null);
  }, [open]);

  /** First-step problems, in the order a person would hit them. */
  function checkWhat(): string | null {
    if (!name.trim()) return `Give this ${copy?.noun ?? 'trigger'} a name.`;
    if (!instruction.trim()) return 'Say what the agent should do.';
    return null;
  }

  function checkHow(): string | null {
    if (isCron) {
      if (runAt) {
        if (Number.isNaN(Date.parse(runAt))) return 'Pick a valid date and time.';
        if (Date.parse(runAt) <= Date.now()) return 'Pick a time in the future.';
      } else if (!cron.trim()) {
        return 'Choose when this should run.';
      }
    } else if (!signingKey.trim()) {
      return 'Add a signing key so only your app can start this.';
    }
    if (mode === 'pinned' && !pinnedSessionId) return 'Choose which session to use.';
    if (mode === 'keyed' && !sessionKey.trim())
      return 'Say what to group runs by, so each conversation gets its own session.';
    // A half-filled condition is a silent no-op otherwise — say so instead.
    if (conditions.some((row) => Boolean(row.path.trim()) !== Boolean(row.value.trim())))
      return 'Every condition needs both a field and a value.';
    return null;
  }

  const create = useMutation({
    mutationFn: async () => {
      // `submit()` only reaches here from the 'how' step, which is
      // unreachable until a card on the 'type' step sets this. Captured into
      // a local so the narrowing survives the `await` below.
      if (!kind) throw new Error('Choose a trigger type first.');
      const triggerKind = kind;

      const trimmedName = name.trim();
      const slug = slugify(customId.trim() || trimmedName);

      let secretEnv: string | undefined;
      if (!isCron) {
        secretEnv =
          normalizeSecretName(secretName) ||
          `WEBHOOK_${slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_SECRET`;
        await upsertProjectSecret(projectId, { name: secretEnv, value: signingKey.trim() });
      }

      const filter = rowsToConditions(conditions);

      return createProjectTrigger(projectId, {
        name: trimmedName,
        slug,
        type: triggerKind,
        prompt_template: instruction.trim(),
        enabled: startActive,
        ...(agentName ? { agent: agentName } : {}),
        ...(model ? { model: modelKeyToWire(model) } : {}),
        session_access: sessionAccess,
        ...(mode !== 'fresh' ? { session_mode: mode } : {}),
        ...(mode === 'pinned' && pinnedSessionId ? { session_id: pinnedSessionId } : {}),
        ...(mode === 'keyed' ? { session_key: sessionKey.trim() } : {}),
        ...(!isCron && filter ? { filter } : {}),
        ...(isCron
          ? runAt
            ? { run_at: runAt, timezone: timezone.trim() || 'UTC' }
            : { cron: cron.trim(), timezone: timezone.trim() || 'UTC' }
          : { secret_env: secretEnv }),
      });
    },
    onSuccess: (listing) => {
      const created = listing.triggers
        .filter((t) => t.type === kind && t.name === name.trim())
        .slice(-1)[0];
      successToast(isCron ? 'Schedule created' : 'Webhook created', {
        description: isCron
          ? runAt
            ? describeOneOff(runAt)
            : describeCadence(cron.trim())
          : 'Copy its address from the panel to finish setup.',
      });
      if (created) onCreated(created.slug);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not create it'),
  });

  const stepLabels: Record<Step, string> = {
    type: 'Type',
    what: 'What it does',
    how: isCron ? 'When it runs' : "How it's called",
  };

  const chooseKind = (next: TriggerKind) => {
    setKind(next);
    setError(null);
    setStep('what');
  };

  const goForward = () => {
    const problem = checkWhat();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep('how');
  };

  const submit = () => {
    const problem = checkWhat() ?? checkHow();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (!next) onOpenChange(false);
      }}
    >
      <ModalContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" modalClassName="lg:max-w-lg">
        <ModalHeader className="pb-1">
          <ModalTitle>{copy ? copy.createLabel : 'New trigger'}</ModalTitle>
          <ModalDescription>
            {step === 'type'
              ? 'Choose how this trigger starts.'
              : isCron
                ? 'Have an agent do something on its own, on a schedule you set.'
                : 'Let another app start an agent by sending a request.'}
          </ModalDescription>
          <StepIndicator step={step} labels={stepLabels} />
        </ModalHeader>

        <ModalBody className="max-h-[min(64vh,600px)] space-y-6 overflow-y-auto px-5 py-5">
          {step === 'type' ? (
            <div className="space-y-2">
              <TypeCard
                icon={TimerIcon}
                title="Scheduled"
                description="Runs automatically on a repeating schedule, or once at a set time."
                onClick={() => chooseKind('cron')}
              />
              <TypeCard
                icon={WebhooksLogoIcon}
                title="Webhook"
                description="Starts when another app sends a request to a private address."
                onClick={() => chooseKind('webhook')}
              />
            </div>
          ) : step === 'what' && copy ? (
            <>
              <Field label="Name" hint={`Shown in your list of ${copy.noun}s.`}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Daily standup digest"
                  maxLength={64}
                  autoFocus
                />
              </Field>

              <Field
                label="Instruction"
                hint="Sent to the agent every time this runs, as if you had typed it."
              >
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Write today's status report and save it to /workspace/reports/"
                  rows={5}
                  className="leading-relaxed"
                />
              </Field>

              <Field label="Agent" hint="Which agent handles each run.">
                {/* Same shape as the detail sheet: a full-width rounded-md
                    panel, not the chat composer pill these selectors ship
                    with. The control must not look different depending on
                    whether you are creating a schedule or editing one. */}
                <div className="bg-popover flex w-full items-center rounded-md border px-2 py-1.5">
                  <AgentSelector
                    agents={agents}
                    selectedAgent={agentName}
                    onSelect={setAgentName}
                  />
                </div>
              </Field>

              <Field label="Model" hint="Leave this alone to use the agent's usual model.">
                <div className="bg-popover flex w-full items-center rounded-md border px-2 py-1.5">
                  <ModelSelector
                    models={models}
                    providers={providers}
                    selectedModel={model}
                    unsetLabel="Agent's usual model"
                    onSelect={setModel}
                  />
                </div>
              </Field>
            </>
          ) : (
            <>
              {isCron ? (
                <Field label="When it runs">
                  <ScheduleBuilder
                    value={cron}
                    onChange={setCron}
                    allowOnce
                    runAt={runAt}
                    onRunAtChange={setRunAt}
                  />
                  {!runAt && <TimezoneField value={timezone} onChange={setTimezone} />}
                </Field>
              ) : (
                <Field
                  label="Signing key"
                  hint="Both sides sign each request with this, so nobody else can start your agent."
                >
                  <div className="flex gap-2">
                    <Input
                      value={signingKey}
                      onChange={(e) => setSigningKey(e.target.value)}
                      placeholder="Paste or generate a key"
                      className="font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 gap-1.5"
                      onClick={() => setSigningKey(generateSigningKey())}
                    >
                      <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
                      Generate
                    </Button>
                  </div>
                  <InfoBanner tone="info" className="text-xs">
                    We save this as a project secret and give you the web address once the webhook
                    exists.
                  </InfoBanner>
                </Field>
              )}

              <Disclosure className="group">
                <DisclosureTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground -mx-2 w-[calc(100%+1rem)] justify-between px-2"
                  >
                    Advanced
                    <CaretDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                  </Button>
                </DisclosureTrigger>
                <DisclosureContent>
                  <div className="space-y-6 pt-4">
                    <Field
                      label="Memory between runs"
                      hint="Whether the agent picks up where it left off, or starts clean."
                    >
                      <RunLocationFields
                        mode={mode}
                        onModeChange={(next) => {
                          setMode(next);
                          if (next !== 'pinned') setPinnedSessionId(null);
                          if (next !== 'keyed') setSessionKey('');
                        }}
                        pinnedSessionId={pinnedSessionId}
                        onPinnedSessionChange={setPinnedSessionId}
                        sessionKey={sessionKey}
                        onSessionKeyChange={setSessionKey}
                        sessions={sessions.data ?? []}
                        sessionsLoading={sessions.isLoading}
                      />
                    </Field>

                    <Field
                      label="Session access"
                      hint="Pinned sessions keep their own sharing settings. This policy applies when the trigger creates a session."
                    >
                      <SharingPicker
                        projectId={projectId}
                        value={sessionAccess}
                        onChange={setSessionAccess}
                        showHeading={false}
                        copy={{
                          heading: 'Who can access sessions created by this trigger',
                          private: {
                            label: 'Trigger agent and project Managers',
                            desc: 'Project Managers can always open trigger-created sessions.',
                          },
                          members: {
                            label: 'Selected teammates',
                            desc: 'Choose additional members and groups. Project Managers always have access.',
                          },
                          project: {
                            label: 'Whole project',
                            desc: 'Every project member can open these sessions.',
                          },
                        }}
                      />
                    </Field>

                    {!isCron && (
                      <>
                        <Field
                          label="Only run when"
                          hint="Ignore requests you don't care about. Leave empty to run on all of them."
                        >
                          <ConditionsEditor rows={conditions} onChange={setConditions} />
                        </Field>

                        <Field
                          label="Name the saved secret"
                          hint="The key above is saved under this name in Secrets. Built from the name if you leave this blank."
                        >
                          <Input
                            value={secretName}
                            onChange={(e) => setSecretName(e.target.value.toUpperCase())}
                            placeholder="WEBHOOK_MY_TRIGGER_SECRET"
                            className="font-mono text-sm"
                          />
                        </Field>
                      </>
                    )}

                    <Field
                      label="Custom ID"
                      hint={
                        isCron
                          ? "Built from the name if you leave this blank. It can't be changed later."
                          : "Used at the end of the web address. Built from the name if you leave this blank, and it can't be changed later."
                      }
                    >
                      <Input
                        value={customId}
                        onChange={(e) => setCustomId(e.target.value)}
                        placeholder={name.trim() ? slugify(name.trim()) : 'daily-standup-digest'}
                        maxLength={128}
                        className="font-mono text-sm"
                      />
                    </Field>

                    <Field
                      label="Start it right away"
                      hint="Turn this off to create it paused and look it over first."
                    >
                      <div className="bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                        <Label htmlFor="schedule-start-active" className="text-sm font-normal">
                          {startActive ? 'Active' : 'Paused'}
                        </Label>
                        <Switch
                          id="schedule-start-active"
                          checked={startActive}
                          onCheckedChange={setStartActive}
                        />
                      </div>
                    </Field>
                  </div>
                </DisclosureContent>
              </Disclosure>
            </>
          )}

          {error ? (
            <InfoBanner tone="destructive" className="text-xs">
              {error}
            </InfoBanner>
          ) : null}
        </ModalBody>

        <ModalFooter className="mt-0 shrink-0 justify-between gap-2 px-5 py-4">
          {step === 'how' ? (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setStep('what')}>
              <ArrowLeftIcon className="size-4 shrink-0" />
              Back
            </Button>
          ) : step === 'what' ? (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setStep('type')}>
              <ArrowLeftIcon className="size-4 shrink-0" />
              Back
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {step === 'type' ? null : step === 'what' ? (
              <Button size="sm" className="gap-1.5" onClick={goForward}>
                Continue
                <ArrowRightIcon className="size-4 shrink-0" />
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={submit} disabled={create.isPending}>
                {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                {copy ? copy.createLabel : 'Create'}
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** Label + control + hint, with the hint under the control where it belongs —
 *  a hint above the input is read before you know what it is hinting at. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="text-foreground text-sm font-medium">{label}</p>
      {children}
      {hint ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{hint}</p>
      ) : null}
    </section>
  );
}

/** A selectable card on the 'type' step — clicking it both picks the kind
 *  and advances, so there's no separate "Continue" to press here. */
function TypeCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; weight?: 'fill' }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:border-foreground/20 hover:bg-accent/50 group flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors"
    >
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
        <Icon className="text-foreground size-4 shrink-0" weight="fill" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs leading-relaxed text-pretty">
          {description}
        </span>
      </span>
      <CaretRightIcon className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
    </button>
  );
}

function StepIndicator({ step, labels }: { step: Step; labels: Record<Step, string> }) {
  const order: Step[] = ['type', 'what', 'how'];
  return (
    <div
      className="flex items-center gap-2 pt-3"
      aria-label={`Step ${order.indexOf(step) + 1} of ${order.length}`}
    >
      {order.map((id, index) => {
        const current = step === id;
        const done = order.indexOf(step) > index;
        return (
          <div className="flex items-center gap-2" key={id}>
            {index > 0 && <span className="bg-border h-px w-5" aria-hidden="true" />}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                current
                  ? 'bg-primary text-primary-foreground'
                  : done
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                'text-xs',
                current ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              {labels[id]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
