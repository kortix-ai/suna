/**
 * The "New trigger" composer's rules, with no React in them: the draft, the
 * name that follows it, the sentence that sums it up, what blocks the Create
 * button, and the order Create does its writes in. Pure, so each rule is
 * testable without rendering.
 */

import type { UiTranslator } from '../../../i18n';
import type { App, ProjectTriggerEventType, TriggerFilterValue } from '@kortix/sdk';
import type { ModelKey } from '@kortix/sdk/react';

import type { SharingSelection } from '../../../access/sharing-picker';
import {
  type ConfigDraft,
  type EventApp,
  type SchemaField,
  accountToWrite,
  appConnectors,
  configProblem,
  defaultEventName,
  defaultEventPrompt,
  selectedAccountLabel,
} from './event-trigger-copy';
import {
  type SessionMode,
  type TriggerKind,
  describeCadence,
  describeOneOff,
} from './schedule-copy';
import { type ConditionRow, conditionNeedsValue, rowsToConditions } from './schedule-fields';

/** A block of the composer. Problems point at one, in the order a person meets them. */
export type ComposerBlock = 'when' | 'then' | 'name' | 'options';

export interface ComposerDraft {
  kind: TriggerKind;
  // When: schedule
  cron: string;
  runAt: string | null;
  timezone: string;
  // When: webhook
  signingKey: string;
  // When: app event
  /** Provider app slug (`gmail`). Null until an app is picked. */
  appSlug: string | null;
  /**
   * Event source of the picked app (`composio`, `mcp`): one app slug can be
   * listed by both. Null: match the slug alone (a trigger saved by an older API).
   */
  appSource: string | null;
  /** The project's connector (profile) the trigger runs on. Null = the app's first. */
  profile: string | null;
  /** Label of a shared account on that profile. Null = the profile's default. */
  account: string | null;
  eventType: ProjectTriggerEventType | null;
  configDraft: ConfigDraft;
  // When: Kortix App event
  /** Slug of the project's App whose events fire the trigger. Null until one is picked. */
  kortixApp: string | null;
  /** The one event name the trigger fires on (`reply.received`). Empty = every event. */
  appEvent: string;
  // Then
  instruction: string;
  agent: string | null;
  model: ModelKey | null;
  /** The name the person typed. Null = follow {@link autoName}. */
  nameOverride: string | null;
  // Options
  mode: SessionMode;
  pinnedSessionId: string | null;
  sessionKey: string;
  conditions: ConditionRow[];
  customId: string;
  secretName: string;
  startActive: boolean;
  sessionAccess: SharingSelection;
  /** The channel or DM its runs post to (`project_channels`). Null = none: runs land in `#general`. */
  spaceId: string | null;
  /** Run limits (KRTX-1721) as typed. Empty = unset: 60 an hour, no daily cap. */
  maxRunsPerHour: string;
  maxRunsPerDay: string;
  /** Overlap (KRTX-1721), fresh mode only. `default`: skip for a schedule, allow for the others. */
  overlap: 'default' | 'skip' | 'allow';
}

/** The sharing a space implies: a channel thread is project-visible; a DM thread is the viewer's. */
export function spaceTriggerAccess(kind: 'channel' | 'dm', viewerId: string | undefined): SharingSelection {
  return kind === 'dm' && viewerId
    ? { mode: 'members', memberIds: [viewerId], groupIds: [] }
    : { mode: 'project', memberIds: [], groupIds: [] };
}

const sameAccess = (a: SharingSelection, b: SharingSelection) => JSON.stringify(a) === JSON.stringify(b);

/**
 * "Post to" picks a space. The sharing follows the space only while the person
 * has not chosen their own (it is still `base` or what the old space implied);
 * a DM always sets its sharing and its agent, as the API requires. "No channel"
 * gives back `base` when the sharing was only the space's.
 */
export function postToChange(
  draft: Pick<ComposerDraft, 'sessionAccess'>,
  next: { spaceId: string; kind: 'channel' | 'dm'; dmAgentName: string | null } | null,
  context: { base: SharingSelection; current: { kind: 'channel' | 'dm' } | null; viewerId: string | undefined },
): Partial<ComposerDraft> {
  const implied = context.current ? spaceTriggerAccess(context.current.kind, context.viewerId) : null;
  const untouched =
    sameAccess(draft.sessionAccess, context.base) || (implied !== null && sameAccess(draft.sessionAccess, implied));
  if (!next) return { spaceId: null, ...(untouched ? { sessionAccess: context.base } : {}) };
  return {
    spaceId: next.spaceId,
    ...(next.kind === 'dm' || untouched ? { sessionAccess: spaceTriggerAccess(next.kind, context.viewerId) } : {}),
    ...(next.kind === 'dm' && next.dmAgentName ? { agent: next.dmAgentName } : {}),
  };
}

