/**
 * Plain-language copy and schema helpers for App event triggers.
 *
 * Pure, so the wording and the JSON-schema handling are testable without
 * rendering. Provider event types arrive as `GITHUB_PULL_REQUEST_EVENT` plus a
 * JSON-schema `config_schema` and `payload_schema`; the UI never shows the wire
 * id first and never asks a person to write JSON.
 */

import type { UiTranslator } from '@/i18n/translator';
import type {
  ProjectTrigger,
  ProjectTriggerEvent,
  ProjectTriggerEventAccount,
  ProjectTriggerEventApp,
  ProjectTriggerEventConnector,
  ProjectTriggerEventType,
} from '@kortix/sdk';

type JsonSchema = Record<string, unknown>;

/* ─── Names ─────────────────────────────────────────────────────────────── */

/** `GITHUB_PULL_REQUEST_EVENT` -> `Github pull request event`. */
export function humanizeEventType(type: string): string {
  const words = type
    .trim()
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return type;
  const sentence = words.join(' ');
  return sentence[0].toUpperCase() + sentence.slice(1);
}

/** `github` -> `Github`; `google_calendar` -> `Google calendar`. */
export function appLabel(app: string | null | undefined, fallback: string): string {
  const raw = (app || fallback).trim();
  if (!raw) return fallback;
  const sentence = raw.replace(/[_-]+/g, ' ');
  return sentence[0].toUpperCase() + sentence.slice(1);
}

/** The list-row sentence: `GITHUB_PULL_REQUEST_CREATED` on github -> "Pull request created on Github". */
export function describeEventWhen(event: ProjectTriggerEvent | null): string {
  if (!event) return 'When an app event happens';
  // The id repeats the app and often ends in a noise word; the sentence names the app once.
  const prefix = `${(event.app ?? '').toLowerCase()}_`;
  const type = (
    event.type.toLowerCase().startsWith(prefix) ? event.type.slice(prefix.length) : event.type
  ).replace(/_(trigger|event)$/i, '');
  return `${humanizeEventType(type || event.type)} on ${appLabel(event.app, event.connector)}`;
}

/** Display names of the event source adapters: the one place a source id becomes a name. */
const EVENT_SOURCE_NAMES: Record<string, string> = { composio: 'Composio' };

/** `composio` -> `Composio`; null when the event names no source. */
export function eventSourceName(event: {
  source?: string | null;
  provider?: string | null;
}): string | null {
  const id = event.source ?? event.provider;
  return id ? (EVENT_SOURCE_NAMES[id] ?? appLabel(id, id)) : null;
}

/**
 * Where an event comes from, as one line: `Github · github-work · acme-bot · via Composio`.
 * The connector shows only when it is not just the app's own name, and the
 * account is the declared label, else the identity the default account runs as.
 * The last part names the event source adapter.
 */
export function describeEventSource(
  event: ProjectTriggerEvent,
  tI18nComplete: UiTranslator,
): string {
  const app = appLabel(event.app, event.connector);
  const parts = [app];
  const same = (a: string, b: string) =>
    a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!same(event.connector, event.app ?? '') && !same(event.connector, app)) {
    parts.push(event.connector);
  }
  const account = event.account ?? event.connected_as ?? null;
  if (account) parts.push(account);
  const source = eventSourceName(event);
  if (source) parts.push(tI18nComplete('text12a4656bfd2a', { source }));
  return parts.join(' · ');
}

/* ─── Status ────────────────────────────────────────────────────────────── */

export interface EventStatusCopy {
  label: string;
  variant: 'kortix' | 'warning' | 'destructive' | 'muted';
  /** The text under the badge: the error, or what to do next. */
  detail: string | null;
}

