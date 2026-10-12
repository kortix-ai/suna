'use client';

/**
 * The panel behind a row click.
 *
 * It is the trigger composer, in edit mode. The body is the same When → Then →
 * Name → Options stack built from the same pieces (`WhenSchedule`,
 * `WhenEvent`, `ThenFields`, `TriggerOptions`), over a `ComposerDraft` built
 * from the saved trigger. Nothing saves on its own: one footer, "Save changes"
 * and "Discard", appears while the draft differs from the saved trigger, and
 * Save sends one PATCH holding only the fields that changed (`triggerPatch`).
 *
 * Above the form, a callout shows only what needs action: a failed run, an
 * event trigger that needs a connection or is in error, or events being off
 * for the project. A viewer who may not update the trigger sees the same facts
 * as one read-only list.
 */

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { agentDisplayLabel } from '@/features/session/session-chat-input';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { storedModelRefToKey } from '@/lib/llm-gateway';
import { type ProjectTrigger, updateProjectTrigger } from '@kortix/sdk';
import {
  type Agent,
  useFeatureFlag,
  useProjectTriggerEventApps,
  useProjectTriggerEventTypes,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { DotsThreeIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { FoldTrigger, InlineError, type PatchDraft } from './composer-parts';
import {
  accountToWrite,
  appConnectors,
  describeEventSource,
  describeEventStatus,
  indexEventApps,
  parseConfigErrors,
  schemaFields,
} from './event-trigger-copy';
import {
  describeLastRun,
  describeNextRun,
  describeWhen,
  triggerBadgeState,
  triggerName,
} from './schedule-copy';
import { PropertyList } from './schedule-fields';
import { ThenFields } from './then-fields';
import { TriggerCallouts } from './trigger-callouts';
import {
  type ComposerBlock,
  type ComposerDraft,
  findDraftApp,
  resolveProfile,
  validate,
} from './trigger-composer-logic';
import type { TriggerControls } from './trigger-controls';
import { draftFromTrigger, triggerPatch } from './trigger-edit-logic';
import { TriggerOptions } from './trigger-options';
import { TriggerReadOnly } from './trigger-readonly';
import { TriggerStatusBadge } from './trigger-status-badge';
import { TriggerTile } from './trigger-tile';
import { useEventAppConnect } from './use-event-app-connect';
import { WhenEvent } from './when-event';
import { WhenEventSummary } from './when-event-summary';
import { WhenSchedule } from './when-schedule';
import { WhenWebhookAddress } from './when-webhook-address';

/** Shared formatter, hoisted so render does not rebuild the Intl machinery per call. */
const lastRunFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export interface ScheduleDetailSheetProps {
  projectId: string;
  trigger: ProjectTrigger | null;
  controls: TriggerControls;
  /** The project flag `event_triggers`. Off: no event catalog is requested and an event trigger is not editable. */
  eventsEnabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: () => void;
  running: boolean;
  onDelete: () => void;
  onMutated: () => void;
}

export function ScheduleDetailSheet(props: ScheduleDetailSheetProps) {
  const { trigger, open, onOpenChange } = props;
  if (!trigger) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `!overflow-y-auto` on the CONTENT, not on a flex child, and the `!` is
          load-bearing: `sheetVariants` sets `overflow-hidden`, and twMerge does
          not treat that as conflicting with `overflow-y-auto` (different
          utility groups), so both survive the merge and the stylesheet order
          decides. The important flag settles it. This element is the sheet's
          one scroller: the header and footer stick to it, and nothing inside
          scrolls on its own. */}
      <SheetContent side="right" className="w-full gap-0 !overflow-y-auto p-0 sm:max-w-xl">
        <SheetPanel key={trigger.slug} {...props} trigger={trigger} />
      </SheetContent>
    </Sheet>
  );
}

/* ─── Header, data, and the readiness gate ──────────────────────────────── */

