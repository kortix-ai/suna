/**
 * Notifications (spec §4 "Notifications"). PUSH-1/PUSH-2: mobile push device
 * tokens. NOTIF-1..8 (KRTX-1742): the inbox, preferences, Web Push, session
 * watch, and who a session event, a share and a failing trigger reach.
 *
 * Every NOTIF flow notifies only fresh run-scoped users with no device token
 * and no Web Push subscription, so no push leaves the target. A delivery runs
 * after the request that caused it answers: a flow polls the bell for the
 * positive row, then lets that same delivery settle before it asserts an
 * absence.
 */
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { flow } from '../core/flow';
import { sleep, waitFor } from '../core/poll';
import type { FlowContext, Principal } from '../core/types';
import { createDatabaseSession } from '../fixtures/database-project';
import { mailpitMessagesTo, waitForMailpit } from '../fixtures/mailpit';
import { PASSWORD } from '../fixtures/principals';
import { openFlowDb, seedTurnSession } from '../fixtures/turn-end';

flow(
  'PUSH-1',
  {
    domain: 'notifications',
    tags: ['smoke'],
    routes: ['POST /v1/notifications/device-token', 'DELETE /v1/notifications/device-token/:token'],
  },
  async (ctx) => {
    // Brackets and a slash: the mobile client URL-encodes the token in the path.
    const token = `ExponentPushToken[${ctx.fixtures.name('push')}/a+b]`;
    const register = { device_token: token, device_type: 'ios', provider: 'expo' };
    const del = (who: typeof ctx.P.OWNER) =>
      ctx.client.as(who).del('/v1/notifications/device-token/:token', { params: { token } });

    try {
      await ctx.step('ANON cannot register a device token → 401', async () => {
        const r = await ctx.client.as(ctx.P.ANON).post('/v1/notifications/device-token', register);
        r.status(401);
      });

      await ctx.step('OWNER registers the token with the body the mobile app sends → 200', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', register);
        r.status(200).body().has('$.success', true).exists('$.message');
      });

      await ctx.step('OWNER re-registers the same token with preferences → 200 (upsert, no conflict)', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', {
          ...register,
          preferences: {
            enabled: true,
            on_completion: true,
            on_error: false,
            on_question: true,
            on_permission: true,
            play_sound: false,
          },
        });
        r.status(200).body().has('$.success', true);
      });

      await ctx.step('an invalid body is rejected → 400 for each malformed field', async () => {
        const bad = [
          { ...register, device_token: '' },
          { ...register, device_token: 'x'.repeat(513) },
          { ...register, device_type: 'web' },
          { ...register, provider: 'fcm' },
          { ...register, preferences: { enabled: 'yes' } },
        ];
        for (const body of bad) {
          const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', body);
          r.status(400);
        }
      });

      await ctx.step("NONMEMBER deleting OWNER's token → 200 with deleted=false; the token survives", async () => {
        const r = await del(ctx.P.NONMEMBER);
        r.status(200).body().has('$.success', true).has('$.deleted', false);
      });

      await ctx.step('OWNER deletes the URL-encoded token → 200 with deleted=true (proves it survived)', async () => {
        const r = await del(ctx.P.OWNER);
        r.status(200).body().has('$.success', true).has('$.deleted', true);
      });

      await ctx.step('a repeated delete is idempotent → 200 with deleted=false', async () => {
        const r = await del(ctx.P.OWNER);
        r.status(200).body().has('$.success', true).has('$.deleted', false);
      });

      await ctx.step('NONMEMBER registers the same token → it moves to NONMEMBER', async () => {
        await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', register).then((r) => r.status(200));
        const r = await ctx.client.as(ctx.P.NONMEMBER).post('/v1/notifications/device-token', register);
        r.status(200);
        const ownerDelete = await del(ctx.P.OWNER);
        ownerDelete.status(200).body().has('$.deleted', false);
        const nonmemberDelete = await del(ctx.P.NONMEMBER);
        nonmemberDelete.status(200).body().has('$.deleted', true);
      });

      await ctx.step('ANON cannot delete a device token → 401', async () => {
        const r = await del(ctx.P.ANON);
        r.status(401);
      });
    } finally {
      // Cleanup: whichever principal still owns the token removes it.
      await del(ctx.P.OWNER).catch(() => undefined);
      await del(ctx.P.NONMEMBER).catch(() => undefined);
    }
  },
);