export function describeEventStatus(
  event: ProjectTriggerEvent,
  tI18nComplete: UiTranslator,
): EventStatusCopy {
  switch (event.status) {
    case 'active':
      return { label: tI18nComplete.raw('textb64ac05f17e6'), variant: 'kortix', detail: null };
    case 'needs_connection':
      return {
        label: tI18nComplete.raw('textd919fde889e9'),
        variant: 'warning',
        detail:
          event.error ??
          tI18nComplete('text2a78b60b1056', { app: appLabel(event.app, event.connector) }),
      };
    case 'error':
      return {
        label: tI18nComplete.raw('text54a0e8c17ebb'),
        variant: 'destructive',
        detail: event.error,
      };
    default:
      return { label: tI18nComplete.raw('textd7b77185afd1'), variant: 'muted', detail: null };
  }
}

/** Where a person connects an account for a connector: the Connectors page, detail open. */
export function connectorHref(projectId: string, connector?: string | null): string {
  const base = `/projects/${projectId}/customize/connectors`;
  return connector ? `${base}?c=${encodeURIComponent(connector)}` : base;
}

/**
 * An event description as one line of plain text: list bullets and emphasis
 * marks go, and line breaks and runs of spaces collapse to one space.
 */
export function oneLineDescription(text: string): string {
  return text
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ─── Config schema -> form fields ──────────────────────────────────────── */

export type SchemaFieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'list';

export interface SchemaField {
  key: string;
  label: string;
  kind: SchemaFieldKind;
  required: boolean;
  description: string | null;
  defaultValue: unknown;
  options: string[];
  /** The first schema example, shown as the input placeholder. */
  example: string | null;
}

function asRecord(value: unknown): JsonSchema | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : null;
}

function fieldKind(prop: JsonSchema): SchemaFieldKind | null {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return 'enum';
  if (prop.type === 'string') return 'string';
  if (prop.type === 'number') return 'number';
  if (prop.type === 'integer') return 'integer';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'array') {
    const items = asRecord(prop.items);
    return !items || items.type === 'string' ? 'list' : null;
  }
  return null;
}

function firstExample(prop: JsonSchema): string | null {
  const first = Array.isArray(prop.examples) ? prop.examples[0] : undefined;
  if (first === undefined || first === null) return null;
  return Array.isArray(first) ? first.map(String).join(', ') : String(first);
}

/**
 * The top-level properties of a config schema a person can fill in. A property
 * of a shape the form cannot render (nested object, array of objects) is left
 * out: the provider applies its own default for it.
 */
export function schemaFields(schema: JsonSchema | null | undefined): SchemaField[] {
  const properties = asRecord(schema?.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).map(String) : [],
  );
  const fields: SchemaField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    if (!prop) continue;
    const kind = fieldKind(prop);
    if (!kind) continue;
    const title = typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : null;
    fields.push({
      key,
      label: title ?? humanizeEventType(key),
      kind,
      required: required.has(key),
      description:
        typeof prop.description === 'string' && prop.description.trim()
          ? prop.description.trim()
          : null,
      defaultValue: prop.default,
      options: kind === 'enum' ? (prop.enum as unknown[]).map(String) : [],
      example: firstExample(prop),
    });
  }
  return fields;
}

/** Form state is text for every kind; booleans are `'true'`/`'false'`, lists are one entry per line. */
export type ConfigDraft = Record<string, string>;

function draftValue(field: SchemaField): string {
  const value = field.defaultValue;
  if (value === undefined || value === null) return field.kind === 'boolean' ? 'false' : '';
  if (Array.isArray(value)) return value.map(String).join('\n');
  return String(value);
}

export function defaultConfigDraft(fields: SchemaField[]): ConfigDraft {
  return Object.fromEntries(fields.map((f) => [f.key, draftValue(f)]));
}

/** Rebuilds a draft from a saved `event.config`, keeping defaults for the keys it lacks. */
export function configToDraft(fields: SchemaField[], config: Record<string, unknown>): ConfigDraft {
  const draft = defaultConfigDraft(fields);
  for (const field of fields) {
    const value = config[field.key];
    if (value === undefined || value === null) continue;
    draft[field.key] = Array.isArray(value) ? value.map(String).join('\n') : String(value);
  }
  return draft;
}