function SheetPanel({
  projectId,
  trigger,
  controls,
  eventsEnabled,
  onRun,
  running,
  onDelete,
  onMutated,
}: ScheduleDetailSheetProps & { trigger: ProjectTrigger }) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  const event = trigger.type === 'event' ? trigger.event : null;
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateProjectTrigger(projectId, trigger.slug, { enabled }),
    onSuccess: (_data, enabled) => {
      successToast(enabled ? t.raw('texta97d32ddb6ba') : t.raw('texte159b06187d3'));
      onMutated();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : t.raw('text43ec39943667')),
  });

  const agents = useVisibleAgents({ projectId });
  // A null project id keeps both hooks idle: with events off, the sheet asks for no event data.
  const catalogOn = eventsEnabled && event !== null;
  const apps = useProjectTriggerEventApps(catalogOn ? projectId : null);
  // Ask for the connector's events only when the catalog lists it: an unknown connector answers 404.
  const listed = (apps.data?.apps ?? []).some((a) =>
    appConnectors(a).some((c) => c.slug === event?.connector),
  );
  const eventTypes = useProjectTriggerEventTypes(
    catalogOn && listed ? projectId : null,
    event?.connector ?? null,
  );
  const appIndex = useMemo(() => indexEventApps(apps.data?.apps), [apps.data]);
  const eventNames = useMemo(
    () => new Map((eventTypes.data?.event_types ?? []).map((e) => [e.type, e.name] as const)),
    [eventTypes.data],
  );
  const gateway = useFeatureFlag(projectId, 'llm_gateway');
  const savedModel = trigger.model
    ? storedModelRefToKey(trigger.model, gateway.enabled === true)
    : null;
  const savedEventType = useMemo(
    () => eventTypes.data?.event_types.find((e) => e.type === event?.type) ?? null,
    [eventTypes.data, event?.type],
  );

  const canWrite = controls.canUpdate;
  const active = trigger.enabled;
  const nextRun = describeNextRun(trigger);
  const when = describeWhen(trigger, eventNames);
  const status = event ? describeEventStatus(event, t, appIndex) : null;
  const state = triggerBadgeState(trigger);
  const reason =
    state === 'error' || state === 'needs_connection'
      ? (status?.detail ?? trigger.last_error)
      : null;
  // The form needs the event's schema to build its settings; wait for it, never flash a half-built form.
  const loading = catalogOn && (apps.isLoading || eventTypes.isLoading);

  return (
    <>
      {/* Sticky, because the content element is what scrolls: without this the
          Run now / Pause actions would scroll away. `bg-sidebar` matches the
          sheet's own surface so content passes behind it, not through it.
          `text-left` is not redundant: SheetHeader's base centres on a phone. */}
      <SheetHeader className="bg-sidebar sticky top-0 z-10 space-y-3 px-4 pt-4 pb-4 text-left">
        <div className="flex min-w-0 items-center gap-3 pr-10">
          <TriggerTile
            trigger={trigger}
            logo={event ? (appIndex.get(event.app ?? event.connector)?.logo ?? null) : null}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <SheetTitle className="truncate text-base font-semibold tracking-tight">
                {triggerName(trigger)}
              </SheetTitle>
              <TriggerStatusBadge trigger={trigger} hint={reason} />
            </div>
            <SheetDescription className="text-xs">
              {[
                // The name often is the event's own name: say it once.
                when === triggerName(trigger) ? null : when,
                nextRun,
                event ? describeEventSource(event, t, appIndex) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </SheetDescription>
          </div>
        </div>

        {controls.canFire || controls.canUpdate || controls.canDelete ? (
          <div className="flex items-center gap-1.5">
            {controls.canFire ? (
              <Button size="sm" className="gap-1.5" onClick={onRun} disabled={running}>
                {running ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon weight="fill" className="size-3.5 shrink-0" />
                )}
                {t.raw('text0991397702fa')}
              </Button>
            ) : null}
            {controls.canUpdate ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => toggle.mutate(!active)}
                disabled={toggle.isPending}
              >
                {toggle.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : active ? (
                  <PauseIcon weight="fill" className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon weight="fill" className="size-3.5 shrink-0" />
                )}
                {active ? 'Pause' : 'Resume'}
              </Button>
            ) : null}
            <div className="min-w-2 flex-1" />
            {controls.canDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label={t.raw('textf8d46c2570e7')}>
                    <DotsThreeIcon className="size-4 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <TrashIcon className="size-3.5 shrink-0" />
                    {trigger.type === 'cron'
                      ? t.raw('textd8d0bd5c5106')
                      : event
                        ? t.raw('textf2f698118cc1')
                        : t.raw('text60f85e57e4a7')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </SheetHeader>

      {/* `flex-none` and `!overflow-visible` are load-bearing. SheetBody's base
          is `flex min-h-0 flex-1 … overflow-y-auto`; twMerge only drops a base
          utility when the override supplies one of the SAME group, so this box
          stayed a shrinkable flex child that clipped panels below the fold.
          The content element above owns scrolling; a second scroller here
          would send the wheel to whichever surface the cursor is over. */}
      <SheetBody className="flex-none items-stretch gap-0 space-y-6 !overflow-visible px-4 pt-2 pb-0">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-28 rounded-md" />
          </div>
        ) : (
          <SheetForm
            projectId={projectId}
            trigger={trigger}
            canWrite={canWrite}
            eventsEnabled={eventsEnabled}
            appIndex={appIndex}
            eventNames={eventNames}
            agents={agents}
            savedEventType={savedEventType}
            savedModel={savedModel}
            apps={apps}
            onMutated={onMutated}
          />
        )}
      </SheetBody>
    </>
  );
}