// KRTX-1722: a phone signed out from Settings > Security kept its push token,
// so its lock screen kept showing session titles and agent questions. A
// device sign-out now drops the token that sign-in registered, and only it.
flow(
  'PUSH-2',
  {
    domain: 'notifications',
    routes: [
      'POST /v1/notifications/device-token',
      'DELETE /v1/notifications/device-token/:token',
      'GET /v1/accounts/me/devices',
      'DELETE /v1/accounts/me/devices/:sessionId',
    ],
  },
  async (ctx) => {
    const here = await ctx.fixtures.user({ label: 'PUSHSIGNOUT' });
    const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
    const phoneToken = `ExponentPushToken[${ctx.fixtures.name('push-phone')}]`;
    const ownToken = `ExponentPushToken[${ctx.fixtures.name('push-own')}]`;
    const del = (token: string) =>
      ctx.client.as(here).del('/v1/notifications/device-token/:token', { params: { token } });
    const phone = { access: '', id: '' };

    try {
      await ctx.step('a second sign-in (the phone) registers its push token; the caller registers its own', async () => {
        const signIn = await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', {
          email: here.email,
          password: PASSWORD,
        });
        signIn.status(200);
        phone.access = signIn.json<any>().session.access_token;
        const devices = await ctx.client.as(here).get('/v1/accounts/me/devices');
        devices.status(200);
        phone.id = (devices.json<any>().devices as Array<{ session_id: string; current: boolean }>).find(
          (d) => !d.current,
        )!.session_id;
        const register = (device_token: string) => ({ device_token, device_type: 'ios', provider: 'expo' });
        (await ctx.client.as(ctx.P.ANON).post('/v1/notifications/device-token', register(phoneToken), bearer(phone.access)))
          .status(200)
          .body()
          .has('$.success', true);
        (await ctx.client.as(here).post('/v1/notifications/device-token', register(ownToken))).status(200);
      });

      await ctx.step("signing the phone out drops the phone's token: a delete finds nothing (deleted=false)", async () => {
        (await ctx.client.as(here).del(`/v1/accounts/me/devices/${phone.id}`)).status(200).body().has('$.ok', true);
        (await del(phoneToken)).status(200).body().has('$.deleted', false);
      });

      await ctx.step("the caller's own token survives the phone's sign-out (deleted=true)", async () => {
        (await del(ownToken)).status(200).body().has('$.deleted', true);
      });
    } finally {
      await del(phoneToken).catch(() => undefined);
      await del(ownToken).catch(() => undefined);
    }
  },
);

// ── KRTX-1742: notify the right person on any surface ──────────────────────

interface InboxRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  project_id: string | null;
  project_name: string | null;
  session_id: string | null;
  trigger_slug: string | null;
  actor_user_id: string | null;
  url: string;
  read: boolean;
  created_at: string;
}
interface InboxPage {
  notifications: InboxRow[];
  unread_count: number;
  next_before: string | null;
}

async function readInbox(ctx: FlowContext, who: Principal, query: Record<string, string | number> = {}): Promise<InboxPage> {
  const r = await ctx.client.as(who).get('/v1/notifications', { query: { limit: 50, ...query } });
  return r.status(200).json<InboxPage>();
}

/** Polls `who`'s bell until `count` rows match, then requires exactly that many. */
async function waitForInbox(ctx: FlowContext, who: Principal, match: (row: InboxRow) => boolean, count = 1): Promise<InboxRow[]> {
  const page = await waitFor(() => readInbox(ctx, who), {
    until: (p) => p.notifications.filter(match).length >= count,
    timeoutMs: 15_000,
    intervalMs: 300,
    description: `${count} notification(s) for ${who.label}`,
  });
  const rows = page.notifications.filter(match);
  if (rows.length !== count) throw new Error(`${who.label}: expected ${count} matching notification(s), got ${JSON.stringify(rows)}`);
  return rows;
}

/** The delivery that wrote the positive row has finished writing its others too. */
const settle = () => sleep(1_500);

