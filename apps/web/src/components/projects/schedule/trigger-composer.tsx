'use client';

/**
 * New trigger: one "When → Then" composer.
 *
 * A trigger is one sentence. The modal shows all of it at once: when it
 * starts (a schedule, an app event or a webhook), what the agent does, a name,
 * and the options with sane defaults folded away. There is no Next or Back, so
 * the whole trigger is visible at every moment and the header sums it up in a
 * sentence. Browsing an app's events creates nothing; Create adds the app's
 * connector first when the project has none, then the trigger.
 */

import { Button } from '@/components/ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { successToast } from '@/components/ui/toast';
import { agentDisplayLabel } from '@/features/session/session-chat-input';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { useProjectFeatureFlags } from '@/lib/use-project-feature-flags';
import { createProjectTrigger, upsertProjectSecret } from '@kortix/sdk';
import { modelKeyToWire, useProjectTriggerEventApps, useVisibleAgents } from '@kortix/sdk/react';
import { LightningIcon, TimerIcon, WebhooksLogoIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { type PatchDraft, InlineError } from './composer-parts';
import {
  type EventApp,
  appConnectors,
  describeEventStatus,
  draftToConfig,
  parseConfigErrors,
  schemaFields,
} from './event-trigger-copy';
import { type TriggerKind, describeCadence, describeOneOff } from './schedule-copy';
import { rowsToConditions } from './schedule-fields';
import { ThenFields } from './then-fields';
import {
  type ComposerBlock,
  type ComposerDraft,
  findDraftApp,
  initialDraft,
  normalizeSecretName,
  runCreate,
  slugify,
  summarize,
  triggerConnection,
  triggerName,
  validate,
  withKind,
} from './trigger-composer-logic';
import { TriggerOptions } from './trigger-options';
import { useEventAppConnect } from './use-event-app-connect';
import { WhenEvent } from './when-event';
import { WhenSchedule } from './when-schedule';
import { WhenWebhook } from './when-webhook';

export interface TriggerComposerProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
  /** Pre-selects the agent the trigger starts. An agent's own page opens
   *  this modal for "its" triggers. Still changeable. */
  initialAgent?: string | null;
  /** Opens on this kind, e.g. the empty state's "App event" button. */
  initialKind?: TriggerKind | null;
  /** Opens on App event with this app chosen and its events listed. Sends no request. */
  initialApp?: { app: string } | null;
  /** Opens on App event with this connector of the project chosen, e.g. from its own page. */
  initialConnector?: { slug: string; name: string } | null;
}

export function TriggerComposer(props: TriggerComposerProps) {
  const { open, onOpenChange } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) onOpenChange(false);
      }}
    >
      {/* The form mounts with the content, so each opening starts from a clean draft. */}
      <ModalContent
        className="flex flex-col gap-0 space-y-0 overflow-hidden p-0 outline-none sm:max-w-2xl"
        modalClassName="lg:max-w-2xl"
        // No tab wears a focus ring on open; focus rests on the dialog itself.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <ComposerForm {...props} onBusyChange={setBusy} />
      </ModalContent>
    </Modal>
  );
}

const BLOCK_LABELS = {
  cron: TimerIcon,
  event: LightningIcon,
  webhook: WebhooksLogoIcon,
} as const;

