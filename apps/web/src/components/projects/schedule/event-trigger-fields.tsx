'use client';

/**
 * The App event pieces of the trigger form: pick a connected app, pick one of
 * its events, fill that event's config, and write the prompt with the event's
 * fields as clickable variables. Each piece is a controlled component so the
 * create modal and the detail sheet share them.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { AppLogo } from '@/components/projects/onboarding/app-logo';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTriggerEventType } from '@kortix/sdk';
import { useProjectTriggerEventApps, useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { CheckIcon, LinkIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type EventApp,
  appConnectors,
  describePollHint,
  profileConnected,
  groupEventApps,
  humanizeEventType,
  payloadVariables,
  type ConfigDraft,
  type SchemaField,
} from './event-trigger-copy';
import { EventAccountRows } from './event-account-picker';
import { type EventAppTarget, useEventAppConnect } from './use-event-app-connect';

/* ─── App ───────────────────────────────────────────────────────────────── */

/** The app a trigger listens to: the project's connector slug and a name to show. */
export interface EventAppChoice {
  slug: string;
  name: string;
  /** Label of the shared account picked on the connector; null = the connector's default. */
  account: string | null;
}

function EventAppRow({
  app,
  selected,
  busy,
  canConnect,
  canAdd,
  connecting,
  onSelect,
  onConnect,
}: {
  app: EventApp;
  selected: boolean;
  busy: boolean;
  canConnect: boolean;
  canAdd: boolean;
  connecting: boolean;
  onSelect: () => void;
  onConnect: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const needsAdd = !app.connector;
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-md border p-3 transition-colors',
        selected && 'border-foreground/30 bg-accent/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={busy || (needsAdd && !canAdd)}
        aria-pressed={selected}
        className="hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <AppLogo src={app.logo} />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{app.name}</span>
          <span className="text-muted-foreground block text-xs">
            {tI18nComplete('text6e4a170bdf81', { count: app.event_count })}
          </span>
        </span>
      </button>
      {app.connected ? (
        <Badge variant="kortix" size="sm">
          {tI18nComplete.raw('text22965568d22a')}
        </Badge>
      ) : (
        <>
          {app.connector ? (
            <Badge variant="warning" size="sm">
              {tI18nComplete.raw('textb10983220f3e')}
            </Badge>
          ) : null}
          {canConnect ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy}
              onClick={onConnect}
            >
              {connecting ? <Loading className="size-3.5 shrink-0" /> : <LinkIcon className="size-3.5 shrink-0" />}
              {connecting ? tI18nComplete.raw('textd403c686f6a1') : tI18nComplete.raw('text1a2303ede074')}
            </Button>
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * An app the project has, with its connectors (profiles) and each profile's
 * shared accounts. A profile with no shared account is a plain row with the
 * inline Connect; one with accounts lists them as radio rows.
 */
function EventAppGroup({
  app,
  value,
  busy,
  canConnect,
  canAdd,
  connecting,
  projectId,
  onChange,
  onConnect,
}: {
  app: EventApp;
  value: EventAppChoice | null;
  busy: boolean;
  canConnect: boolean;
  canAdd: boolean;
  connecting: boolean;
  projectId: string;
  onChange: (choice: EventAppChoice) => void;
  onConnect: (connector: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const profiles = appConnectors(app);
  const single = profiles.length === 1 ? profiles[0] : null;
  // The common case, as before: one connector, nothing connected yet.
  if (single && single.accounts.length === 0) {
    return (
      <EventAppRow
        app={app}
        selected={value?.slug === single.slug}
        busy={busy}
        canConnect={canConnect}
        canAdd={canAdd}
        connecting={connecting}
        onSelect={() => onChange({ slug: single.slug, name: app.name, account: null })}
        onConnect={() => onConnect(single.slug)}
      />
    );
  }
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <AppLogo src={app.logo} />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{app.name}</span>
          <span className="text-muted-foreground block text-xs">
            {tI18nComplete('text6e4a170bdf81', {
              count: app.event_count,
            })}
          </span>
        </span>
      </div>
      {profiles.map((profile) => (
        <section key={profile.slug} className="space-y-1.5">
          {profiles.length > 1 ? (
            <h4 className="text-muted-foreground flex items-baseline gap-2 text-xs font-medium">
              {profile.name}
              {profile.name.toLowerCase().includes(profile.slug.toLowerCase()) ? null : (
                <span className="font-mono font-normal">{profile.slug}</span>
              )}
            </h4>
          ) : null}
          {profile.accounts.length > 0 ? (
            <EventAccountRows
              projectId={projectId}
              connector={profile}
              value={value?.slug === profile.slug ? value.account : null}
              active={value?.slug === profile.slug}
              canConnect={canConnect}
              disabled={busy}
              onChange={(account) => onChange({ slug: profile.slug, name: app.name, account })}
            />
          ) : (
            <EventAppRow
              app={{ ...app, name: profile.name, connector: profile.slug, connected: false }}
              selected={value?.slug === profile.slug}
              busy={busy}
              canConnect={canConnect}
              canAdd={canAdd}
              connecting={connecting}
              onSelect={() => onChange({ slug: profile.slug, name: app.name, account: null })}
              onConnect={() => onConnect(profile.slug)}
            />
          )}
        </section>
      ))}
    </li>
  );
}

/**
 * One list of every app with events: the project's own apps first, then the
 * rest of the catalog. Picking an app the project lacks adds it; Connect signs
 * in as the project's shared account in a popup and the row flips to Connected.
 */
export function EventAppPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: EventAppChoice | null;
  onChange: (app: EventAppChoice) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const query = useProjectTriggerEventApps(projectId);
  const { connect, add, connecting, canConnect, canAdd } = useEventAppConnect(projectId);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A picked app moves into "Your apps" at the top: bring the list back to it.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [value?.slug]);
  const apps = query.data?.apps ?? [];
  const { yours, more } = useMemo(() => groupEventApps(apps, search), [apps, search]);

  async function select(app: EventApp) {
    setAdding(app.app);
    try {
      onChange({ slug: await add(target(app)), name: app.name, account: null });
    } catch (error) {
      errorToast(
        error instanceof Error
          ? error.message
          : tI18nComplete('textf5dd6c3bc8a9', { name: app.name }),
      );
    } finally {
      setAdding(null);
    }
  }

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('textc416d056595e')}>
        {query.error instanceof Error ? query.error.message : tI18nComplete.raw('text29cc3339fce9')}
      </InfoBanner>
    );
  }
  if (apps.length === 0) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('text2c4ef9cc0c30')}>
        {tI18nComplete.raw('texte558709e2278')}
      </InfoBanner>
    );
  }

  const chosen = value
    ? (apps.find((a) => appConnectors(a).some((c) => c.slug === value.slug)) ?? null)
    : null;
  const busy = Boolean(adding) || Boolean(connecting);
  const renderRows = (rows: EventApp[]) =>
    rows.map((app) =>
      app.connector ? (
        <EventAppGroup
          key={app.app}
          app={app}
          value={value}
          busy={busy}
          canConnect={canConnect}
          canAdd={canAdd}
          connecting={connecting === app.app}
          projectId={projectId}
          onChange={onChange}
          onConnect={(connector) =>
            connect({ ...target(app), connector }, (slug) =>
              onChange({ slug, name: app.name, account: null }),
            )
          }
        />
      ) : (
        <EventAppRow
          key={app.app}
          app={app}
          selected={false}
          busy={busy}
          canConnect={canConnect}
          canAdd={canAdd}
          connecting={connecting === app.app}
          onSelect={() => void select(app)}
          onConnect={() =>
            connect(target(app), (connector) =>
              onChange({ slug: connector, name: app.name, account: null }),
            )
          }
        />
      ),
    );

  return (
    <div className="space-y-4">
      {apps.length > 8 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tI18nComplete.raw('texta10a36fa1098')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </InputGroupSearch>
      ) : null}
      <div ref={listRef} className="max-h-80 space-y-4 overflow-y-auto pb-2">
        {yours.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">
              {tI18nComplete.raw('text13b17cc7974b')}
            </h3>
            <ul className="space-y-2">{renderRows(yours)}</ul>
          </section>
        ) : null}
        {more.length > 0 ? (
          <section className="space-y-2">
            {yours.length > 0 ? (
              <h3 className="text-muted-foreground text-xs font-medium">
                {tI18nComplete.raw('textf82a179f9235')}
              </h3>
            ) : null}
            <ul className="space-y-2">{renderRows(more)}</ul>
          </section>
        ) : null}
        {yours.length === 0 && more.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nComplete.raw('text3d6f73990a72')}
          </p>
        ) : null}
      </div>
      <p className="text-muted-foreground min-h-10 text-xs leading-relaxed text-pretty">
        {chosen && !profileConnected(chosen, value?.slug ?? '')
          ? canConnect
            ? tI18nComplete('textf287f4494f4b', { name: chosen.name })
            : tI18nComplete('text5550bcf169d6', { name: chosen.name })
          : null}
      </p>
    </div>
  );
}