/** Rows stored for `userId`, whatever the bell's access filter would show. */
async function storedCount(db: PgClient, userId: string, scope: { sessionId?: string; projectId?: string; kind?: string }): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM kortix.notifications
      WHERE user_id = $1 AND ($2::text IS NULL OR session_id = $2)
        AND ($3::uuid IS NULL OR project_id = $3) AND ($4::text IS NULL OR kind = $4)`,
    [userId, scope.sessionId ?? null, scope.projectId ?? null, scope.kind ?? null],
  );
  return r.rows[0].n as number;
}

function expectCount(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

/** A team project, its creator A and a second member B, both able to open project sessions. */
async function teamWithTwoMembers(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project();
  const a = await team.addMember('member');
  const b = await team.addMember('member');
  await team.grantProjectRole(project.id, a.userId!, 'member');
  await team.grantProjectRole(project.id, b.userId!, 'member');
  return { team, project, a, b };
}

const watchRoute = '/v1/projects/:projectId/sessions/:sessionId/watch';

// NOTIF-1 — the inbox and the preferences routes, read and written by one person.
flow(
  'NOTIF-1',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: [
      'GET /v1/notifications',
      'POST /v1/notifications/read',
      'GET /v1/notifications/preferences',
      'PUT /v1/notifications/preferences',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const reader = await team.addMember('member');
    const other = await team.addMember('member');
    await team.grantProjectRole(project.id, reader.userId!, 'member');
    const seedSession = (visibility: 'private' | 'project', metadata: Record<string, unknown>) =>
      createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility, metadata });
    const [titled, plain, hidden] = [
      await seedSession('project', { name: 'Quarterly report' }),
      await seedSession('project', {}),
      await seedSession('private', { name: 'Owner only' }),
    ];
    const db = await openFlowDb(ctx.env);
    const seedRow = async (sessionId: string, kind: string, title: string) => {
      const r = await db.query(
        `INSERT INTO kortix.notifications (user_id, account_id, project_id, session_id, kind, title, body)
         VALUES ($1, $2, $3, $4, $5, $6, '') RETURNING notification_id`,
        [reader.userId, team.id, project.id, sessionId, kind, title],
      );
      await sleep(5); // ids are uuid_v7: one millisecond apart keeps their order
      return r.rows[0].notification_id as string;
    };
    const asReader = ctx.client.as(reader);
    const read = (body: unknown, who = asReader) => who.post('/v1/notifications/read', body);
    try {
      // Oldest first. The reader cannot open `hidden` (another person's private session).
      const rHidden = await seedRow(hidden, 'turn_done', 'Owner only');
      const r1 = await seedRow(titled, 'turn_done', 'Stale title');
      const r2 = await seedRow(titled, 'question', 'Stale title');
      const r3 = await seedRow(plain, 'shared', 'Shared plan');

      await ctx.step('ANON reads the inbox → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/notifications')).status(401);
      });

      await ctx.step('the reader lists the rows newest first; a row of a session they cannot open is left out and not counted', async () => {
        const page = await readInbox(ctx, reader);
        const ids = page.notifications.map((row) => row.id);
        if (JSON.stringify(ids) !== JSON.stringify([r3, r2, r1])) throw new Error(`order ${JSON.stringify(ids)}`);
        expectCount(page.unread_count, 3, 'unread_count');
        if (ids.includes(rHidden)) throw new Error('a row of an unopenable session is listed');
      });

      await ctx.step('a row carries the live session title, the project name, and a url that opens the session and marks it read', async () => {
        const row = (await readInbox(ctx, reader)).notifications.find((n) => n.id === r1)!;
        const want = {
          kind: 'turn_done',
          title: 'Quarterly report',
          project_id: project.id,
          project_name: project.name,
          session_id: titled,
          trigger_slug: null,
          url: `/projects/${project.id}/sessions/${titled}?notification=${r1}`,
          read: false,
        };
        for (const [key, value] of Object.entries(want)) {
          if ((row as unknown as Record<string, unknown>)[key] !== value) throw new Error(`${key}: ${JSON.stringify(row)}`);
        }
        if (Number.isNaN(Date.parse(row.created_at))) throw new Error(`created_at ${row.created_at}`);
        const shared = (await readInbox(ctx, reader)).notifications.find((n) => n.id === r3)!;
        if (shared.title !== 'Shared plan') throw new Error(`a session without a name keeps the stored title: ${shared.title}`);
      });

      await ctx.step('limit=2 returns two rows and next_before; before=next_before returns the next page', async () => {
        const first = await readInbox(ctx, reader, { limit: 2 });
        if (JSON.stringify(first.notifications.map((n) => n.id)) !== JSON.stringify([r3, r2]) || first.next_before !== r2) {
          throw new Error(`first page ${JSON.stringify(first)}`);
        }
        const second = await readInbox(ctx, reader, { limit: 2, before: first.next_before! });
        if (JSON.stringify(second.notifications.map((n) => n.id)) !== JSON.stringify([r1])) throw new Error(`second page ${JSON.stringify(second)}`);
      });

      await ctx.step('limit 0, limit 51, or a before that is not an id → 400', async () => {
        for (const query of [{ limit: 0 }, { limit: 51 }, { before: 'not-an-id' }]) {
          (await asReader.get('/v1/notifications', { query })).status(400);
        }
      });

      await ctx.step('marking one id read → updated 1, unread_count 2; the row reads read:true', async () => {
        (await read({ ids: [r1] })).status(200).body().has('$.updated', 1).has('$.unread_count', 2);
        if (!(await readInbox(ctx, reader)).notifications.find((n) => n.id === r1)?.read) throw new Error('r1 not read');
      });

      await ctx.step("another member marks the reader's row by id → updated 0; the row stays unread", async () => {
        (await read({ ids: [r2] }, ctx.client.as(other))).status(200).body().has('$.updated', 0);
        const page = await readInbox(ctx, reader);
        if (page.notifications.find((n) => n.id === r2)?.read !== false) throw new Error('r2 was marked read by another user');
        expectCount(page.unread_count, 2, 'unread_count after the foreign mark');
      });

      await ctx.step("session_id marks only that session's unread rows → updated 1, unread_count 1", async () => {
        (await read({ session_id: titled })).status(200).body().has('$.updated', 1).has('$.unread_count', 1);
        if ((await readInbox(ctx, reader)).notifications.find((n) => n.id === r3)?.read !== false) throw new Error('r3 changed');
      });

      await ctx.step('all:true marks every unread row of the reader → unread_count 0; a repeat → updated 0', async () => {
        // The hidden row is still the reader's own: `all` marks it too.
        (await read({ all: true })).status(200).body().has('$.updated', 2).has('$.unread_count', 0);
        (await read({ all: true })).status(200).body().has('$.updated', 0).has('$.unread_count', 0);
      });

      await ctx.step('a body with no target, two targets, or a malformed one → 400', async () => {
        for (const body of [{}, { ids: [r1], all: true }, { ids: [] }, { ids: ['not-an-id'] }, { all: false }, { session_id: '' }, { ids: [r1], extra: 1 }]) {
          (await read(body)).status(400);
        }
        (await read({ all: true }, ctx.client.as(ctx.P.ANON))).status(401);
      });

      await ctx.step('GET preferences → the documented defaults for all seven kinds, and email_available', async () => {
        const r = await asReader.get('/v1/notifications/preferences');
        r.status(200);
        const prefs = r.json<{ kinds: Record<string, { push: boolean; email: boolean }>; email_available: unknown }>();
        const defaults = {
          turn_done: { push: true, email: false },
          turn_error: { push: true, email: true },
          question: { push: true, email: true },
          permission: { push: true, email: false },
          shared: { push: true, email: true },
          automation_failed: { push: true, email: true },
          automation_recovered: { push: true, email: false },
        };
        if (JSON.stringify(prefs.kinds) !== JSON.stringify(defaults)) throw new Error(`defaults ${JSON.stringify(prefs.kinds)}`);
        if (typeof prefs.email_available !== 'boolean') throw new Error(`email_available ${prefs.email_available}`);
      });

      await ctx.step('PUT turn_done push:false changes only that switch; a later PUT of its email keeps push off', async () => {
        const kinds = async (body: unknown) => {
          const r = await asReader.put('/v1/notifications/preferences', body);
          r.status(200).body().exists('$.email_available');
          return r.json<{ kinds: Record<string, { push: boolean; email: boolean }> }>().kinds;
        };
        const off = await kinds({ kinds: { turn_done: { push: false } } });
        if (off.turn_done.push !== false || off.turn_done.email !== false || off.question.push !== true) throw new Error(JSON.stringify(off));
        const both = await kinds({ kinds: { turn_done: { email: true } } });
        if (both.turn_done.push !== false || both.turn_done.email !== true) throw new Error(`merge lost push: ${JSON.stringify(both.turn_done)}`);
        const back = (await asReader.get('/v1/notifications/preferences')).status(200).json<{ kinds: Record<string, { push: boolean; email: boolean }> }>();
        if (back.kinds.turn_done.push !== false || back.kinds.turn_done.email !== true) throw new Error(`read-back ${JSON.stringify(back.kinds.turn_done)}`);
      });

      await ctx.step('PUT with an unknown kind, a non-boolean, an unknown channel, or no kinds → 400; ANON → 401', async () => {
        for (const body of [
          { kinds: { turn_finished: { push: false } } },
          { kinds: { turn_done: { push: 'no' } } },
          { kinds: { turn_done: { sms: true } } },
          {},
        ]) {
          (await asReader.put('/v1/notifications/preferences', body)).status(400);
        }
        (await ctx.client.as(ctx.P.ANON).get('/v1/notifications/preferences')).status(401);
      });
    } finally {
      await db.query('DELETE FROM kortix.notifications WHERE user_id = $1', [reader.userId]).catch(() => {});
      await db.query('DELETE FROM kortix.notification_preferences WHERE user_id = $1', [reader.userId]).catch(() => {});
      await db.query('DELETE FROM kortix.project_sessions WHERE session_id = ANY($1)', [[titled, plain, hidden]]).catch(() => {});
      await db.end();
    }
  },
);

// NOTIF-2 — a turn end reaches the person who prompted it and the session's
// watchers (acceptance 1), and never a watcher who muted it (acceptance 4).
flow(
  'NOTIF-2',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'POST /v1/projects/:projectId/turn-stream',
      'PUT /v1/projects/:projectId/sessions/:sessionId/watch',
      'GET /v1/notifications',
    ],
  },
  async (ctx) => {
    const { team, project, a, b } = await teamWithTwoMembers(ctx);
    const db = await openFlowDb(ctx.env);
    const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: a }).catch(async (error) => {
      await db.end();
      throw error;
    });
    const sessionId = turn.sessionId;
    const turnDone = (row: InboxRow) => row.session_id === sessionId && row.kind === 'turn_done';
    try {
      await ctx.step("B's prompted turn in A's session ends: the relay closes it and promotes nothing", async () => {
        await turn.startTurn('msg_notif2_first', b.userId!);
        await turn.endTurn('msg_notif2_first');
      });

      await ctx.step('B, the prompter, gets one unread turn_done row titled with the session name', async () => {
        const [row] = await waitForInbox(ctx, b, turnDone);
        if (row.title !== 'Refactor the billing page' || row.read || row.actor_user_id !== b.userId) throw new Error(JSON.stringify(row));
      });

      await ctx.step('A, the creator, watches the session: one turn_done row that names B as the prompter', async () => {
        const [row] = await waitForInbox(ctx, a, turnDone);
        if (row.actor_user_id !== b.userId) throw new Error(JSON.stringify(row));
      });

      await ctx.step('A mutes the session → 200 watching:false', async () => {
        (await ctx.client.as(a).put(watchRoute, { watching: false }, { params: { projectId: project.id, sessionId } }))
          .status(200)
          .body()
          .has('$.watching', false);
      });

      await ctx.step("B's next turn ends: B gets a second row; muted A gets none", async () => {
        await turn.startTurn('msg_notif2_second', b.userId!);
        await turn.endTurn('msg_notif2_second');
        await waitForInbox(ctx, b, turnDone, 2);
        await settle();
        expectCount(await storedCount(db, a.userId!, { sessionId }), 1, "muted A's rows for the session");
      });
    } finally {
      await turn.cleanup();
      await db.end();
    }
  },
);

// NOTIF-3 — "shared with you" for each account member a share newly names
// (acceptance 5), at most once per person, session and UTC day.
flow(
  'NOTIF-3',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: ['PUT /v1/projects/:projectId/sessions/:sessionId/sharing', 'GET /v1/notifications'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const c = await team.addMember('member');
    await team.grantProjectRole(project.id, c.userId!, 'member');
    const outsider = ctx.P.NONMEMBER;
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
      metadata: { name: 'Launch checklist' },
    });
    const params = { projectId: project.id, sessionId };
    const share = (body: unknown) => ctx.client.as(ctx.P.OWNER).put('/v1/projects/:projectId/sessions/:sessionId/sharing', body, { params });
    const sharedRow = (row: InboxRow) => row.session_id === sessionId && row.kind === 'shared';
    const db = await openFlowDb(ctx.env);
    try {
      await ctx.step('OWNER shares the private session with C and with a user outside the account → 200', async () => {
        (await share({ mode: 'members', memberIds: [c.userId, outsider.userId] })).status(200);
      });

      await ctx.step('C gets one shared row naming OWNER as the sharer', async () => {
        const [row] = await waitForInbox(ctx, c, sharedRow);
        if (row.actor_user_id !== ctx.P.OWNER.userId || !row.body.endsWith('shared a session with you') || row.title !== 'Launch checklist') {
          throw new Error(JSON.stringify(row));
        }
      });

      await ctx.step('the user outside the account and the sharer get no row', async () => {
        await settle();
        expectCount(await storedCount(db, outsider.userId!, { sessionId }), 0, "the outsider's rows");
        expectCount(await storedCount(db, ctx.P.OWNER.userId!, { sessionId }), 0, "the sharer's rows");
      });

      await ctx.step('OWNER unshares, then shares with C again the same day → 200; C still has exactly one shared row', async () => {
        (await share({ mode: 'private' })).status(200);
        (await share({ mode: 'members', memberIds: [c.userId] })).status(200);
        await settle();
        expectCount(await storedCount(db, c.userId!, { sessionId, kind: 'shared' }), 1, "C's shared rows after a re-share");
      });
    } finally {
      await db.query('DELETE FROM kortix.notifications WHERE session_id = $1', [sessionId]).catch(() => {});
      await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]).catch(() => {});
      await db.end();
    }
  },
);

// NOTIF-4 — a browser registers for Web Push. The subscriber is a fresh user
// who is never notified, so nothing is ever sent to the push service.
flow(
  'NOTIF-4',
  {
    domain: 'notifications',
    routes: [
      'GET /v1/notifications/web-push/key',
      'POST /v1/notifications/web-push/subscriptions',
      'DELETE /v1/notifications/web-push/subscriptions',
    ],
  },
  async (ctx) => {
    const browser = await ctx.fixtures.user({ label: 'WEBPUSH' });
    const asBrowser = ctx.client.as(browser);
    const endpoint = `https://fcm.googleapis.com/fcm/send/ke2e-${randomUUID()}`;
    const keys = {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
    const subscribe = (body: unknown, who = asBrowser) => who.post('/v1/notifications/web-push/subscriptions', body);
    const unsubscribe = (who = asBrowser) => who.del('/v1/notifications/web-push/subscriptions', { query: { endpoint } });
    try {
      await ctx.step('ANON cannot read the key or subscribe → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/notifications/web-push/key')).status(401);
        (await subscribe({ endpoint, keys }, ctx.client.as(ctx.P.ANON))).status(401);
      });

      await ctx.step('the public key is a 65-byte uncompressed P-256 point, the same on every read', async () => {
        const first = (await asBrowser.get('/v1/notifications/web-push/key')).status(200).json<{ public_key: string }>().public_key;
        const point = Buffer.from(first, 'base64url');
        if (point.length !== 65 || point[0] !== 4) throw new Error(`public_key decodes to ${point.length} bytes`);
        const again = (await asBrowser.get('/v1/notifications/web-push/key')).status(200).json<{ public_key: string }>().public_key;
        if (again !== first) throw new Error('the key changed between reads');
      });

      await ctx.step('the browser sign-in subscribes an endpoint on a known push service → 200 ok', async () => {
        (await subscribe({ endpoint, keys })).status(200).body().has('$.ok', true);
      });

      await ctx.step('a personal access token is not a browser → 403', async () => {
        (await subscribe({ endpoint, keys }, ctx.client.as(ctx.P.PAT_ACCT))).status(403);
      });

      await ctx.step('an IP, an internal host, or a look-alike host → 400 unsupported_push_service', async () => {
        for (const bad of [
          'https://127.0.0.1/push',
          'https://169.254.169.254/latest/meta-data',
          'https://kortix-api.internal/push',
          'https://fcm.googleapis.com.evil.test/push',
        ]) {
          (await subscribe({ endpoint: bad, keys })).status(400).body().has('$.code', 'unsupported_push_service');
        }
      });

      await ctx.step('plain http, a port, userinfo → 400 invalid_endpoint; a short key → 400 invalid_keys', async () => {
        for (const bad of ['http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/fcm/send/x', 'https://user@fcm.googleapis.com/fcm/send/x']) {
          (await subscribe({ endpoint: bad, keys })).status(400).body().has('$.code', 'invalid_endpoint');
        }
        const shortKey = { p256dh: randomBytes(64).toString('base64url'), auth: keys.auth };
        (await subscribe({ endpoint, keys: shortKey })).status(400).body().has('$.code', 'invalid_keys');
      });

      await ctx.step('another user cannot delete it (deleted:false); the subscriber deletes it (true); a repeat → false', async () => {
        (await unsubscribe(ctx.client.as(ctx.P.NONMEMBER))).status(200).body().has('$.deleted', false);
        (await unsubscribe()).status(200).body().has('$.deleted', true);
        (await unsubscribe()).status(200).body().has('$.deleted', false);
      });
    } finally {
      await unsubscribe().catch(() => undefined);
    }
  },
);

