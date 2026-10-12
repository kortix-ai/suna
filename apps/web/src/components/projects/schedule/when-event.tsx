'use client';

import { AppLogo } from '@/components/projects/onboarding/app-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import type { ProjectTriggerEventApps, ProjectTriggerEventType } from '@kortix/sdk';
import { useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { CaretRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { FoldTrigger, InlineError, type PatchDraft } from './composer-parts';
import { EventAccountRows } from './event-account-picker';
import {
  type ConfigDraft,
  type EventApp,
  type SchemaField,
  appConnectors,
  defaultConfigDraft,
  describePollHint,
  eventSourceName,
  groupEventApps,
  humanizeEventType,
  oneLineDescription,
  profileConnected,
  schemaFields,
} from './event-trigger-copy';
import { EventConfigForm, matchesEventQuery } from './event-trigger-fields';
import {
  type ComposerDraft,
  findDraftApp,
  resolveProfile,
  withAppPicked,
  withEventCleared,
  withEventPicked,
  withProfilePicked,
} from './trigger-composer-logic';

function Skeletons() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-12 rounded-md" />
      <Skeleton className="h-12 rounded-md" />
      <Skeleton className="h-12 rounded-md" />
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <InputGroupSearch>
      <InputGroupSearchIcon>
        <MagnifyingGlassIcon />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="sm"
      />
    </InputGroupSearch>
  );
}

/* ─── (a) No app yet: browse every app ──────────────────────────────────── */

function AppTile({ app, onPick }: { app: EventApp; onPick: () => void }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="hover:bg-accent/50 duration-fast flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors"
      >
        <AppLogo src={app.logo} />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{app.name}</span>
          <span className="text-muted-foreground block text-xs">
            {tI18nComplete('text6e4a170bdf81', { count: app.event_count })}
          </span>
        </span>
        {app.connected ? (
          <Badge variant="kortix" size="xs">
            {tI18nComplete.raw('text22965568d22a')}
          </Badge>
        ) : null}
      </button>
    </li>
  );
}

/** How many of "All apps" show before "Show all". */
const APP_CAP = 8;
/** How many events show before "Show all". */
const EVENT_CAP = 6;

/** Expands a capped list in place; the list then scrolls with the dialog body. */
function ShowAll({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-mx-2 w-full" onClick={onClick}>
      {label}
    </Button>
  );
}

function AppBrowser({
  apps,
  onPick,
}: {
  apps: UseQueryResult<ProjectTriggerEventApps>;
  onPick: (app: EventApp) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const list = apps.data?.apps ?? [];
  const { yours, more } = groupEventApps(list, search);
  // A search shows every match. Without one, "All apps" is capped until asked for.
  const capped = !expanded && !search.trim() && more.length > APP_CAP;

  if (apps.isLoading) return <Skeletons />;
  if (apps.isError) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('textc416d056595e')}>
        {apps.error instanceof Error ? apps.error.message : tI18nComplete.raw('text29cc3339fce9')}
      </InfoBanner>
    );
  }
  if (list.length === 0) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('text2c4ef9cc0c30')}>
        {tI18nComplete.raw('texte558709e2278')}
      </InfoBanner>
    );
  }
  const group = (heading: string | null, rows: EventApp[]) =>
    rows.length === 0 ? null : (
      <section className="space-y-1.5">
        {heading ? <h3 className="text-muted-foreground text-xs font-medium">{heading}</h3> : null}
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {rows.map((app) => (
            <AppTile key={app.app} app={app} onPick={() => onPick(app)} />
          ))}
        </ul>
      </section>
    );
  return (
    <div className="space-y-3">
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder={tI18nComplete.raw('texta10a36fa1098')}
      />
      <div className="space-y-4">
        {group(yours.length > 0 ? tI18nComplete.raw('text13b17cc7974b') : null, yours)}
        {group(
          yours.length > 0 ? tI18nComplete.raw('text01bed311e7d0') : null,
          capped ? more.slice(0, APP_CAP) : more,
        )}
        {capped ? (
          <ShowAll
            label={tI18nComplete('text024172a56d6f', {
              count: yours.length + more.length,
            })}
            onClick={() => setExpanded(true)}
          />
        ) : null}
        {yours.length === 0 && more.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nComplete.raw('text3d6f73990a72')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ─── (b) App chosen: its events, no connector needed ───────────────────── */

function AppHeader({ app, onChange }: { app: EventApp; onChange: () => void }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <AppLogo src={app.logo} />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{app.name}</span>
        <span className="text-muted-foreground block text-xs">
          {tI18nComplete('text6e4a170bdf81', { count: app.event_count })}
        </span>
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onChange}>
        {tI18nComplete.raw('text5c2f9b184974')}
      </Button>
    </div>
  );
}

