import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from '../__tests__/helpers/pg-client';
import { readAuditActivity, rollupNextAuditActivitySlice } from './audit-activity';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'c4100000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT = 'c4100000-0000-4000-a000-000000000002';
const PROJECT = 'c4100000-0000-4000-a000-0000000000a1';
const PERSON = 'c4100000-0000-4000-a000-0000000000b1';
const SCRIPTED = 'c4100000-0000-4000-a000-0000000000b2';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)';
const MINUTE = 60_000;

let client: PgClient | null = null;
const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) =>
  client!.query<T>(text, values);

// Three hours ago, on the hour: the first slices are closed and past the 2 h lag.
const start = new Date(Math.floor((Date.now() - 3 * 60 * MINUTE) / (60 * MINUTE)) * 60 * MINUTE);
const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE).toISOString();
const day = start.toISOString().slice(0, 10);

async function event(actor: string | null, minutes: number, userAgent: string, extra: { account?: string; project?: string | null } = {}) {
  await q(
    `INSERT INTO kortix.audit_events(account_id, project_id, actor_user_id, actor_type, credential_kind,
       action, resource_type, authoritative_source, user_agent, occurred_at)
     VALUES ($1, $2, $3, 'human', $4, 'session.read', 'session', 'human', $5, $6)`,
    [extra.account ?? ACCOUNT, extra.project === undefined ? PROJECT : extra.project, actor,
     userAgent === BROWSER ? 'browser_session' : 'personal_access_token', userAgent, at(minutes)],
  );
}

describe.skipIf(!databaseUrl)('audit activity rollup — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new PgClient({ connectionString: databaseUrl });
    await client.connect();
    await q(`INSERT INTO auth.users (id, email) VALUES ($1, 'person@example.test') ON CONFLICT (id) DO NOTHING`, [PERSON]);
    await q(
      `INSERT INTO kortix.audit_activity_rollup (id, rolled_through) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET rolled_through = excluded.rolled_through`,
      [start.toISOString()],
    );
    // Slice 1 [0, 15): the person twice in a browser, a script acting as the same person, a
    // script as another user, a row outside any project, one row of another account, one row with
    // no actor. Slice 2 [15, 30): the person again in the same hour. Slice 5 [60, 75): next hour.
    await event(PERSON, 1, BROWSER);
    await event(PERSON, 2, BROWSER);
    await event(PERSON, 3, 'Bun/1.3.11');
    await event(SCRIPTED, 4, 'curl/8.5.0');
    await event(PERSON, 5, BROWSER, { project: null });
    await event(PERSON, 6, BROWSER, { account: OTHER_ACCOUNT });
    await event(null, 7, BROWSER);
    await event(PERSON, 20, BROWSER);
    await event(PERSON, 61, BROWSER);
  });

  afterAll(async () => {
    if (!client) return;
    await q("SET kortix.audit_maintenance = 'on'");
    await q('DELETE FROM kortix.audit_events WHERE account_id = ANY($1::uuid[])', [[ACCOUNT, OTHER_ACCOUNT]]);
    await q('DELETE FROM kortix.audit_activity_daily WHERE account_id = ANY($1::uuid[])', [[ACCOUNT, OTHER_ACCOUNT]]);
    await q('DELETE FROM auth.users WHERE id = $1', [PERSON]);
    await client.end();
  });

  test('rolls closed 15-minute slices, adds slices of one hour together, and stops at the lag', async () => {
    let slices = 0;
    while (await rollupNextAuditActivitySlice()) slices++;
    // [start, now - 2 h] in 15-minute steps: 4 slices for the first hour, at least 1 more.
    expect(slices).toBeGreaterThanOrEqual(4);
    const { rows: state } = await q<{ rolled_through: Date }>('SELECT rolled_through FROM kortix.audit_activity_rollup');
    expect(state[0]!.rolled_through.getTime()).toBeLessThanOrEqual(Date.now() - 2 * 60 * MINUTE);

    const { rows } = await q<{ actor_user_id: string; project_id: string; client: string; events: number; hours_mask: number }>(
      `SELECT actor_user_id, project_id, client, events, hours_mask FROM kortix.audit_activity_daily
        WHERE account_id = $1 AND day = $2::date ORDER BY actor_user_id, project_id, client`,
      [ACCOUNT, day],
    );
    const hour = start.getUTCHours();
    const bits = (...hours: number[]) => hours.reduce((m, h) => m | (1 << (h % 24)), 0);
    const nextHourSameDay = new Date(start.getTime() + 60 * MINUTE).toISOString().slice(0, 10) === day;
    expect(rows).toEqual([
      { actor_user_id: PERSON, project_id: '00000000-0000-0000-0000-000000000000', client: 'browser', events: 1, hours_mask: bits(hour) },
      {
        actor_user_id: PERSON,
        project_id: PROJECT,
        client: 'browser',
        // 1 + 2 + 20 in the first hour; 61 lands on this row only when the next hour is the same UTC day.
        events: nextHourSameDay ? 4 : 3,
        hours_mask: nextHourSameDay ? bits(hour, hour + 1) : bits(hour),
      },
      { actor_user_id: PERSON, project_id: PROJECT, client: 'program', events: 1, hours_mask: bits(hour) },
      { actor_user_id: SCRIPTED, project_id: PROJECT, client: 'program', events: 1, hours_mask: bits(hour) },
    ]);
  });

  test('reads per-actor activity with exact distinct hours, filtered by project and client', async () => {
    const all = await readAuditActivity(ACCOUNT, { since: day, until: day });
    const person = all.actors.find((a) => a.actor_user_id === PERSON)!;
    const nextHourSameDay = new Date(start.getTime() + 60 * MINUTE).toISOString().slice(0, 10) === day;
    expect(person.email).toBe('person@example.test');
    expect(person.active_days).toBe(1);
    // The browser, program and no-project rows of one hour count once.
    expect(person.active_hours).toBe(nextHourSameDay ? 2 : 1);
    expect(person.events).toBe(nextHourSameDay ? 6 : 5);
    expect(person.first_at).toBe(at(1));
    expect(all.actors.map((a) => a.actor_user_id)).toEqual([PERSON, SCRIPTED]);
    expect(all.rolled_through).not.toBeNull();

    const browserInProject = await readAuditActivity(ACCOUNT, { since: day, until: day, projectId: PROJECT, client: 'browser' });
    expect(browserInProject.actors.map((a) => [a.actor_user_id, a.events])).toEqual([[PERSON, nextHourSameDay ? 4 : 3]]);

    const otherAccount = await readAuditActivity(OTHER_ACCOUNT, { since: day, until: day });
    expect(otherAccount.actors.map((a) => [a.actor_user_id, a.events])).toEqual([[PERSON, 1]]);
  });
});