function ComposerForm({
  projectId,
  onOpenChange,
  onCreated,
  initialAgent = null,
  initialKind = null,
  initialApp = null,
  initialConnector = null,
  onBusyChange,
}: TriggerComposerProps & { onBusyChange: (busy: boolean) => void }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // App events are a beta feature behind the project flag `event_triggers`. Off: no App event tab,
  // no catalog request, and an entry point that asks for an app event opens on Schedule.
  const eventsOn = useProjectFeatureFlags(projectId).flags.event_triggers === true;
  const [draft, setDraft] = useState<ComposerDraft>(() =>
    initialDraft({
      kind: eventsOn
        ? (initialKind ?? (initialApp || initialConnector ? 'event' : null))
        : initialKind === 'event'
          ? null
          : initialKind,
      agent: initialAgent,
      appSlug: initialApp?.app ?? null,
      profile: initialConnector?.slug ?? null,
    }),
  );
  const patch: PatchDraft = (next) => setDraft((d) => ({ ...d, ...next }));
  const [showProblems, setShowProblems] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // The API's complaints belong to the config they were sent with; a changed config drops them.
  const [serverConfig, setServerConfig] = useState<{
    sent: ComposerDraft['configDraft'];
    errors: Record<string, string>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The API refused the name or custom ID because that slug is taken.
  const [taken, setTaken] = useState<{ slugOf: string; message: string } | null>(null);
  const slugOf = `${draft.kind}|${draft.nameOverride}|${draft.customId}`;
  const nameError = taken?.slugOf === slugOf ? taken.message : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // A connector added by a Create that then failed: the retry reuses it.
  const addedConnector = useRef<{ app: string; slug: string } | null>(null);

  const agents = useVisibleAgents({ projectId });
  // A null project id keeps the hook idle: with events off nothing asks for the catalog.
  const apps = useProjectTriggerEventApps(eventsOn ? projectId : null);
  const { add, canConnect } = useEventAppConnect(projectId);
  // Create adds the app's connector, which refreshes the app list. Hold the
  // app as it was at the click so the form does not rearrange under the spinner.
  const [frozenApp, setFrozenApp] = useState<EventApp | null>(null);
  const liveApp = findDraftApp(apps.data?.apps ?? [], draft);
  const app = frozenApp ?? liveApp;
  const configFields = useMemo(
    () => schemaFields(draft.eventType?.config_schema),
    [draft.eventType],
  );
  const name = triggerName(draft, tI18nComplete);

  const problems = validate(draft, { name, configFields, app }, tI18nComplete);
  const shown = showProblems ? problems : [];
  const blockError = (block: ComposerBlock) =>
    shown.find((p) => p.block === block && !p.field)?.message;
  const configErrors: Record<string, string> = {
    ...(serverConfig?.sent === draft.configDraft ? serverConfig.errors : {}),
  };
  for (const p of shown) if (p.field) configErrors[p.field] ??= p.message;

  // Bring an element into the body's view. `scrollIntoView` would also scroll
  // the dialog behind the header, so the body scrolls itself.
  const reveal = (target: Element | null | undefined) => {
    const scroller = bodyRef.current?.parentElement;
    if (!target || !scroller) return;
    const at = target.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (at.top >= view.top && at.bottom <= view.bottom) return;
    scroller.scrollTop += at.top - view.top - scroller.clientHeight / 4;
  };
  const scrollTo = (block: ComposerBlock) =>
    requestAnimationFrame(() => {
      const section = bodyRef.current?.querySelector(`[data-block="${block}"]`);
      reveal(section?.querySelector('[role="alert"]') ?? section);
    });
  useEffect(() => {
    if (error) reveal(errorRef.current);
  }, [error]);

  const create = useMutation({
    onSettled: () => setFrozenApp(null),
    mutationFn: async () => {
      const trimmedName = name.trim();
      const slug = slugify(draft.customId.trim() || trimmedName);
      const isCron = draft.kind === 'cron';
      const isEvent = draft.kind === 'event';

      let secretEnv: string | undefined;
      if (draft.kind === 'webhook') {
        secretEnv =
          normalizeSecretName(draft.secretName) ||
          `WEBHOOK_${slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_SECRET`;
        // Webhook secrets must be delivered as broker to the connector
        // consumer to pass trigger validation.
        await upsertProjectSecret(projectId, {
          name: secretEnv,
          value: draft.signingKey.trim(),
          strategy: 'broker',
          consumer: 'connector',
        });
      }

      const needsConnector = isEvent && app !== null && appConnectors(app).length === 0;
      const filter = rowsToConditions(draft.conditions);
      return runCreate({
        addConnector:
          needsConnector && app
            ? async () => {
                if (addedConnector.current?.app === app.app) return addedConnector.current.slug;
                const added = await add({
                  app: app.app,
                  name: app.name,
                  connector: null,
                  newConnectorSlug: app.new_connector_slug,
                });
                addedConnector.current = { app: app.app, slug: added };
                return added;
              }
            : null,
        createTrigger: (added) =>
          createProjectTrigger(projectId, {
            name: trimmedName,
            slug,
            type: draft.kind,
            prompt_template: draft.instruction.trim(),
            enabled: draft.startActive,
            ...(draft.agent ? { agent: draft.agent } : {}),
            ...(draft.model ? { model: modelKeyToWire(draft.model) } : {}),
            session_access: draft.sessionAccess,
            ...(draft.mode !== 'fresh' ? { session_mode: draft.mode } : {}),
            ...(draft.mode === 'pinned' && draft.pinnedSessionId
              ? { session_id: draft.pinnedSessionId }
              : {}),
            ...(draft.mode === 'keyed' ? { session_key: draft.sessionKey.trim() } : {}),
            ...(!isCron && filter ? { filter } : {}),
            ...(isCron
              ? draft.runAt
                ? { run_at: draft.runAt, timezone: draft.timezone.trim() || 'UTC' }
                : { cron: draft.cron.trim(), timezone: draft.timezone.trim() || 'UTC' }
              : isEvent
                ? {
                    ...triggerConnection(app, draft, added),
                    event: draft.eventType?.type,
                    event_config: draftToConfig(configFields, draft.configDraft),
                  }
                : { secret_env: secretEnv }),
          }),
      });
    },
    onSuccess: (listing) => {
      const isEvent = draft.kind === 'event';
      const isCron = draft.kind === 'cron';
      const created = listing.triggers
        .filter((t) => t.type === draft.kind && t.name === name.trim())
        .slice(-1)[0];
      successToast(
        isEvent
          ? tI18nComplete.raw('text840993da3129')
          : isCron
            ? tI18nComplete.raw('text84e98b45ad8b')
            : tI18nComplete.raw('text20bf63f7b46f'),
        {
          description: isEvent
            ? created?.event
              ? created.event.status === 'needs_connection'
                ? tI18nComplete.raw('text2fd655fcbaad')
                : (describeEventStatus(created.event, tI18nComplete).detail ??
                  tI18nComplete.raw('text80273a6c8918'))
              : undefined
            : isCron
              ? draft.runAt
                ? describeOneOff(draft.runAt)
                : describeCadence(draft.cron.trim())
              : tI18nComplete.raw('text4aded5c6750d'),
        },
      );
      if (created) onCreated(created.slug);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Could not create it';
      if (draft.kind === 'event') {
        // A bad event config comes back per field: show each under its input.
        const { byField, general } = parseConfigErrors(message, configFields);
        if (Object.keys(byField).length > 0) {
          setServerConfig({ sent: draft.configDraft, errors: byField });
          setError(general);
          return scrollTo('when');
        }
      }
      if (/already exists/i.test(message)) {
        setTaken({ slugOf, message });
        return scrollTo('name');
      }
      setError(message);
    },
  });
  useEffect(() => onBusyChange(create.isPending), [create.isPending, onBusyChange]);

  const submit = () => {
    setError(null);
    setTaken(null);
    if (problems.length > 0) {
      setShowProblems(true);
      if (problems.some((p) => p.block === 'options')) setOptionsOpen(true);
      scrollTo(problems[0].block);
      return;
    }
    setFrozenApp(liveApp);
    create.mutate();
  };

  const tabIcon = (kind: TriggerKind) => {
    const Icon = BLOCK_LABELS[kind];
    return <Icon className="size-3.5 shrink-0" weight="fill" />;
  };

  return (
    <>
      <ModalHeader className="pr-12 pb-3">
        <ModalTitle>{tI18nComplete.raw('texta38f4ea67a30')}</ModalTitle>
        <ModalDescription className="text-pretty" aria-live="polite">
          {summarize(draft, app, agentDisplayLabel(agents, draft.agent), tI18nComplete)}
        </ModalDescription>
      </ModalHeader>

      <ModalBody className="min-h-0 flex-1 overflow-y-auto px-5 py-4 lg:max-h-[min(calc(100dvh-13rem),44rem)] lg:flex-none">
        <div ref={bodyRef} className="space-y-6">
          <section data-block="when" className="space-y-3">
            <Label>{tI18nComplete.raw('textcf9c7aa24a26')}</Label>
            <Tabs
              value={draft.kind}
              onValueChange={(kind) => setDraft((d) => withKind(d, kind as TriggerKind))}
            >
              <TabsList className="w-full">
                <TabsTrigger value="cron" className="flex-1 gap-1.5">
                  {tabIcon('cron')}
                  {tI18nComplete.raw('textf4830a1dae29')}
                </TabsTrigger>
                {eventsOn ? (
                  <TabsTrigger value="event" className="flex-1 gap-1.5">
                    {tabIcon('event')}
                    {tI18nComplete.raw('text5441e7146193')}
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="webhook" className="flex-1 gap-1.5">
                  {tabIcon('webhook')}
                  {tI18nComplete.raw('text4814f62c108d')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="cron" className="pt-2">
                <WhenSchedule draft={draft} patch={patch} error={blockError('when')} />
              </TabsContent>
              {eventsOn ? (
              <TabsContent value="event" className="pt-2">
                <WhenEvent
                  projectId={projectId}
                  apps={apps}
                  draft={draft}
                  patch={patch}
                  setDraft={setDraft}
                  configFields={configFields}
                  configErrors={configErrors}
                  canConnect={canConnect}
                  error={blockError('when')}
                />
              </TabsContent>
              ) : null}
              <TabsContent value="webhook" className="pt-2">
                <WhenWebhook draft={draft} patch={patch} error={blockError('when')} />
              </TabsContent>
            </Tabs>
          </section>

          <section data-block="then" className="space-y-3">
            <Label>{tI18nComplete.raw('text0597f441dcca')}</Label>
            <ThenFields
              agents={agents}
              draft={draft}
              patch={patch}
              payloadSchema={draft.eventType?.payload_schema}
              error={blockError('then')}
            />
          </section>

          <section data-block="name" className="space-y-3">
            <Label htmlFor="trigger-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
            <Input
              id="trigger-name"
              value={name}
              onChange={(e) => patch({ nameOverride: e.target.value })}
              placeholder={tI18nComplete.raw('textc8cf587a3b6c')}
              maxLength={64}
              aria-invalid={blockError('name') || nameError ? true : undefined}
            />
            <InlineError message={blockError('name') ?? nameError} />
          </section>

          <section data-block="options">
            <TriggerOptions
              projectId={projectId}
              draft={draft}
              patch={patch}
              name={name}
              open={optionsOpen}
              onOpenChange={setOptionsOpen}
              error={blockError('options')}
            />
          </section>

          {error ? (
            <div ref={errorRef}>
              <InfoBanner tone="destructive" className="text-xs">
                {error}
              </InfoBanner>
            </div>
          ) : null}
        </div>
      </ModalBody>

      <ModalFooter className="mt-0 shrink-0 flex-row gap-2 border-t px-5 py-3 sm:space-x-0">
        <Button
          variant="outline-ghost"
          size="sm"
          disabled={create.isPending}
          onClick={() => onOpenChange(false)}
        >
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={submit} disabled={create.isPending}>
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {tI18nComplete.raw('texte18bbdd15a81')}
        </Button>
      </ModalFooter>
    </>
  );
}