/** A run-limit input as the API wants it: empty → null (unset), else the number. */
export function runCapFromInput(raw: string): number | null {
  const value = raw.trim();
  return value ? Number(value) : null;
}

export function initialDraft(init: {
  kind?: TriggerKind | null;
  agent?: string | null;
  appSlug?: string | null;
  appSource?: string | null;
  profile?: string | null;
  spaceId?: string | null;
}): ComposerDraft {
  return {
    kind: init.kind ?? 'cron',
    cron: '0 0 9 * * *',
    runAt: null,
    timezone: 'UTC',
    signingKey: '',
    appSlug: init.appSlug ?? null,
    appSource: init.appSource ?? null,
    profile: init.profile ?? null,
    account: null,
    eventType: null,
    configDraft: {},
    kortixApp: null,
    appEvent: '',
    instruction: '',
    agent: init.agent ?? null,
    model: null,
    nameOverride: null,
    mode: 'fresh',
    pinnedSessionId: null,
    sessionKey: '',
    conditions: [],
    customId: '',
    secretName: '',
    startActive: true,
    sessionAccess: { mode: 'private', memberIds: [], groupIds: [] },
    spaceId: init.spaceId ?? null,
    maxRunsPerHour: '',
    maxRunsPerDay: '',
    overlap: 'default',
  };
}

/* ─── Keys and slugs ────────────────────────────────────────────────────── */

/**
 * A random signing key, hex-encoded.
 *
 * NO `Math.random` fallback. This key SIGNS webhook payloads, so a predictable
 * one is forgeable — and V8's `Math.random` is xorshift128+, whose internal
 * state is recoverable from a handful of outputs, so the old fallback produced
 * a key an attacker could reproduce (CodeQL js/insecure-randomness, #6471).
 * `crypto.getRandomValues` is available in every browser back to IE11 and in
 * Node >= 19, so that branch was dead code that could only ever weaken the key.
 * Refusing is the correct failure here: no key at all is safer than one that
 * looks random and is not.
 */