/* ─── The form ──────────────────────────────────────────────────────────── */

function SheetForm({
  projectId,
  trigger,
  canWrite,
  eventsEnabled,
  appIndex,
  eventNames,
  agents,
  savedEventType,
  savedModel,
  apps,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  eventsEnabled: boolean;
  appIndex: ReturnType<typeof indexEventApps>;
  eventNames: ReadonlyMap<string, string>;
  agents: Agent[];
  savedEventType: ReturnType<typeof draftFromTrigger>['eventType'];
  savedModel: ReturnType<typeof draftFromTrigger>['model'];
  apps: ReturnType<typeof useProjectTriggerEventApps>;
  onMutated: () => void;
}) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  const { add, canConnect } = useEventAppConnect(projectId);

  // What the server holds, as a draft. A refetch that changes nothing changes nothing here.
  const server = useMemo(
    () => draftFromTrigger(trigger, { eventType: savedEventType, model: savedModel }),
    [trigger, savedEventType, savedModel],
  );
  const serverKey = JSON.stringify(server);
  const [base, setBase] = useState(server);
  const [draft, setDraft] = useState(server);
  const patch: PatchDraft = (next) => setDraft((d) => ({ ...d, ...next }));
  const [showProblems, setShowProblems] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [serverConfig, setServerConfig] = useState<{
    sent: ComposerDraft['configDraft'];
    errors: Record<string, string>;
  } | null>(null);
  const whenRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const app = findDraftApp(apps.data?.apps ?? [], draft);
  const configFields = useMemo(
    () => schemaFields(draft.eventType?.config_schema),
    [draft.eventType],
  );

  // What Save writes. A new connector brings its own account list, so the account is resolved with it.
  const effective: ComposerDraft = useMemo(() => {
    if (draft.kind !== 'event' || !app) return draft;
    const profile = resolveProfile(app, draft);
    const moved = profile !== base.profile;
    const connector = appConnectors(app).find((c) => c.slug === profile) ?? null;
    return {
      ...draft,
      profile,
      account: moved ? accountToWrite(connector, draft.account) : draft.account,
    };
  }, [draft, app, base.profile]);
  const changes = triggerPatch(base, effective);
  const needsConnector =
    draft.kind === 'event' &&
    app !== null &&
    draft.appSlug !== base.appSlug &&
    appConnectors(app).length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base) || needsConnector;

  // Follow the server while the form is clean; keep what the person typed while it is not.
  const seenKey = useRef(serverKey);
  useEffect(() => {
    if (seenKey.current === serverKey) return;
    seenKey.current = serverKey;
    if (!dirty) setDraft(server);
    setBase(server);
  }, [serverKey, server, dirty]);

  const name = draft.nameOverride ?? '';
  const problems = validate(draft, { name, configFields, app, edit: true }, t);
  const shown = showProblems ? problems : [];
  const blockError = (block: ComposerBlock) =>
    shown.find((p) => p.block === block && !p.field)?.message;
  const configErrors: Record<string, string> = {
    ...(serverConfig?.sent === draft.configDraft ? serverConfig.errors : {}),
  };
  for (const p of shown) if (p.field) configErrors[p.field] ??= p.message;

  const save = useMutation({
    mutationFn: async () => {
      const body = { ...changes };
      if (needsConnector && app) {
        body.connector = await add({
          app: app.app,
          name: app.name,
          connector: null,
          newConnectorSlug: app.new_connector_slug,
        });
      }
      return updateProjectTrigger(projectId, trigger.slug, body);
    },
    onSuccess: () => {
      successToast(t.raw('textb5c120b316c2'));
      setBase(draft);
      setShowProblems(false);
      setServerConfig(null);
      onMutated();
    },
    onError: (e: Error) => {
      if (draft.kind === 'event') {
        // A bad event config comes back per field: show each under its input.
        const { byField, general } = parseConfigErrors(e.message, configFields);
        if (Object.keys(byField).length > 0) {
          setServerConfig({ sent: draft.configDraft, errors: byField });
          if (general) errorToast(general);
          return;
        }
      }
      errorToast(e.message || t.raw('text16efcd21d74f'));
    },
  });

  const submit = () => {
    if (problems.length > 0) {
      setShowProblems(true);
      if (problems.some((p) => p.block === 'options')) setOptionsOpen(true);
      setTimeout(
        () =>
          bodyRef.current
            ?.querySelector('[role="alert"]')
            ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
        0,
      );
      return;
    }
    save.mutate();
  };
  const discard = () => {
    setDraft(base);
    setShowProblems(false);
    setServerConfig(null);
  };

  const editEvent = () => whenRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return (
    <div ref={bodyRef} className="space-y-6">
      <TriggerCallouts
        projectId={projectId}
        trigger={trigger}
        canEditEvent={canWrite && (app !== null || (!draft.appSlug && !draft.profile))}
        eventsEnabled={eventsEnabled}
        apps={appIndex}
        onEditEvent={editEvent}
      />

      {canWrite ? (
        <>
          <section ref={whenRef} data-sheet-block data-block="when" className="space-y-3">
            <Label>{t.raw('textcf9c7aa24a26')}</Label>
            {draft.kind === 'cron' ? (
              <WhenSchedule draft={draft} patch={patch} error={blockError('when')} />
            ) : draft.kind === 'webhook' ? (
              <WhenWebhookAddress trigger={trigger} draft={draft} patch={patch} canWrite />
            ) : app || (!draft.appSlug && !draft.profile) ? (
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
              <WhenEventSummary
                trigger={trigger}
                apps={appIndex}
                eventNames={eventNames}
                loading={apps.isLoading}
              />
            )}
          </section>

          <section data-sheet-block data-block="then" className="space-y-3">
            <Label>{t.raw('text0597f441dcca')}</Label>
            <ThenFields
              agents={agents}
              draft={draft}
              patch={patch}
              payloadSchema={draft.eventType?.payload_schema}
              error={blockError('then')}
            />
          </section>

          <section data-sheet-block data-block="name" className="space-y-3">
            <Label htmlFor="trigger-name">{t.raw('textdcd1d5223f73')}</Label>
            <Input
              id="trigger-name"
              value={name}
              onChange={(e) => patch({ nameOverride: e.target.value })}
              placeholder={t.raw('textc8cf587a3b6c')}
              maxLength={64}
              aria-invalid={blockError('name') ? true : undefined}
            />
            <InlineError message={blockError('name')} />
          </section>

          <section data-sheet-block data-block="options">
            <TriggerOptions
              edit
              projectId={projectId}
              draft={draft}
              patch={patch}
              name={name}
              open={optionsOpen}
              onOpenChange={setOptionsOpen}
              error={blockError('options')}
            />
          </section>
        </>
      ) : (
        <TriggerReadOnly
          trigger={trigger}
          apps={appIndex}
          eventNames={eventNames}
          agentLabel={agentDisplayLabel(agents, trigger.agent)}
        />
      )}

      <div className="pb-8">
        <Details trigger={trigger} />
      </div>

      {dirty && canWrite ? (
        /* In the sheet's own scroll container, after the body: it sticks to the
           bottom edge while the form is long, and rests under the form when it is short. */
        <SaveBar pending={save.isPending} onSave={submit} onDiscard={discard} />
      ) : null}
    </div>
  );
}

