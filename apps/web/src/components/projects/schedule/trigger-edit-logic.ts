/**
 * The detail sheet's rules, with no React in them. The sheet edits a
 * `ComposerDraft` built from the saved trigger, the same draft the composer
 * edits, and saves one PATCH holding only the fields that changed.
 */

import type {
  ProjectTrigger,
  ProjectTriggerEventType,
  UpdateProjectTriggerInput,
} from '@kortix/sdk';
import { type ModelKey, modelKeyToWire } from '@kortix/sdk/react';

import {
  configToDraft,
  draftToConfig,
  humanizeEventType,
  schemaFields,
} from './event-trigger-copy';
import { conditionsToRows, rowsToConditions, sameConditions } from './schedule-fields';
import type { ComposerDraft } from './trigger-composer-logic';
import { initialDraft } from './trigger-composer-logic';

/** The event type the catalog has no entry for: enough to name it and keep its saved config. */
function stubEventType(event: NonNullable<ProjectTrigger['event']>): ProjectTriggerEventType {
  return {
    type: event.type,
    name: humanizeEventType(event.type),
    description: '',
    app: event.app ?? '',
    delivery: null,
    config_schema: {},
    payload_schema: null,
  };
}

/** The saved trigger as a draft. `eventType` is the catalog entry for an event trigger, when it loaded. */
export function draftFromTrigger(
  trigger: ProjectTrigger,
  saved: { eventType: ProjectTriggerEventType | null; model: ModelKey | null },
): ComposerDraft {
  const event = trigger.event;
  const eventType = event ? (saved.eventType ?? stubEventType(event)) : null;
  return {
    ...initialDraft({ kind: trigger.type as ComposerDraft['kind'], agent: trigger.agent }),
    cron: trigger.cron ?? '0 0 9 * * *',
    runAt: trigger.run_at,
    timezone: trigger.timezone,
    appSlug: event?.app ?? null,
    profile: event?.connector ?? null,
    account: event?.account ?? null,
    eventType,
    configDraft: eventType
      ? configToDraft(schemaFields(eventType.config_schema), event?.config ?? {})
      : {},
    instruction: trigger.prompt_template,
    model: saved.model,
    nameOverride: trigger.name,
    mode: trigger.session_mode,
    pinnedSessionId: trigger.session_id,
    sessionKey: trigger.session_key ?? '',
    conditions: conditionsToRows(trigger.filter),
    secretName: trigger.secret_env ?? '',
    startActive: trigger.enabled,
    sessionAccess: trigger.session_access,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The `session_mode` fields as the API wants them: a mode carries only the value it needs. */
function sessionPatch(draft: ComposerDraft): UpdateProjectTriggerInput {
  if (draft.mode === 'pinned') {
    return { session_mode: 'pinned', session_id: draft.pinnedSessionId, session_key: null };
  }
  if (draft.mode === 'keyed') {
    return { session_mode: 'keyed', session_key: draft.sessionKey.trim(), session_id: null };
  }
  return { session_mode: draft.mode, session_id: null, session_key: null };
}

/**
 * What to PATCH: only the fields that differ between the saved draft and the
 * edited one. Empty when nothing changed, which is also what "dirty" means.
 */
export function triggerPatch(
  saved: ComposerDraft,
  draft: ComposerDraft,
): UpdateProjectTriggerInput {
  const out: UpdateProjectTriggerInput = {};

  const name = (draft.nameOverride ?? '').trim();
  if (name && name !== (saved.nameOverride ?? '').trim()) out.name = name;
  if (draft.instruction !== saved.instruction) out.prompt_template = draft.instruction;
  if (draft.agent && draft.agent !== saved.agent) out.agent = draft.agent;
  if (!same(draft.model, saved.model)) out.model = draft.model ? modelKeyToWire(draft.model) : null;

  if (draft.kind === 'cron') {
    if (
      draft.cron !== saved.cron ||
      draft.runAt !== saved.runAt ||
      draft.timezone !== saved.timezone
    ) {
      // `run_at` and `cron` are mutually exclusive, so switching between them clears the other.
      Object.assign(
        out,
        draft.runAt
          ? { run_at: draft.runAt, cron: null, timezone: draft.timezone }
          : { cron: draft.cron.trim(), run_at: null, timezone: draft.timezone },
      );
    }
  } else if (
    !sameConditions(rowsToConditions(draft.conditions), rowsToConditions(saved.conditions))
  ) {
    out.filter = rowsToConditions(draft.conditions);
  }

  if (draft.kind === 'webhook') {
    const secret = draft.secretName.trim();
    if (secret && secret !== saved.secretName.trim()) out.secret_env = secret;
  }

  if (draft.kind === 'event' && draft.eventType) {
    const eventChanged = draft.eventType.type !== saved.eventType?.type;
    const profileChanged = draft.profile !== saved.profile;
    const config = draftToConfig(schemaFields(draft.eventType.config_schema), draft.configDraft);
    const savedConfig = saved.eventType
      ? draftToConfig(schemaFields(saved.eventType.config_schema), saved.configDraft)
      : {};
    if (profileChanged && draft.profile) out.connector = draft.profile;
    if (eventChanged) out.event = draft.eventType.type;
    // A new connector brings its own accounts, so the account is always named with it.
    if (profileChanged || draft.account !== saved.account) out.event_account = draft.account;
    if (eventChanged || !same(config, savedConfig)) out.event_config = config;
  }

  if (
    draft.mode !== saved.mode ||
    draft.pinnedSessionId !== saved.pinnedSessionId ||
    draft.sessionKey.trim() !== saved.sessionKey.trim()
  ) {
    Object.assign(out, sessionPatch(draft));
  }
  if (!same(draft.sessionAccess, saved.sessionAccess)) out.session_access = draft.sessionAccess;
  return out;
}
