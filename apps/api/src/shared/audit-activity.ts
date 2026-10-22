// Account activity: who was active, where, and how often. The rollup (`kortix.audit_activity_daily`)
// and its reader. Raw `audit_events_all` holds ~100M rows per 90 days; a per-project "who was here"
// over it timed out on prod. The rollup turns that into an index range over a few hundred rows.
import { sql } from 'drizzle-orm';
import { db } from './db';

/** How far back the first run starts: the hot audit window (`HOT_DAYS` in audit-archive/format). */
const BACKFILL_DAYS = 90;
/** One slice of `audit_events_all` per tick: ~70k-250k rows on prod, 1.5-5 s. */
const SLICE_MINUTES = 15;
// ponytail: a row that lands more than LAG after its occurred_at (a sandbox replaying a backlog)
// is never counted. Re-roll a day (delete its rows, move rolled_through back) if that matters.
const LAG_MINUTES = 120;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const rows = <T>(result: unknown): T[] => Array.from(result as Iterable<T>);

/**
 * Add the next closed slice of `audit_events_all` to `audit_activity_daily`. Returns false when the
 * rollup is caught up. Leader-only and serial; the row lock on `audit_activity_rollup` keeps a
 * second caller from adding a slice twice.
 */
export async function rollupNextAuditActivitySlice(): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '60s'`);
    await tx.execute(sql`
      insert into kortix.audit_activity_rollup (id, rolled_through)
      values (1, date_trunc('day', now() - make_interval(days => ${BACKFILL_DAYS}::int)))
      on conflict (id) do nothing`);
    const [state] = rows<{ from: string; to: string; ready: boolean }>(
      await tx.execute(sql`
        select rolled_through as "from",
               rolled_through + make_interval(mins => ${SLICE_MINUTES}::int) as "to",
               rolled_through + make_interval(mins => ${SLICE_MINUTES + LAG_MINUTES}::int) <= now() as ready
        from kortix.audit_activity_rollup where id = 1 for update`),
    );
    if (!state?.ready) return false;
    await tx.execute(sql`
      insert into kortix.audit_activity_daily as d
        (account_id, day, project_id, actor_user_id, actor_type, credential_kind, client,
         events, hours_mask, first_at, last_at)
      select account_id,
             (occurred_at at time zone 'UTC')::date,
             coalesce(project_id, ${NIL_UUID}::uuid),
             actor_user_id,
             coalesce(actor_type, ''),
             coalesce(credential_kind, ''),
             case when user_agent like 'Mozilla/%' then 'browser' else 'program' end,
             count(*)::int,
             bit_or(1 << extract(hour from occurred_at at time zone 'UTC')::int),
             min(occurred_at),
             max(occurred_at)
      from kortix.audit_events_all
      where occurred_at >= ${state.from}::timestamptz
        and occurred_at < ${state.to}::timestamptz
        and account_id is not null
        and actor_user_id is not null
      group by 1, 2, 3, 4, 5, 6, 7
      on conflict (account_id, day, project_id, actor_user_id, actor_type, credential_kind, client)
      do update set events = d.events + excluded.events,
                    hours_mask = d.hours_mask | excluded.hours_mask,
                    first_at = least(d.first_at, excluded.first_at),
                    last_at = greatest(d.last_at, excluded.last_at)`);
    await tx.execute(sql`update kortix.audit_activity_rollup set rolled_through = ${state.to}::timestamptz where id = 1`);
    return true;
  });
}

export interface AuditActivityFilter {
  /** First UTC day, inclusive (YYYY-MM-DD). */
  since: string;
  /** Last UTC day, inclusive (YYYY-MM-DD). */
  until: string;
  projectId?: string | null;
  actor?: string | null;
  client?: 'browser' | 'program' | null;
  actorType?: string | null;
  credentialKind?: string | null;
}

export interface AuditActivityDay {
  day: string;
  events: number;
  active_hours: number;
}

export interface AuditActivityActor {
  actor_user_id: string;
  email: string | null;
  active_days: number;
  active_hours: number;
  events: number;
  first_at: string;
  last_at: string;
  days: AuditActivityDay[];
}

const popcount = (mask: number) => {
  let n = 0;
  for (let m = mask >>> 0; m; m &= m - 1) n++;
  return n;
};

/** Per-actor activity in one account, most active first. Hours are exact distinct UTC hours. */
export async function readAuditActivity(
  accountId: string,
  filter: AuditActivityFilter,
): Promise<{ rolled_through: string | null; actors: AuditActivityActor[] }> {
  const where = [
    sql`d.account_id = ${accountId}::uuid`,
    sql`d.day between ${filter.since}::date and ${filter.until}::date`,
  ];
  if (filter.projectId) where.push(sql`d.project_id = ${filter.projectId}::uuid`);
  if (filter.actor) where.push(sql`d.actor_user_id = ${filter.actor}::uuid`);
  if (filter.client) where.push(sql`d.client = ${filter.client}`);
  if (filter.actorType) where.push(sql`d.actor_type = ${filter.actorType}`);
  if (filter.credentialKind) where.push(sql`d.credential_kind = ${filter.credentialKind}`);

  const dayRows = rows<{
    actor_user_id: string;
    email: string | null;
    day: string;
    events: number;
    hours_mask: number;
    first_at: string;
    last_at: string;
  }>(
    await db.execute(sql`
      select d.actor_user_id, u.email, d.day::text as day, sum(d.events)::int as events,
             bit_or(d.hours_mask) as hours_mask, min(d.first_at) as first_at, max(d.last_at) as last_at
      from kortix.audit_activity_daily d
      left join auth.users u on u.id = d.actor_user_id
      where ${sql.join(where, sql` and `)}
      group by d.actor_user_id, u.email, d.day
      order by d.actor_user_id, d.day`),
  );
  const [state] = rows<{ rolled_through: string }>(
    await db.execute(sql`select rolled_through from kortix.audit_activity_rollup where id = 1`),
  );

  const actors = new Map<string, AuditActivityActor>();
  for (const row of dayRows) {
    const hours = popcount(row.hours_mask);
    const firstAt = new Date(row.first_at).toISOString();
    const lastAt = new Date(row.last_at).toISOString();
    let actor = actors.get(row.actor_user_id);
    if (!actor) {
      actor = {
        actor_user_id: row.actor_user_id,
        email: row.email,
        active_days: 0,
        active_hours: 0,
        events: 0,
        first_at: firstAt,
        last_at: lastAt,
        days: [],
      };
      actors.set(row.actor_user_id, actor);
    }
    actor.active_days++;
    actor.active_hours += hours;
    actor.events += row.events;
    if (firstAt < actor.first_at) actor.first_at = firstAt;
    if (lastAt > actor.last_at) actor.last_at = lastAt;
    actor.days.push({ day: row.day, events: row.events, active_hours: hours });
  }
  return {
    rolled_through: state ? new Date(state.rolled_through).toISOString() : null,
    actors: [...actors.values()].sort((a, b) => b.active_hours - a.active_hours || b.events - a.events),
  };
}
