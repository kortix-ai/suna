/**
 * Plain-language copy and schema helpers for App event triggers.
 *
 * Pure, so the wording and the JSON-schema handling are testable without
 * rendering. Provider event types arrive as `GITHUB_PULL_REQUEST_EVENT` plus a
 * JSON-schema `config_schema` and `payload_schema`; the UI never shows the wire
 * id first and never asks a person to write JSON.
 */

import type { ProjectTriggerEvent, ProjectTriggerEventType } from '@kortix/sdk';

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
  const type = (event.type.toLowerCase().startsWith(prefix) ? event.type.slice(prefix.length) : event.type)
    .replace(/_(trigger|event)$/i, '');
  return `${humanizeEventType(type || event.type)} on ${appLabel(event.app, event.connector)}`;
}

/* ─── Status ────────────────────────────────────────────────────────────── */

export interface EventStatusCopy {
  label: 'Live' | 'Needs connection' | 'Error' | 'Activating';
  variant: 'kortix' | 'warning' | 'destructive' | 'muted';
  /** The text under the badge: the error, or what to do next. */
  detail: string | null;
}

export function describeEventStatus(event: ProjectTriggerEvent): EventStatusCopy {
  switch (event.status) {
    case 'active':
      return { label: 'Live', variant: 'kortix', detail: null };
    case 'needs_connection':
      return {
        label: 'Needs connection',
        variant: 'warning',
        detail:
          event.error ??
          `Connect a shared ${appLabel(event.app, event.connector)} account to activate this trigger.`,
      };
    case 'error':
      return { label: 'Error', variant: 'destructive', detail: event.error };
    default:
      return { label: 'Activating', variant: 'muted', detail: null };
  }
}

/** Where a person connects an account for a connector: the Connectors page, detail open. */
export function connectorHref(projectId: string, connector?: string | null): string {
  const base = `/projects/${projectId}/customize/connectors`;
  return connector ? `${base}?c=${encodeURIComponent(connector)}` : base;
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