export function generateSigningKey(): string {
  if (typeof crypto === 'undefined' || !('getRandomValues' in crypto)) {
    throw new Error('Cannot generate a signing key: this browser has no secure random source.');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Saved-secret names are UPPER_SNAKE_CASE — mirror the API's own rule so a
 *  typed name can't fail on save. */
export function normalizeSecretName(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'automation'
  );
}

/* ─── Name and summary ──────────────────────────────────────────────────── */

/** The name the field proposes: it follows the When block until the person types one. */
export function autoName(draft: ComposerDraft, tI18nComplete: UiTranslator): string {
  if (draft.kind === 'event') return draft.eventType ? defaultEventName(draft.eventType) : '';
  if (draft.kind === 'webhook') return tI18nComplete.raw('text4814f62c108d');
  if (draft.kind === 'app') {
    if (!draft.kortixApp) return '';
    const event = appEventName(draft);
    return event ? `${draft.kortixApp}: ${event}` : tI18nComplete('texte9b6dc29c812', { app: draft.kortixApp });
  }
  return draft.runAt ? describeOneOff(draft.runAt) : describeCadence(draft.cron);
}

export function triggerName(draft: ComposerDraft, tI18nComplete: UiTranslator): string {
  return draft.nameOverride ?? autoName(draft, tI18nComplete);
}

/** An event app's source: `source`, or the deprecated `provider` of an older API. */
export const eventAppSource = (app: EventApp): string => app.source ?? app.provider;

/** The app the draft points at: by source and slug, else the one that owns the chosen connector. */
export function findDraftApp(apps: EventApp[], draft: ComposerDraft): EventApp | null {
  if (draft.appSlug) {
    return apps.find((a) => a.app === draft.appSlug && (!draft.appSource || eventAppSource(a) === draft.appSource)) ?? null;
  }
  if (draft.profile) {
    return apps.find((a) => appConnectors(a).some((c) => c.slug === draft.profile)) ?? null;
  }
  return null;
}

/** The connector (profile) slug an event trigger runs on, or null when the app has none yet. */
export function resolveProfile(app: EventApp | null, draft: ComposerDraft): string | null {
  const profiles = app ? appConnectors(app) : [];
  return profiles.find((c) => c.slug === draft.profile)?.slug ?? profiles[0]?.slug ?? null;
}

/**
 * One sentence that says what the trigger does as configured. With nothing
 * chosen yet (an app event without an event) it says what a trigger is.
 */
export function summarize(
  draft: ComposerDraft,
  app: EventApp | null,
  /** The name the agent picker shows (`agentDisplayLabel`), so the two never disagree. */
  agent: string,
  tI18nComplete: UiTranslator,
): string {
  if (draft.kind === 'webhook') return tI18nComplete('text18ae226f8a22', { agent });
  if (draft.kind === 'app') {
    if (!draft.kortixApp) return tI18nComplete.raw('textf60eb7723e40');
    const event = appEventName(draft);
    return event
      ? tI18nComplete('text860e6ea2b98b', { app: draft.kortixApp, event, agent })
      : tI18nComplete('text2def58884d12', { app: draft.kortixApp, agent });
  }
  if (draft.kind === 'event') {
    if (!draft.eventType) return tI18nComplete.raw('textf60eb7723e40');
    return tI18nComplete('text8ebeeead4672', {
      event: defaultEventName(draft.eventType),
      app: app?.name ?? draft.appSlug ?? '',
      agent,
    });
  }
  const when = draft.runAt
    ? describeOneOff(draft.runAt)
    : `${describeCadence(draft.cron)} (${draft.timezone})`;
  return tI18nComplete('text922ecdf9cffc', { when, agent });
}

/* ─── Problems ──────────────────────────────────────────────────────────── */

export interface ComposerProblem {
  block: ComposerBlock;
  /** The config field this belongs under, for an event's settings. */
  field?: string;
  message: string;
}

/** Every reason Create is blocked, in the order a person meets the blocks. */
export function validate(
  draft: ComposerDraft,
  ctx: {
    name: string;
    configFields: SchemaField[];
    app: EventApp | null;
    now?: number;
    /** Editing a saved trigger: its app may be missing from the catalog, and a webhook keeps its signing key. */
    edit?: boolean;
  },
  tI18nComplete: UiTranslator,
): ComposerProblem[] {
  const problems: ComposerProblem[] = [];
  const add = (block: ComposerBlock, message: string, field?: string) =>
    problems.push({ block, message, ...(field ? { field } : {}) });

  if (draft.kind === 'event') {
    if (!ctx.app) {
      if (!ctx.edit) add('when', tI18nComplete.raw('text98bc0d3ce693'));
    } else if (!draft.eventType) add('when', tI18nComplete.raw('textbb96443de263'));
    else {
      for (const field of ctx.configFields) {
        const message = configProblem([field], draft.configDraft);
        if (message) add('when', message, field.key);
      }
    }
  } else if (draft.kind === 'app') {
    if (!draft.kortixApp) add('when', tI18nComplete.raw('text69de76117f00'));
  } else if (draft.kind === 'cron') {
    if (draft.runAt) {
      if (Number.isNaN(Date.parse(draft.runAt))) add('when', tI18nComplete.raw('text653989c59b4b'));
      else if (Date.parse(draft.runAt) <= (ctx.now ?? Date.now()))
        add('when', tI18nComplete.raw('textebfef07e2d2b'));
    } else if (!draft.cron.trim()) add('when', tI18nComplete.raw('texta1b7270dbe34'));
  } else if (!ctx.edit && !draft.signingKey.trim()) {
    add('when', tI18nComplete.raw('textc10cd37e5462'));
  }

  if (!draft.instruction.trim()) add('then', tI18nComplete.raw('texte7cd9e292007'));
  if (!ctx.name.trim()) add('name', tI18nComplete.raw('textb67ba8d96c42'));

  if (draft.mode === 'pinned' && !draft.pinnedSessionId)
    add('options', tI18nComplete.raw('text2b8e1487be3b'));
  if (draft.mode === 'keyed' && !draft.sessionKey.trim())
    add('options', tI18nComplete.raw('text473d5c3c6169'));
  // A half-filled condition is a silent no-op otherwise — say so instead.
  // An exists/missing row has no value field, so its path alone completes it.
  if (
    draft.kind !== 'cron' &&
    draft.conditions.some(
      (row) => Boolean(row.path.trim()) !== (!conditionNeedsValue(row.operator) || Boolean(row.value.trim())),
    )
  )
    add('options', tI18nComplete.raw('text8f4597a69c3c'));
  return problems;
}

/* ─── Kortix App event ──────────────────────────────────────────────────── */

/**
 * The filter path that names an App event. The API stores an App event
 * trigger's event as this one condition (`on.event` in kortix.yaml); without
 * it the trigger fires on every event of the App.
 */
export const APP_EVENT_NAME_PATH = 'event.name';

/**
 * The Apps that can send events: every App Kortix runs. An external App
 * (`external_url`) runs elsewhere and has no `KORTIX_APP_TOKEN`.
 */
export function eventSendingApps(apps: readonly App[] | undefined): App[] {
  return (apps ?? []).filter((app) => !app.external_url);
}

/** The named event, trimmed. `*` means every event, as in kortix.yaml and the CLI. */
export function appEventName(draft: Pick<ComposerDraft, 'appEvent'>): string {
  const name = draft.appEvent.trim();
  return name === '*' ? '' : name;
}

/** The filter Create and Save send: the conditions, plus `event.name` for an App event that names one event. */
export function triggerFilter(
  draft: Pick<ComposerDraft, 'kind' | 'appEvent' | 'conditions'>,
): Record<string, TriggerFilterValue> | null {
  const conditions = rowsToConditions(draft.conditions);
  const event = draft.kind === 'app' ? appEventName(draft) : '';
  return event ? { ...conditions, [APP_EVENT_NAME_PATH]: event } : conditions;
}

/* ─── Event pick ────────────────────────────────────────────────────────── */

/**
 * The draft after an event is picked: its config resets to the event's
 * defaults, and the instruction is prefilled only while it is empty or still
 * the last prefill, so a second pick never eats the person's words.
 */
export function withEventPicked(
  draft: ComposerDraft,
  next: ProjectTriggerEventType,
  configDraft: ConfigDraft,
): ComposerDraft {
  const untouched =
    !draft.instruction.trim() ||
    (draft.eventType !== null && draft.instruction === defaultEventPrompt(draft.eventType));
  return {
    ...draft,
    eventType: next,
    configDraft,
    instruction: untouched ? defaultEventPrompt(next) : draft.instruction,
  };
}

/* ─── Create ────────────────────────────────────────────────────────────── */

/**
 * Create's writes in order. An app event on an app the project has no
 * connector for adds that connector first; if that fails, no trigger is
 * written and the error reaches the caller.
 */
export async function runCreate<T>(steps: {
  /** Adds the connector and resolves to its slug; null when the project already has one. */
  addConnector: (() => Promise<string>) | null;
  createTrigger: (connector: string | null) => Promise<T>;
}): Promise<T> {
  const connector = steps.addConnector ? await steps.addConnector() : null;
  return steps.createTrigger(connector);
}

/* ─── Pick and clear ────────────────────────────────────────────────────── */

/** Another way to start the trigger. The Then block and the name the person typed stay as typed. */
export function withKind(draft: ComposerDraft, kind: TriggerKind): ComposerDraft {
  return { ...draft, kind };
}

/** The prefilled instruction goes with its event; words the person wrote stay. */
function instructionAfterClear(draft: ComposerDraft): string {
  const prefilled =
    draft.eventType !== null && draft.instruction === defaultEventPrompt(draft.eventType);
  return prefilled ? '' : draft.instruction;
}

/** Back to the event list of the same app. */
export function withEventCleared(draft: ComposerDraft): ComposerDraft {
  return { ...draft, instruction: instructionAfterClear(draft), eventType: null, configDraft: {} };
}

/** A different app (or none): its events, connector and account no longer apply. */
export function withAppPicked(draft: ComposerDraft, appSlug: string | null, appSource: string | null = null): ComposerDraft {
  return { ...withEventCleared(draft), appSlug, appSource, profile: null, account: null };
}

/* ─── Connection: connector first, then its account ─────────────────────── */

/** A different connector (profile): its accounts replace the old list, and the account falls back to that connector's default. */
export function withProfilePicked(draft: ComposerDraft, profile: string): ComposerDraft {
  return { ...draft, profile, account: null };
}

/** What the Connection block shows: the chosen connector, the account radio's value and whether it has no account at all. */
export function connectionView(app: EventApp | null, draft: ComposerDraft) {
  const slug = resolveProfile(app, draft);
  const profile = (app ? appConnectors(app) : []).find((p) => p.slug === slug) ?? null;
  return {
    profile,
    selectedAccount: profile ? selectedAccountLabel(profile, draft.account) : null,
    noAccounts: profile !== null && profile.accounts.length === 0,
  };
}

/**
 * The connector and account an event trigger is written with. `connector` is
 * the profile slug (or the one Create just added); `event_account` appears for a
 * non-default account, and for the account the form shows when the connector has no default.
 */
export function triggerConnection(
  app: EventApp | null,
  draft: ComposerDraft,
  added: string | null,
): { connector: string | undefined; event_account?: string } {
  if (added) return { connector: added };
  const connector = resolveProfile(app, draft) ?? undefined;
  const profile = (app ? appConnectors(app) : []).find((c) => c.slug === connector) ?? null;
  const account = accountToWrite(profile, draft.account);
  return { connector, ...(account ? { event_account: account } : {}) };
}