function EventList({
  app,
  events,
  onPick,
}: {
  app: EventApp;
  events: ReturnType<typeof useProjectTriggerEventTypes>;
  onPick: (eventType: ProjectTriggerEventType) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const all = events.data?.event_types ?? [];
  const matches = all.filter((e) => matchesEventQuery(e, search));
  // A search shows every match. Without one, the list is capped until asked for.
  const capped = !expanded && !search.trim() && matches.length > EVENT_CAP;
  const visible = capped ? matches.slice(0, EVENT_CAP) : matches;

  if (events.isLoading) return <Skeletons />;
  if (events.isError) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('text50a06ae2ec9e')}>
        {tI18nComplete.raw('texta9cb192dbee2')}{' '}
        {events.error instanceof Error ? events.error.message : ''}
      </InfoBanner>
    );
  }
  if (all.length === 0) {
    return <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textbb19f45c3461')}</p>;
  }
  return (
    <div className="space-y-3">
      {eventSourceName(app) ? (
        <h3 className="text-muted-foreground text-xs font-medium">
          {tI18nComplete('textfd26b2373251', { source: eventSourceName(app) ?? '' })}
        </h3>
      ) : null}
      {all.length > 5 ? (
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={tI18nComplete.raw('text901abe952186')}
        />
      ) : null}
      {visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          {tI18nComplete.raw('textd35a8ebc3a74')}
        </p>
      ) : (
        <ul className="space-y-1.5" aria-label={app.name}>
          {visible.map((eventType) => {
            const poll = describePollHint(eventType);
            return (
              <li key={eventType.type}>
                <button
                  type="button"
                  onClick={() => onPick(eventType)}
                  className="hover:bg-accent/50 duration-fast flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {eventType.name || humanizeEventType(eventType.type)}
                    </span>
                    {eventType.description ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        {oneLineDescription(eventType.description)}
                      </span>
                    ) : null}
                    {poll ? (
                      <span className="text-muted-foreground block text-xs">{poll}</span>
                    ) : null}
                  </span>
                  <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {capped ? (
        <ShowAll
          label={tI18nComplete('text52940d5bb670', { count: matches.length })}
          onClick={() => setExpanded(true)}
        />
      ) : null}
    </div>
  );
}

/* ─── (c) Event chosen: settings and connection ─────────────────────────── */

function SelectedEvent({
  app,
  eventType,
  onChange,
}: {
  app: EventApp;
  eventType: ProjectTriggerEventType;
  onChange: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const poll = describePollHint(eventType);
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <AppLogo src={app.logo} />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">
          {eventType.name || humanizeEventType(eventType.type)}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {poll ? `${app.name} · ${poll}` : app.name}
        </span>
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onChange}>
        {tI18nComplete.raw('textc0bf75bd78bf')}
      </Button>
    </div>
  );
}

/**
 * Which connector and account feed the trigger: first the connector (profile),
 * then one of its accounts. With no connector for the app yet, one line says it
 * is added on Create; nothing is requested here.
 */
function Connection({
  projectId,
  app,
  draft,
  patch,
  setDraft,
  canConnect,
}: {
  projectId: string;
  app: EventApp;
  draft: ComposerDraft;
  patch: PatchDraft;
  setDraft: (next: (current: ComposerDraft) => ComposerDraft) => void;
  canConnect: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const profiles = appConnectors(app);
  const activeSlug = resolveProfile(app, draft);
  const active = profiles.find((p) => p.slug === activeSlug) ?? null;
  const heading = (
    <p className="text-foreground text-sm font-medium">{tI18nComplete.raw('text639a40e82b9a')}</p>
  );
  if (!active) {
    return (
      <div className="space-y-2">
        {heading}
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {tI18nComplete('text78544011d53a', { name: app.name })}
        </p>
      </div>
    );
  }
  const profileLabel = (name: string, slug: string) => (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{name}</span>
      {name.toLowerCase().includes(slug.toLowerCase()) ? null : (
        <span className="text-muted-foreground truncate font-mono text-xs">{slug}</span>
      )}
    </span>
  );
  return (
    <div className="space-y-3">
      {heading}
      <div className="space-y-1.5">
        <Label className="text-xs">{tI18nComplete.raw('text8f0d706fff25')}</Label>
        {profiles.length > 1 ? (
          <Select
            value={active.slug}
            // A new connector brings its own accounts: back to its default.
            onValueChange={(slug) => setDraft((d) => withProfilePicked(d, slug))}
          >
            <SelectTrigger className="w-full cursor-pointer text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.slug} value={p.slug} className="cursor-pointer">
                  {profileLabel(p.name, p.slug)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="bg-popover rounded-md border px-3 py-2 text-sm">
            {profileLabel(active.name, active.slug)}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{tI18nComplete.raw('text7e1b0d5641f2')}</Label>
        <EventAccountRows
          key={active.slug}
          projectId={projectId}
          connector={active}
          value={draft.account}
          canConnect={canConnect}
          onChange={(account) => patch({ profile: active.slug, account })}
        />
        {!canConnect && !profileConnected(app, active.slug) ? (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete('text5550bcf169d6', { name: app.name })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The event's own settings. Most are optional filters with defaults, so they
 * stay folded until the event has a required one or a problem to show.
 */
function EventSettings({
  fields,
  draft,
  errors,
  onChange,
}: {
  fields: SchemaField[];
  draft: ConfigDraft;
  errors: Record<string, string>;
  onChange: (next: ConfigDraft) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(fields.some((f) => f.required && f.kind !== 'boolean'));
  const hasProblem = Object.keys(errors).length > 0;
  return (
    <Disclosure className="group" open={open || hasProblem} onOpenChange={setOpen}>
      <FoldTrigger>{tI18nComplete.raw('text6abe3b60f184')}</FoldTrigger>
      <DisclosureContent>
        <div className="space-y-3 pt-3">
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('text9f2c75e76be9')}
          </p>
          <EventConfigForm fields={fields} draft={draft} errors={errors} onChange={onChange} />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/* ─── When: an app event ────────────────────────────────────────────────── */

export function WhenEvent({
  projectId,
  apps,
  draft,
  patch,
  setDraft,
  configFields,
  configErrors,
  canConnect,
  error,
}: {
  projectId: string;
  apps: UseQueryResult<ProjectTriggerEventApps>;
  draft: ComposerDraft;
  patch: PatchDraft;
  setDraft: (next: (current: ComposerDraft) => ComposerDraft) => void;
  configFields: SchemaField[];
  /** Per-field problems, from Create's check or the API's 400. */
  configErrors: Record<string, string>;
  canConnect: boolean;
  /** The block-level problem: no app, or no event. */
  error?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const app = findDraftApp(apps.data?.apps ?? [], draft);
  const events = useProjectTriggerEventTypes(
    projectId,
    app ? { app: app.app, ...(app.source ? { source: app.source } : {}) } : null,
  );

  // Opened on an app or a connector, and the app list is still on its way.
  if (!app && (draft.appSlug || draft.profile) && apps.isLoading) return <Skeletons />;

  if (!app) {
    return (
      <div className="space-y-2">
        <AppBrowser apps={apps} onPick={(next) => setDraft((d) => withAppPicked(d, next.app))} />
        <InlineError message={error} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {draft.eventType ? (
        <SelectedEvent
          app={app}
          eventType={draft.eventType}
          onChange={() => setDraft(withEventCleared)}
        />
      ) : (
        <AppHeader app={app} onChange={() => setDraft((d) => withAppPicked(d, null))} />
      )}
      {draft.eventType ? (
        <>
          {configFields.length > 0 ? (
            <EventSettings
              key={draft.eventType.type}
              fields={configFields}
              draft={draft.configDraft}
              errors={configErrors}
              onChange={(configDraft) => patch({ configDraft })}
            />
          ) : null}
          <Connection
            projectId={projectId}
            app={app}
            draft={draft}
            patch={patch}
            setDraft={setDraft}
            canConnect={canConnect}
          />
        </>
      ) : (
        <div className="space-y-2">
          <EventList
            app={app}
            events={events}
            onPick={(next) =>
              setDraft((d) =>
                withEventPicked(d, next, defaultConfigDraft(schemaFields(next.config_schema))),
              )
            }
          />
          <InlineError message={error} />
        </div>
      )}
    </div>
  );
}
