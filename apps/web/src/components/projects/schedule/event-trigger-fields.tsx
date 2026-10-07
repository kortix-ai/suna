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
import { ConnectorAppIcon } from '@/features/workspace/capabilities/connectors/connector-identity';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import { cn } from '@/lib/utils';
import { listConnectors, type AdminConnector, type ProjectTriggerEventType } from '@kortix/sdk';
import { contract, qk, useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { CheckIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  connectorHref,
  describePollHint,
  humanizeEventType,
  payloadVariables,
  type ConfigDraft,
  type SchemaField,
} from './event-trigger-copy';

/* ─── Connector ─────────────────────────────────────────────────────────── */

/** Apps whose events a person can subscribe to. Composio is the one event source today. */
export function eventConnectors(connectors: AdminConnector[]): AdminConnector[] {
  return connectors.filter((c) => c.provider === 'composio' && c.status !== 'disabled');
}

export function EventConnectorPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string | null;
  onChange: (connector: AdminConnector) => void;
}) {
  // Same key and fetch as the Connectors page, so the two share one cache entry.
  const query = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract('inventory'),
  });
  const connectors = useMemo(() => eventConnectors(query.data?.connectors ?? []), [query.data]);

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <InfoBanner tone="destructive" className="text-xs">
        Could not load your apps. {query.error instanceof Error ? query.error.message : ''}
      </InfoBanner>
    );
  }

  return (
    <div className="space-y-2">
      {connectors.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          No apps are connected yet. Connect one, then come back to pick an event.
        </p>
      ) : (
        <ul className="space-y-2">
          {connectors.map((connector) => {
            const connected = connectorSetupStatus(connector) === 'connected';
            const selected = value === connector.slug;
            return (
              <li key={connector.slug}>
                <button
                  type="button"
                  onClick={() => onChange(connector)}
                  aria-pressed={selected}
                  className={cn(
                    'hover:bg-accent/50 flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors',
                    selected && 'border-foreground/30 bg-accent/50',
                  )}
                >
                  <ConnectorAppIcon connector={connector} />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {connector.name}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {connected ? 'Shared account connected' : 'No shared account yet'}
                    </span>
                  </span>
                  {connected ? (
                    <Badge variant="kortix" size="sm">
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="sm">
                      Needs account
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link href={connectorHref(projectId)}>
          <PlusIcon className="size-3.5 shrink-0" />
          Connect an app
        </Link>
      </Button>
    </div>
  );
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
}: {
  fields: SchemaField[];
  draft: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  disabled?: boolean;
}) {
  const set = (key: string, value: string) => onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `event-config-${field.key}`;
        const value = draft[field.key] ?? '';
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
                    <SelectTrigger id={id} className="w-full cursor-pointer text-sm">
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
                    placeholder="One per line"
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    value={value}
                    disabled={disabled}
                    inputMode={field.kind === 'string' ? undefined : 'decimal'}
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
