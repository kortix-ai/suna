'use client';

/**
 * New trigger: one "When → Then" composer.
 *
 * A trigger is one sentence. The modal shows all of it at once: when it
 * starts (a schedule, an event from one of the project's Apps, a connector
 * event, a webhook, or a merged change request), what the agent does, a name,
 * and the options with sane defaults folded away. There is no Next or Back, so
 * the whole trigger is visible at every moment and the header sums it up in a
 * sentence. Browsing an app's events creates nothing; Create adds the app's
 * connector first when the project has none, then the trigger.
 *
 * Every source always shows. One the project cannot use yet says why in its
 * panel and links to the fix: no App sends events (Apps), or connector events
 * are off (the beta flag `event_triggers`, Project admin › Feature flags).
 */

import { Button } from '../../../primitives/button';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../primitives/tabs';
import { successToast } from '../../../primitives/toast';
import { agentDisplayLabel } from '../../../session/composer/session-chat-input';
import { useTranslations as useI18nTranslations } from '../../../i18n';
import { useProjectFeatureFlags } from '../../../internal/lib/use-project-feature-flags';
import { UiLink as Link, useUiViewerId } from '../../../providers/ui-provider';
import { uiRoutes } from '../../../lib/routes';
import { projectSettingsSectionHref } from '../../project-settings/project-settings-sections';
import { createProjectTrigger, upsertProjectSecret } from '@kortix/sdk';
import {
  modelKeyToWire,
  useProjectApps,
  useProjectTriggerEventApps,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { AppWindowIcon, GitMergeIcon, LightningIcon, TimerIcon, WebhooksLogoIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { type PatchDraft, InlineError } from './composer-parts';
import {
  type EventApp,
  appConnectors,
  describeEventStatus,
  draftToConfig,
  eventAppTarget,
  parseConfigErrors,
  schemaFields,
} from './event-trigger-copy';
import { COMPOSER_KINDS, type TriggerKind, describeCadence, describeOneOff } from './schedule-copy';
import { triggerToastEntity } from './trigger-toast';
import { ThenFields } from './then-fields';
import {
  runCapFromInput,
  type ComposerBlock,
  type ComposerDraft,
  eventSendingApps,
  findDraftApp,
  initialDraft,
  normalizeSecretName,
  runCreate,
  slugify,
  spaceTriggerAccess,
  summarize,
  triggerConnection,
  triggerFilter,
  triggerName,
  validate,
  withKind,
} from './trigger-composer-logic';
import { PostToField } from './post-to-field';
import { TriggerOptions } from './trigger-options';
import { useEventAppConnect } from './use-event-app-connect';
import { WhenApp } from './when-app';
import { WhenChangeRequest } from './when-change-request';
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
  initialApp?: { app: string; source?: string; provider?: string } | null;
  /** Opens on App event with this connector of the project chosen, e.g. from its own page. */
  initialConnector?: { slug: string; name: string } | null;
  /** Posts to this channel or DM, e.g. from its Triggers tab. Still changeable. */
  initialSpace?: { spaceId: string; kind: 'channel' | 'dm' } | null;
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

/** A group's heading: one size above the field labels inside it. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-foreground text-sm font-medium">{children}</h3>;
}

const BLOCK_LABELS = {
  cron: TimerIcon,
  event: LightningIcon,
  webhook: WebhooksLogoIcon,
  app: AppWindowIcon,
  change_request: GitMergeIcon,
} as const;

/** The source picker's labels (the words each kind shows elsewhere). */
const KIND_LABEL_KEY = {
  cron: 'textf4830a1dae29',
  app: 'text5441e7146193',
  event: 'textca395c4d19b2',
  webhook: 'text4814f62c108d',
} as const;

/** A source this project cannot use yet: one sentence on why, and the link that fixes it. */
function Unavailable({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <InfoBanner tone="info" className="text-xs" action={action}>
      {children}
    </InfoBanner>
  );
}

function ComposerForm({
  projectId,
  onOpenChange,
  onCreated,
  initialAgent = null,
  initialKind = null,
  initialApp = null,
  initialConnector = null,
  initialSpace = null,
  onBusyChange,
}: TriggerComposerProps & { onBusyChange: (busy: boolean) => void }) {
  const viewerId = useUiViewerId();
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tComposer = useI18nTranslations('triggerComposer');
  // Connector events are a beta feature behind the project flag `event_triggers`. Off: the tab
  // stays and its panel says how to turn it on; no catalog request is sent.
  const eventsOn = useProjectFeatureFlags(projectId).flags.event_triggers === true;
  const [draft, setDraft] = useState<ComposerDraft>(() => ({
    ...initialDraft({
      kind: initialKind ?? (initialApp || initialConnector ? 'event' : null),
      agent: initialAgent,
      appSlug: initialApp?.app ?? null,
      appSource: initialApp?.source ?? initialApp?.provider ?? null,
      profile: initialConnector?.slug ?? null,
      spaceId: initialSpace?.spaceId ?? null,
    }),
    ...(initialSpace ? { sessionAccess: spaceTriggerAccess(initialSpace.kind, viewerId) } : {}),
  }));
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
  // App events need no flag; with no App that can send one, the panel says so and links to Apps.
  const projectApps = useProjectApps(projectId);
  const kortixApps = eventSendingApps(projectApps.data);
  const appsHref = uiRoutes().apps(projectId);
  // A source the project cannot use yet: its panel says why, and Create waits.
  const unavailable =
    (draft.kind === 'event' && !eventsOn) ||
    (draft.kind === 'app' && kortixApps.length === 0 && !draft.kortixApp && !projectApps.isLoading);
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
  // A blocked Create moves focus to the first field that needs input, so the
  // click visibly lands somewhere instead of reading as a dead control
  // (KRTX-2816). Only the submit path calls this.
  const scrollTo = (block: ComposerBlock) =>
    requestAnimationFrame(() => {
      const section = bodyRef.current?.querySelector(`[data-block="${block}"]`);
      reveal(section?.querySelector('[role="alert"]') ?? section);
      section?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
    });
  useEffect(() => {
    if (error) reveal(errorRef.current);
  }, [error]);

  const create = useMutation({
    onMutate: () => onBusyChange(true),
    onSettled: () => {
      setFrozenApp(null);
      onBusyChange(false);
    },
    mutationFn: async () => {
      const trimmedName = name.trim();
      const slug = slugify(draft.customId.trim() || trimmedName);
      const isCron = draft.kind === 'cron';
      const isEvent = draft.kind === 'event';
      const isApp = draft.kind === 'app';

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
      const filter = triggerFilter(draft);
      return runCreate({
        addConnector:
          needsConnector && app
            ? async () => {
                if (addedConnector.current?.app === app.app) return addedConnector.current.slug;
                const added = await add(eventAppTarget(app));
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
            ...(draft.spaceId ? { space_id: draft.spaceId } : {}),
            ...(runCapFromInput(draft.maxRunsPerHour) ? { max_runs_per_hour: runCapFromInput(draft.maxRunsPerHour)! } : {}),
            ...(runCapFromInput(draft.maxRunsPerDay) ? { max_runs_per_day: runCapFromInput(draft.maxRunsPerDay)! } : {}),
            ...(draft.overlap !== 'default' ? { overlap: draft.overlap } : {}),
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
                : isApp
                  ? { app: draft.kortixApp ?? undefined }
                  : draft.kind === 'change_request'
                    ? {}
                    : { secret_env: secretEnv }),
          }),
      });
    },
    onSuccess: (listing) => {
      const isEvent = draft.kind === 'event';
      const isCron = draft.kind === 'cron';
      const isApp = draft.kind === 'app';
      const created = listing.triggers
        .filter((t) => t.type === draft.kind && t.name === name.trim())
        .slice(-1)[0];
      const cadence = isCron
        ? draft.runAt
          ? describeOneOff(draft.runAt)
          : describeCadence(draft.cron.trim())
        : undefined;
      const isChangeRequest = draft.kind === 'change_request';
      successToast(
        isEvent || isApp
          ? tI18nComplete.raw('text840993da3129')
          : isCron
            ? tI18nComplete.raw('text84e98b45ad8b')
            : isChangeRequest
              ? tI18nComplete.raw('text80ca527b0d55')
              : tI18nComplete.raw('text20bf63f7b46f'),
        {
          entity: triggerToastEntity({ name: name.trim(), type: draft.kind }, cadence),
          description: isEvent
            ? created?.event
              ? created.event.status === 'needs_connection'
                ? tI18nComplete.raw('text2fd655fcbaad')
                : (describeEventStatus(created.event, tI18nComplete).detail ??
                  tI18nComplete.raw('text80273a6c8918'))
              : undefined
            : isCron || isApp || isChangeRequest
              ? undefined
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
  const kindLabel = (kind: TriggerKind) =>
    kind === 'change_request' ? tComposer('crTab') : tI18nComplete.raw(KIND_LABEL_KEY[kind]);
  const pickKind = (kind: string) => setDraft((d) => withKind(d, kind as TriggerKind));

  return (
    <>
      <ModalHeader className="pr-12 pb-3">
        <ModalTitle>{tI18nComplete.raw('texta38f4ea67a30')}</ModalTitle>
        <ModalDescription className="text-pretty" aria-live="polite">
          {summarize(draft, app, agentDisplayLabel(agents, draft.agent), tI18nComplete)}
        </ModalDescription>
      </ModalHeader>

      <ModalBody className="min-h-0 flex-1 overflow-y-auto px-5 py-4 lg:max-h-[min(calc(100dvh-13rem),44rem)] lg:flex-none">
        {/* Three groups, read top to bottom as one sentence: when it starts,
            what the agent does, and what the trigger is called. The space
            between groups is twice the space inside one, so no rules are
            needed to tell them apart. */}
        <div ref={bodyRef} className="space-y-8">
          <section data-block="when" className="space-y-3">
            <SectionTitle>{tI18nComplete.raw('textcf9c7aa24a26')}</SectionTitle>
            <Tabs value={draft.kind} onValueChange={pickKind}>
              {/* Five sources do not fit one row below `lg` (the 720 px window,
                  a phone): there the picker is a select with the same choices. */}
              <Select value={draft.kind} onValueChange={pickKind}>
                <SelectTrigger
                  className="w-full cursor-pointer text-sm lg:hidden"
                  aria-label={tI18nComplete.raw('textcf9c7aa24a26')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPOSER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind} className="cursor-pointer">
                      <span className="flex items-center gap-1.5">
                        {tabIcon(kind)}
                        {kindLabel(kind)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <TabsList className="hidden w-full lg:flex">
                {COMPOSER_KINDS.map((kind) => (
                  <TabsTrigger key={kind} value={kind} className="flex-1 gap-1.5">
                    {tabIcon(kind)}
                    {kindLabel(kind)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="cron" className="pt-3">
                <WhenSchedule draft={draft} patch={patch} error={blockError('when')} />
              </TabsContent>
              <TabsContent value="app" className="pt-3">
                {kortixApps.length > 0 || draft.kortixApp || projectApps.isLoading ? (
                  <WhenApp apps={kortixApps} draft={draft} patch={patch} error={blockError('when')} />
                ) : (
                  <Unavailable
                    action={
                      appsHref ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={appsHref}>{tComposer('openApps')}</Link>
                        </Button>
                      ) : null
                    }
                  >
                    {tComposer.rich('noApps', {
                      code: (chunks) => (
                        <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">{chunks}</code>
                      ),
                    })}
                  </Unavailable>
                )}
              </TabsContent>
              <TabsContent value="event" className="pt-3">
                {eventsOn ? (
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
                ) : (
                  <Unavailable
                    action={
                      <Button asChild size="sm" variant="outline">
                        <Link href={projectSettingsSectionHref(projectId, 'feature-flags')}>
                          {tI18nComplete.raw('text20a2e59ba129')}
                        </Link>
                      </Button>
                    }
                  >
                    {tComposer('eventsOff')}
                  </Unavailable>
                )}
              </TabsContent>
              <TabsContent value="webhook" className="pt-3">
                <WhenWebhook draft={draft} patch={patch} error={blockError('when')} />
              </TabsContent>
              <TabsContent value="change_request" className="pt-3">
                <WhenChangeRequest draft={draft} patch={patch} />
              </TabsContent>
            </Tabs>
          </section>

          <section data-block="then" className="space-y-3">
            <SectionTitle>{tI18nComplete.raw('text0597f441dcca')}</SectionTitle>
            <ThenFields
              agents={agents}
              draft={draft}
              patch={patch}
              payloadSchema={draft.eventType?.payload_schema}
              error={blockError('then')}
            />
          </section>

          <section className="space-y-3">
            <SectionTitle>{tComposer('details')}</SectionTitle>
            <div data-block="name" className="space-y-1.5">
              <Label htmlFor="trigger-name" className="text-xs">
                {tI18nComplete.raw('textdcd1d5223f73')}
              </Label>
              <Input
                id="trigger-name"
                value={name}
                onChange={(e) => patch({ nameOverride: e.target.value })}
                placeholder={tI18nComplete.raw('textc8cf587a3b6c')}
                maxLength={64}
                aria-invalid={blockError('name') || nameError ? true : undefined}
              />
              <InlineError message={blockError('name') ?? nameError} />
            </div>
            <PostToField
              projectId={projectId}
              draft={draft}
              patch={patch}
              baseAccess={initialDraft({}).sessionAccess}
            />
            <div data-block="options">
              <TriggerOptions
                projectId={projectId}
                draft={draft}
                patch={patch}
                name={name}
                open={optionsOpen}
                onOpenChange={setOptionsOpen}
                error={blockError('options')}
              />
            </div>
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
          variant="ghost"
          size="sm"
          disabled={create.isPending}
          onClick={() => onOpenChange(false)}
        >
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={submit} disabled={create.isPending || unavailable}>
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {tI18nComplete.raw('texte18bbdd15a81')}
        </Button>
      </ModalFooter>
    </>
  );
}