// NOTIF-5 — a trigger that starts failing alerts the person who created it,
// once per failure streak, with an email at once (acceptance 7, 8).
flow(
  'NOTIF-5',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'GET /v1/notifications',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const db = await openFlowDb(ctx.env);
    try {
      // BILL-17: a paid tier with no credit left fails every fire before a sandbox, on every target.
      await db.query(
        `INSERT INTO kortix.credit_accounts
           (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
         VALUES ($1, 0, 0, 0, 0, 'tier_2_20')
         ON CONFLICT (account_id) DO UPDATE SET
           balance = 0, balance_precise = 0, non_expiring_credits = 0, non_expiring_credits_precise = 0,
           expiring_credits = 0, expiring_credits_precise = 0, tier = 'tier_2_20'`,
        [team.id],
      );
      const project = await team.project({ managedGit: true });
      const creator = await team.addMember('member');
      await team.grantProjectRole(project.id, creator.userId!, 'manager');
      const slug = 'notif-digest';
      const name = `Nightly digest ${randomUUID().slice(0, 8)}`;
      const params = { projectId: project.id };
      const fire = () => ctx.client.as(creator).post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug } });
      const alert = (row: InboxRow) => row.kind === 'automation_failed' && row.project_id === project.id && row.trigger_slug === slug;

      await ctx.step('a project manager creates a cron trigger → 201, and follows its alerts', async () => {
        const created = await ctx.client.as(creator).post(
          '/v1/projects/:projectId/triggers',
          { name, slug, type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'Summarize the day.' },
          { params },
        );
        created.status(201);
        const watcher = await db.query(
          'SELECT muted FROM kortix.trigger_watchers WHERE project_id = $1 AND slug = $2 AND user_id = $3',
          [project.id, slug, creator.userId],
        );
        if (watcher.rows[0]?.muted !== false) throw new Error(`creator watcher row: ${JSON.stringify(watcher.rows)}`);
      });

      await ctx.step('a manual fire on the account with no credit fails → 500', async () => {
        (await fire()).status(500);
      });

      await ctx.step('the creator gets exactly one automation_failed row titled with the trigger; OWNER gets none', async () => {
        const [row] = await waitForInbox(ctx, creator, alert);
        if (row.title !== name || row.session_id !== null || row.url !== `/projects/${project.id}/customize/triggers?notification=${row.id}`) {
          throw new Error(JSON.stringify(row));
        }
        await settle();
        expectCount(await storedCount(db, ctx.P.OWNER.userId!, { projectId: project.id }), 0, "OWNER's rows for the project");
      });

      await ctx.step('the alert is emailed at once: one email to the creator, none to OWNER', async () => {
        const stamped = await db.query(
          `SELECT emailed_at FROM kortix.notifications WHERE user_id = $1 AND project_id = $2 AND kind = 'automation_failed'`,
          [creator.userId, project.id],
        );
        if (!stamped.rows[0]?.emailed_at) throw new Error(`emailed_at not stamped: ${JSON.stringify(stamped.rows)}`);
        const mailpit = ctx.env.mailpitUrl;
        if (!mailpit) return; // a target without Mailpit proves the send by the stamp alone
        const subject = (message: { Subject: string }) => message.Subject === `Automation failing: ${name}`;
        await waitForMailpit(mailpit, creator.email!, (messages) => messages.some(subject));
        expectCount((await mailpitMessagesTo(mailpit, creator.email!)).filter(subject).length, 1, "the creator's alert emails");
        expectCount((await mailpitMessagesTo(mailpit, ctx.P.OWNER.email!)).filter(subject).length, 0, "OWNER's alert emails");
      });

      await ctx.step('a second failed fire → 500, and still exactly one row: one alert per failure streak', async () => {
        (await fire()).status(500);
        await settle();
        expectCount(await storedCount(db, creator.userId!, { projectId: project.id, kind: 'automation_failed' }), 1, "the creator's alert rows");
      });
    } finally {
      await db.end();
    }
  },
);