/** The one footer: present only while the form differs from the saved trigger. */
function SaveBar({
  pending,
  onSave,
  onDiscard,
}: {
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="bg-sidebar border-border sticky bottom-0 z-10 -mx-4 mt-auto flex items-center justify-end gap-2 border-t px-4 py-3">
      <Button variant="outline-ghost" size="sm" disabled={pending} onClick={onDiscard}>
        {t.raw('texteb1a70e39274')}
      </Button>
      <Button size="sm" className="gap-1.5" disabled={pending} onClick={onSave}>
        {pending ? <Loading className="size-3.5 shrink-0" /> : null}
        {t.raw('textdd0ae7a5cbcf')}
      </Button>
    </div>
  );
}

/* ─── Details — facts, not settings ─────────────────────────────────────── */

function Details({ trigger }: { trigger: ProjectTrigger }) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <Disclosure className="group">
      <FoldTrigger>{t.raw('text45989de49fb7')}</FoldTrigger>
      <DisclosureContent>
        <div className="pt-3">
          <PropertyList
            rows={[
              { label: 'ID', value: <code className="font-mono text-xs">{trigger.slug}</code> },
              {
                label: t.raw('text456a1fdc1530'),
                value: <code className="font-mono text-xs">{trigger.path}</code>,
              },
              {
                label: t.raw('text512a48218ba2'),
                value: (
                  <span className="tabular-nums">
                    {trigger.last_fired_at
                      ? lastRunFormatter.format(new Date(trigger.last_fired_at))
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
