/**
 * The silence alert of app triggers. An app trigger with `expect_event_within`
 * expects its App to post at least that often. Every App POST to the trigger
 * stamps `last_event_at` (app-events.ts), deduplicated events included: a
 * watcher posts the same content id while nothing changes. When the stamp (or,
 * before the first event, the time the trigger was written) is older than the
 * window, the trigger's watchers hear it once (`raiseTriggerSilenceAlert`);
 * the App's next event ends it with a recovery notice.
 *
 * Runs on the scheduler leader at most once a minute. Stateless: the alert
 * edge (`alert_failing_since`) is the only state, so a leader change neither
 * loses nor repeats an alert.
 */
import { formatDurationSeconds } from '@kortix/manifest-schema';
import { sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { raiseTriggerSilenceAlert } from './trigger-alerts';

export const APP_TRIGGER_SILENCE_CHECK_EVERY_MS = 60_000;
/** Alerts raised per pass, so one pass after an outage cannot stampede the notifier. */
const SILENCE_CHECK_LIMIT = 200;

// replica-local: only the leader runs the check; a new leader checks once at
// once, which raises nothing twice (the alert edge is in the database).
let lastCheckAt = 0;

interface SilentTrigger {
  project_id: string;
  account_id: string | null;
  slug: string;
  app: string | null;
  window_seconds: number;
  heard_at: Date | string;
}

/** The alert body: what went quiet, for how long, and where to look. Pure. */
export function silenceMessage(trigger: { app: string | null; windowSeconds: number; heardAt: Date }, now: Date): string {
  const silentFor = formatDurationSeconds(Math.max(60, Math.floor((now.getTime() - trigger.heardAt.getTime()) / 60_000) * 60));
  const app = trigger.app ?? 'its App';
  return (
    `App "${app}" sent no event for ${silentFor}; this trigger expects one within ${formatDurationSeconds(trigger.windowSeconds)}. ` +
    `Check the App: kortix apps events ${app}, kortix apps logs ${app}.`
  );
}

/** One pass. Null when it ran less than a minute ago. */
export async function checkAppTriggerSilence(now = new Date(), force = false): Promise<{ checked: number; raised: number } | null> {
  if (!force && now.getTime() - lastCheckAt < APP_TRIGGER_SILENCE_CHECK_EVERY_MS) return null;
  lastCheckAt = now.getTime();
  const result = await db.execute(sql`
    select r.project_id, p.account_id, r.slug, r.schedule_spec->>'app' as app,
           (r.schedule_spec->>'expectEventWithinSeconds')::bigint as window_seconds,
           coalesce(r.last_event_at, r.updated_at) as heard_at
      from kortix.project_trigger_runtime r
      join kortix.projects p on p.project_id = r.project_id and p.status = 'active'
     where r.trigger_type = 'app'
       and r.enabled is not false
       and r.alert_failing_since is null
       -- A trigger whose App was deleted (a session trigger an App delete leaves to its owner) is not a silent App.
       and exists (select 1 from kortix.apps a where a.project_id = r.project_id and a.slug = r.schedule_spec->>'app' and a.deleted_at is null)
       -- Only a whole number of seconds up to 30 days: a stored value the parser
       -- would refuse (an older server, a hand edit) must not fail the whole pass.
       and (r.schedule_spec->>'expectEventWithinSeconds') ~ '^[0-9]{1,7}$'
       and coalesce(r.last_event_at, r.updated_at)
           < ${now.toISOString()}::timestamptz - make_interval(secs => (r.schedule_spec->>'expectEventWithinSeconds')::bigint::double precision)
     limit ${SILENCE_CHECK_LIMIT}
  `);
  const rows = ((result as unknown as { rows?: SilentTrigger[] }).rows ?? (result as unknown as SilentTrigger[]));
  let raised = 0;
  for (const row of rows) {
    const heardAt = row.heard_at instanceof Date ? row.heard_at : new Date(row.heard_at);
    const error = silenceMessage({ app: row.app, windowSeconds: Number(row.window_seconds), heardAt }, now);
    if (await raiseTriggerSilenceAlert({ projectId: row.project_id, slug: row.slug, accountId: row.account_id, error })) raised += 1;
  }
  if (raised > 0) logger.info('[app-trigger-silence] raised silence alerts', { checked: rows.length, raised });
  return { checked: rows.length, raised };
}