// NOTIF-6 — a Slack- or email-origin session answers in its thread: a turn end
// leaves the prompter a bell row and its creator nothing (acceptance 6).
flow(
  'NOTIF-6',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: ['POST /v1/accounts/tokens', 'POST /v1/projects/:projectId/turn-stream', 'GET /v1/notifications'],
  },
  async (ctx) => {
    const { team, project, a, b } = await teamWithTwoMembers(ctx);
    const db = await openFlowDb(ctx.env);
    const endTurnFrom = async (source: string) => {
      const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: a, metadata: { source } });
      try {
        await turn.startTurn(`msg_notif6_${source}`, b.userId!);
        await turn.endTurn(`msg_notif6_${source}`);
        await waitForInbox(ctx, b, (row) => row.session_id === turn.sessionId && row.kind === 'turn_done');
        await settle();
        return await storedCount(db, a.userId!, { sessionId: turn.sessionId });
      } finally {
        await turn.cleanup();
      }
    };
    try {
      for (const source of ['slack', 'email']) {
        await ctx.step(`a ${source}-origin turn ends: the prompter B gets a bell row; the creator A gets none`, async () => {
          expectCount(await endTurnFrom(source), 0, `creator rows for a ${source} session`);
        });
      }

      await ctx.step('positive control: the same turn in a web session → the creator A gets a row', async () => {
        expectCount(await endTurnFrom('ui'), 1, 'creator rows for a web session');
      });
    } finally {
      await db.end();
    }
  },
);