function target(app: EventApp): EventAppTarget {
  return { app: app.app, name: app.name, connector: app.connector, newConnectorSlug: app.new_connector_slug };
}

/* ─── Event ─────────────────────────────────────────────────────────────── */

export function matchesEventQuery(eventType: ProjectTriggerEventType, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [eventType.name, eventType.description, humanizeEventType(eventType.type)].some((field) =>
    field.toLowerCase().includes(q),
  );
}

/** The chosen event as one row, with a way back to the list. */
export function SelectedEventType({
  eventType,
  onChange,
}: {
  eventType: ProjectTriggerEventType;
  onChange: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const poll = describePollHint(eventType);
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium">
          {eventType.name || humanizeEventType(eventType.type)}
        </span>
        {eventType.description ? (
          <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed text-pretty">
            {eventType.description}
          </span>
        ) : null}
        {poll ? <span className="text-muted-foreground mt-1 block text-xs">{poll}</span> : null}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onChange}>
        {tI18nComplete.raw('textc0bf75bd78bf')}
      </Button>
    </div>
  );
}

export function EventTypePicker({
  projectId,
  connector,
  value,
  onChange,
}: {
  projectId: string;
  connector: string;
  value: string | null;
  onChange: (eventType: ProjectTriggerEventType) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const query = useProjectTriggerEventTypes(projectId, connector);
  const [search, setSearch] = useState('');
  const visible = useMemo(
    () => (query.data?.event_types ?? []).filter((e) => matchesEventQuery(e, search)),
    [query.data, search],
  );

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('text50a06ae2ec9e')}>
        {tI18nComplete.raw('texta9cb192dbee2')}{' '}
        {query.error instanceof Error ? query.error.message : ''}
      </InfoBanner>
    );
  }

  const all = query.data?.event_types ?? [];
  return (
    <div className="space-y-3">
      {all.length > 6 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tI18nComplete.raw('text901abe952186')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </InputGroupSearch>
      ) : null}
      {all.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {tI18nComplete.raw('textbb19f45c3461')}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          {tI18nComplete.raw('textd35a8ebc3a74')}
        </p>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {visible.map((eventType) => {
            const selected = value === eventType.type;
            const poll = describePollHint(eventType);
            return (
              <li key={eventType.type}>
                <button
                  type="button"
                  onClick={() => onChange(eventType)}
                  aria-pressed={selected}
                  className={cn(
                    'hover:bg-accent/50 flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors',
                    selected && 'border-foreground/30 bg-accent/50',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-sm font-medium">
                      {eventType.name || humanizeEventType(eventType.type)}
                    </span>
                    {eventType.description ? (
                      <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed text-pretty">
                        {eventType.description}
                      </span>
                    ) : null}
                    {poll ? (
                      <span className="text-muted-foreground mt-1 block text-xs">{poll}</span>
                    ) : null}
                  </span>
                  {selected ? (
                    <CheckIcon className="text-foreground mt-0.5 size-4 shrink-0" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── Config form ───────────────────────────────────────────────────────── */

/** A form generated from an event's `config_schema`. Renders nothing for an empty schema. */
export function EventConfigForm({
  fields,
  draft,
  onChange,
  disabled,
  errors,
}: {
  fields: SchemaField[];
  draft: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  disabled?: boolean;
  /** Per-field problems from the API, shown under the input. */
  errors?: Record<string, string>;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const set = (key: string, value: string) => onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `event-config-${field.key}`;
        const value = draft[field.key] ?? '';
        const error = errors?.[field.key];
        return (
          <div key={field.key} className="space-y-1.5">
            {field.kind === 'boolean' ? (
              <div className="bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                <Label htmlFor={id} className="text-sm font-normal">
                  {field.label}
                </Label>
                <Switch
                  id={id}
                  checked={value === 'true'}
                  disabled={disabled}
                  onCheckedChange={(checked) => set(field.key, String(checked))}
                />
              </div>
            ) : (
              <>
                <Label htmlFor={id} className="text-sm font-medium">
                  {field.label}
                  {field.required ? (
                    <span className="text-muted-foreground font-normal"> {tI18nComplete.raw('text89db19f651b1')}</span>
                  ) : null}
                </Label>
                {field.kind === 'enum' ? (
                  <Select
                    value={value}
                    onValueChange={(v) => set(field.key, v)}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      id={id}
                      aria-invalid={error ? true : undefined}
                      className="w-full cursor-pointer text-sm"
                    >
                      <SelectValue placeholder={tI18nComplete.raw('text0b24aed53ab6')} />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option} value={option} className="cursor-pointer">
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.kind === 'list' ? (
                  <Textarea
                    id={id}
                    value={value}
                    rows={3}
                    disabled={disabled}
                    placeholder={
                      field.example
                        ? tI18nComplete('text5914bebd5241', { example: field.example })
                        : tI18nComplete.raw('text791210221e4a')
                    }
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    value={value}
                    disabled={disabled}
                    inputMode={field.kind === 'string' ? undefined : 'decimal'}
                    placeholder={field.example ?? undefined}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                )}
              </>
            )}
            {field.description ? (
              <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                {field.description}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Prompt variables ──────────────────────────────────────────────────── */

/** Clickable `{{ event.data.<field> }}` chips; a click hands the token to `onInsert`. */
export function PromptVariableHints({
  payloadSchema,
  onInsert,
}: {
  payloadSchema: Record<string, unknown> | null | undefined;
  onInsert: (token: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const variables = payloadVariables(payloadSchema);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {tI18nComplete.rich(
          variables.length > 0 ? 'text126ba406a50a' : 'text25a3107603e6',
          {
            token: '{{ event.data }}',
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          },
        )}
      </p>
      {variables.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {variables.map((variable) => (
            <button
              key={variable.token}
              type="button"
              title={variable.description ?? undefined}
              onClick={() => onInsert(variable.token)}
              className="bg-muted text-muted-foreground hover:text-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs transition-colors"
            >
              {variable.token}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