/** The first problem a person has to fix before saving, or null. */
export function configProblem(fields: SchemaField[], draft: ConfigDraft): string | null {
  for (const field of fields) {
    const text = (draft[field.key] ?? '').trim();
    if (!text) {
      if (field.required && field.kind !== 'boolean') return `${field.label} is required.`;
      continue;
    }
    if ((field.kind === 'number' || field.kind === 'integer') && !Number.isFinite(Number(text))) {
      return `${field.label} must be a number.`;
    }
    if (field.kind === 'integer' && !Number.isInteger(Number(text))) {
      return `${field.label} must be a whole number.`;
    }
  }
  return null;
}

/** The `event_config` the API receives: typed values, empty fields left out. */
export function draftToConfig(fields: SchemaField[], draft: ConfigDraft): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const text = (draft[field.key] ?? '').trim();
    if (field.kind === 'boolean') {
      // An untouched `false` with no default is "not set", not "set to false".
      if (text === 'true' || field.defaultValue !== undefined) config[field.key] = text === 'true';
      continue;
    }
    if (!text) continue;
    if (field.kind === 'number' || field.kind === 'integer') config[field.key] = Number(text);
    else if (field.kind === 'list') {
      config[field.key] = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } else config[field.key] = text;
  }
  return config;
}

/**
 * Splits the API's 400 for a bad event config, `Invalid config for X: repo is
 * required (<description>); days must be integer (<description>).`, into one
 * line per field so each shows under its own input. Text that names no known
 * field stays in `general`.
 */
export function parseConfigErrors(
  message: string,
  fields: SchemaField[],
): { byField: Record<string, string>; general: string | null } {
  const byField: Record<string, string> = {};
  const body = message.replace(/^Invalid config for [^:]+:\s*/, '').replace(/\.$/, '');
  if (body === message.replace(/\.$/, '')) return { byField, general: message };
  let last: string | null = null;
  const general: string[] = [];
  for (const part of body.split('; ')) {
    const field = fields.find((f) => part.startsWith(`${f.key} `));
    if (field) {
      // The description prints under the input already; keep only the problem.
      byField[field.key] =
        `${field.label} ${part.slice(field.key.length + 1).replace(/\s+\(.*$/, '')}.`;
      last = field.key;
    } else if (!last) general.push(part); // else: a description that contains "; ", already shown
  }
  return { byField, general: general.length ? general.join('; ') : null };
}

/* ─── App list ──────────────────────────────────────────────────────────── */

/** One app in the picker. `connector` is null until the project adds it. */
export type EventApp = ProjectTriggerEventApp;

/** Apps most projects want first in the catalog; the rest follow by name. */
const POPULAR_APPS = [
  'gmail',
  'github',
  'slack',
  'googlecalendar',
  'linear',
  'notion',
  'jira',
  'outlook',
  'hubspot',
  'googledrive',
  'googlesheets',
  'stripe',
];

/**
 * The picker order: the project's own apps first (connected before
 * unconnected, then by name), then the popular apps, then every other app with events by name.
 * Returns the two groups so the list can label them.
 */
export function groupEventApps(
  apps: EventApp[],
  query: string,
): { yours: EventApp[]; more: EventApp[] } {
  const q = query.trim().toLowerCase();
  const byName = (a: EventApp, b: EventApp) => a.name.localeCompare(b.name);
  const visible = apps.filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.app.toLowerCase().includes(q),
  );
  const yours = visible
    .filter((a) => a.connector)
    .sort((a, b) => Number(b.connected) - Number(a.connected) || byName(a, b));
  const rank = (a: EventApp) => {
    const i = POPULAR_APPS.indexOf(a.app);
    return i === -1 ? POPULAR_APPS.length : i;
  };
  const more = visible
    .filter((a) => !a.connector)
    .sort((a, b) => rank(a) - rank(b) || byName(a, b));
  return { yours, more };
}

/* ─── Connectors and accounts ───────────────────────────────────────────── */