// NOTIF-7 — following and muting one session, and what that changes.
flow(
  'NOTIF-7',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/watch',
      'PUT /v1/projects/:projectId/sessions/:sessionId/watch',
      'POST /v1/accounts/tokens',
      'POST /v1/projects/:projectId/turn-stream',
      'GET /v1/notifications',
    ],
  },
  async (ctx) => {
    const { team, project, a, b: w } = await teamWithTwoMembers(ctx);
    const db = await openFlowDb(ctx.env);
    const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: a }).catch(async (error) => {
      await db.end();
      throw error;
    });
    const params = { projectId: project.id, sessionId: turn.sessionId };
    const watching = async (who: Principal) =>
      (await ctx.client.as(who).get(watchRoute, { params })).status(200).json<{ watching: boolean }>().watching;
    const setWatch = (who: Principal, value: boolean) =>
      ctx.client.as(who).put(watchRoute, { watching: value }, { params }).then((r) => r.status(200).body().has('$.watching', value));
    try {
      await ctx.step('ANON → 401; a user outside the account → 403', async () => {
        (await ctx.client.as(ctx.P.ANON).get(watchRoute, { params })).status(401);
        (await ctx.client.as(ctx.P.NONMEMBER).get(watchRoute, { params })).status(403);
      });

      await ctx.step('the creator watches by default (true); a member who never wrote in it does not (false)', async () => {
        if ((await watching(a)) !== true) throw new Error('creator not watching');
        if ((await watching(w)) !== false) throw new Error('bystander watching');
      });

      await ctx.step("the session's own sandbox token is not a person → 403 on watch and on the inbox", async () => {
        (await turn.sandbox.get(watchRoute, { params })).status(403);
        (await turn.sandbox.put(watchRoute, { watching: true }, { params })).status(403);
        (await turn.sandbox.get('/v1/notifications')).status(403);
      });

      await ctx.step('a body without a boolean watching → 400', async () => {
        (await ctx.client.as(w).put(watchRoute, { watching: 'yes' }, { params })).status(400);
        (await ctx.client.as(w).put(watchRoute, {}, { params })).status(400);
      });

      await ctx.step('the member follows it (true, reads back true); the creator mutes it (false, reads back false)', async () => {
        await setWatch(w, true);
        if ((await watching(w)) !== true) throw new Error('follow did not read back');
        await setWatch(a, false);
        if ((await watching(a)) !== false) throw new Error('mute did not read back');
      });

      await ctx.step('a turn no person prompted ends: the follower gets turn_done; the muted creator gets nothing', async () => {
        await turn.startTurn('msg_notif7');
        await turn.endTurn('msg_notif7');
        await waitForInbox(ctx, w, (row) => row.session_id === turn.sessionId && row.kind === 'turn_done');
        await settle();
        expectCount(await storedCount(db, a.userId!, { sessionId: turn.sessionId }), 0, "the muted creator's rows");
      });

      await ctx.step('the creator unmutes it → watching reads back true', async () => {
        await setWatch(a, true);
        if ((await watching(a)) !== true) throw new Error('unmute did not read back');
      });
    } finally {
      await turn.cleanup();
      await db.end();
    }
  },
);

