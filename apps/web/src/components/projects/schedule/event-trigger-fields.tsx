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
import { cn } from '@/lib/utils';
import type { ProjectTriggerEventType } from '@kortix/sdk';
import { useProjectTriggerEventApps, useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { CheckIcon, LinkIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type EventApp,
  describePollHint,
  groupEventApps,
  humanizeEventType,
  payloadVariables,
  type ConfigDraft,
  type SchemaField,
} from './event-trigger-copy';
import { type EventAppTarget, useEventAppConnect } from './use-event-app-connect';

/* ─── App ───────────────────────────────────────────────────────────────── */

/** The app a trigger listens to: the project's connector slug and a name to show. */
export interface EventAppChoice {
  slug: string;
  name: string;
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
            {app.event_count} {app.event_count === 1 ? 'event' : 'events'}
          </span>
        </span>
      </button>
      {app.connected ? (
        <Badge variant="kortix" size="sm">
          Connected
        </Badge>
      ) : (
        <>
          {app.connector ? (
            <Badge variant="warning" size="sm">
              Needs account
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
              {connecting ? 'Connecting' : 'Connect'}
            </Button>
          ) : null}
        </>
      )}
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
  value: string | null;
  onChange: (app: EventAppChoice) => void;
}) {
  const query = useProjectTriggerEventApps(projectId);
  const { connect, add, connecting, canConnect, canAdd } = useEventAppConnect(projectId);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A picked app moves into "Your apps" at the top: bring the list back to it.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [value]);
  const apps = query.data?.apps ?? [];
  const { yours, more } = useMemo(() => groupEventApps(apps, search), [apps, search]);

  async function select(app: EventApp) {
    if (app.connector) return onChange({ slug: app.connector, name: app.name });
    setAdding(app.app);
    try {
      onChange({ slug: await add(target(app)), name: app.name });
    } catch (error) {
      errorToast(error instanceof Error ? error.message : `Could not add ${app.name}`);
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
      <InfoBanner tone="warning" className="text-xs" title="Could not load apps with events">
        {query.error instanceof Error ? query.error.message : 'Try again in a moment.'}
      </InfoBanner>
    );
  }
  if (apps.length === 0) {
    return (
      <InfoBanner tone="warning" className="text-xs" title="No app events here yet">
        App events are not set up on this deployment, so no app can send them yet.
      </InfoBanner>
    );
  }

  const chosen = value ? (apps.find((a) => a.connector === value) ?? null) : null;
  const renderRows = (rows: EventApp[]) =>
    rows.map((app) => (
      <EventAppRow
        key={app.app}
        app={app}
        selected={Boolean(value) && app.connector === value}
        busy={Boolean(adding) || Boolean(connecting)}
        canConnect={canConnect}
        canAdd={canAdd}
        connecting={connecting === app.app}
        onSelect={() => void select(app)}
        onConnect={() =>
          connect(target(app), (connector) => onChange({ slug: connector, name: app.name }))
        }
      />
    ));

  return (
    <div className="space-y-4">
      {apps.length > 8 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search apps"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </InputGroupSearch>
      ) : null}
      <div ref={listRef} className="max-h-80 space-y-4 overflow-y-auto">
        {yours.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">Your apps</h3>
            <ul className="space-y-2">{renderRows(yours)}</ul>
          </section>
        ) : null}
        {more.length > 0 ? (
          <section className="space-y-2">
            {yours.length > 0 ? (
              <h3 className="text-muted-foreground text-xs font-medium">More apps with events</h3>
            ) : null}
            <ul className="space-y-2">{renderRows(more)}</ul>
          </section>
        ) : null}
        {yours.length === 0 && more.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">No apps match.</p>
        ) : null}
      </div>
      <p className="text-muted-foreground min-h-10 text-xs leading-relaxed text-pretty">
        {chosen && !chosen.connected
          ? canConnect
            ? `It goes live when the ${chosen.name} account is connected. You can connect it now or after you create the trigger.`
            : `You cannot connect shared accounts. Ask a project admin to connect ${chosen.name}. The trigger goes live when they do.`
          : null}
      </p>
    </div>
  );
}

function target(app: EventApp): EventAppTarget {
  return { app: app.app, name: app.name, connector: app.connector };
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
        Change
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
      <InfoBanner tone="warning" className="text-xs" title="This app cannot send events here">
        The event source for this app is not available on this deployment, so its events cannot be
        listed yet. {query.error instanceof Error ? query.error.message : ''}
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
            placeholder="Search events"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </InputGroupSearch>
      ) : null}
      {all.length === 0 ? (
        <p className="text-muted-foreground text-xs">This app has no events to listen for.</p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">No events match.</p>
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
                    <span className="text-muted-foreground font-normal"> (required)</span>
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
                      <SelectValue placeholder="Choose one" />
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
                    placeholder={field.example ? `One per line, e.g. ${field.example}` : 'One per line'}
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
  const variables = payloadVariables(payloadSchema);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {variables.length > 0
          ? 'Click a field to add it to the instruction. The event is also available as '
          : 'The event is available as '}
        <code className="font-mono">{'{{ event.data }}'}</code>.
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