/** The connector profiles of an app. An API without `connectors` yields the one profile it names. */
export function appConnectors(app: EventApp): ProjectTriggerEventConnector[] {
  if (app.connectors && app.connectors.length > 0) return app.connectors;
  return app.connector ? [{ slug: app.connector, name: app.name, accounts: [] }] : [];
}

/** The project has a connected shared account on this connector of the app. */
export function profileConnected(app: EventApp, connector: string): boolean {
  const profile = appConnectors(app).find((c) => c.slug === connector);
  if (profile && profile.accounts.length > 0) return profile.accounts.some((a) => a.connected);
  return app.connector === connector && app.connected;
}

/** The account a trigger runs on when it names none. */
export function defaultAccount(
  connector: ProjectTriggerEventConnector,
): ProjectTriggerEventAccount | null {
  return connector.accounts.find((a) => a.is_default) ?? null;
}

/** The label the form highlights: the declared one, else the connector default's. */
export function selectedAccountLabel(
  connector: ProjectTriggerEventConnector,
  account: string | null,
): string | null {
  return account ?? defaultAccount(connector)?.label ?? null;
}

/**
 * The `account` a trigger stores for a picked label. The connector default is
 * stored as null, so `kortix.yaml` names an account only when it differs.
 */
export function accountToStore(
  connector: ProjectTriggerEventConnector,
  label: string | null,
): string | null {
  if (!label || defaultAccount(connector)?.label === label) return null;
  return label;
}

/** An account row: who it runs as, and its label when that differs. */
export function describeAccount(account: ProjectTriggerEventAccount): {
  title: string;
  detail: string | null;
} {
  const identity = account.connected_as?.trim();
  if (identity && identity !== account.label) return { title: identity, detail: account.label };
  return { title: account.label, detail: null };
}

/** The app-event triggers that run on one connector, in list order. */
export function eventTriggersOn(triggers: ProjectTrigger[], connector: string): ProjectTrigger[] {
  return triggers.filter((t) => t.type === 'event' && t.event?.connector === connector);
}

/** The connector slug for a new app: the app slug, or one with a suffix when taken. */
export function newConnectorSlug(app: string, taken: readonly string[]): string {
  const slug =
    app
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app';
  if (!taken.includes(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.includes(`${slug}-${n}`)) return `${slug}-${n}`;
}

/* ─── Delivery ──────────────────────────────────────────────────────────── */

/** "Checks every 5 min" for a polled event whose schema publishes a default interval. */
export function describePollHint(eventType: ProjectTriggerEventType): string | null {
  if (eventType.delivery !== 'poll') return null;
  const interval = asRecord(asRecord(eventType.config_schema.properties)?.interval);
  const minutes = Number(interval?.default);
  return Number.isFinite(minutes) && minutes > 0 ? `Checks every ${minutes} min` : null;
}

/* ─── Prompt ────────────────────────────────────────────────────────────── */

export interface PayloadVariable {
  /** The template expression, e.g. `{{ event.data.title }}`. */
  token: string;
  description: string | null;
}

/** Top-level properties of `event.data`, each as a clickable template variable. */
export function payloadVariables(
  payloadSchema: Record<string, unknown> | null | undefined,
): PayloadVariable[] {
  const properties = asRecord(payloadSchema?.properties);
  if (!properties) return [];
  return Object.entries(properties).map(([key, raw]) => {
    const description = asRecord(raw)?.description;
    return {
      token: `{{ event.data.${key} }}`,
      description:
        typeof description === 'string' && description.trim() ? description.trim() : null,
    };
  });
}

/** The starting prompt: what happened, plus the whole event for the agent to read. */
export function defaultEventPrompt(
  eventType: Pick<ProjectTriggerEventType, 'name' | 'type'>,
): string {
  const name = eventType.name.trim() || humanizeEventType(eventType.type);
  return `${name} just happened. Look at the event below and do what is useful.\n\n{{ event.data }}`;
}

/** A name the form can propose before the person types one. */
export function defaultEventName(
  eventType: Pick<ProjectTriggerEventType, 'name' | 'type'>,
): string {
  return eventType.name.trim() || humanizeEventType(eventType.type);
}