// NOTIF-8 — an agent's question and permission request reach the prompter of
// the running turn, once per request, and never a muted watcher.
flow(
  'NOTIF-8',
  {
    domain: 'notifications',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'PUT /v1/projects/:projectId/sessions/:sessionId/watch',
      'POST /v1/projects/:projectId/turn-question',
      'POST /v1/projects/:projectId/turn-permission',
      'GET /v1/notifications',
    ],
  },
  async (ctx) => {
    const { team, project, a, b } = await teamWithTwoMembers(ctx);
    const db = await openFlowDb(ctx.env);
    const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: a }).catch(async (error) => {
      await db.end();
      throw error;
    });
    const sessionId = turn.sessionId;
    const params = { projectId: project.id };
    const QUESTION = 'Which region should the service deploy to?';
    const ask = (requestId: string, who = turn.sandbox) =>
      who.post(
        '/v1/projects/:projectId/turn-question',
        {
          session_id: sessionId,
          request_id: requestId,
          runtime_session_id: 'ses_root',
          questions: [{ question: QUESTION, header: 'Region', options: [{ label: 'eu-west-1' }, { label: 'us-east-1' }] }],
        },
        { params },
      );
    const askPermission = (who = turn.sandbox) =>
      who.post(
        '/v1/projects/:projectId/turn-permission',
        { session_id: sessionId, request_id: 'per_notif8', permission: 'bash', patterns: ['git push origin main'] },
        { params },
      );
    try {
      await turn.startTurn('msg_notif8', b.userId!);
      await ctx.step('A, the creator, mutes the session; B prompted its running turn', async () => {
        (await ctx.client.as(a).put(watchRoute, { watching: false }, { params: { ...params, sessionId } })).status(200);
      });

      await ctx.step('the sandbox relays a question → 200 persisted; B gets one question row whose body is the question', async () => {
        (await ask('que_notif8')).status(200).body().has('$.persisted', true);
        const [row] = await waitForInbox(ctx, b, (r) => r.session_id === sessionId && r.kind === 'question');
        if (row.body !== QUESTION) throw new Error(JSON.stringify(row));
      });

      await ctx.step('the muted creator A gets no question row; a daemon retry of the same request adds none', async () => {
        (await ask('que_notif8')).status(200);
        await settle();
        expectCount(await storedCount(db, a.userId!, { sessionId }), 0, "muted A's rows");
        expectCount(await storedCount(db, b.userId!, { sessionId, kind: 'question' }), 1, "B's question rows after a retry");
      });

      await ctx.step("a person's token may store a question, and it notifies nobody", async () => {
        (await ask('que_notif8_person', ctx.client.as(b))).status(200).body().has('$.persisted', true);
        await settle();
        expectCount(await storedCount(db, b.userId!, { sessionId, kind: 'question' }), 1, "B's question rows after a person's relay");
      });

      await ctx.step('the sandbox relays one permission request twice → notified true, then false; B has exactly one permission row', async () => {
        (await askPermission()).status(200).body().has('$.notified', true);
        (await askPermission()).status(200).body().has('$.notified', false);
        await waitForInbox(ctx, b, (r) => r.session_id === sessionId && r.kind === 'permission');
        await settle();
        expectCount(await storedCount(db, b.userId!, { sessionId, kind: 'permission' }), 1, "B's permission rows");
        expectCount(await storedCount(db, a.userId!, { sessionId }), 0, "muted A's rows");
      });

      await ctx.step("a person's token cannot relay a permission request → 403", async () => {
        (await askPermission(ctx.client.as(b))).status(403);
      });
    } finally {
      await turn.cleanup();
      await db.end();
    }
  },
);
