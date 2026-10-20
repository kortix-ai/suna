/**
 * Sessions — create/list/get/delete/restore + unified runtime start. Maps to spec §16 (SESS-*).
 * Session creation provisions a REAL Platinum sandbox (fire-and-forget), so these
 * assert the contract (201 provisioning, status transitions) without blocking on
 * a full boot. Gated on the `sandbox` capability, except SESS-36 and SESS-51,
 * which run on the local profile against a database session with a saved
 * transcript, and SESS-52, which seeds its sessions as database rows.
 */
import {
  CreateSessionPromptResultSchema,
  ProjectSessionSchema,
  SessionDeleteResultSchema,
  SessionPromptListSchema,
  SessionStartResultSchema,
  SessionTranscriptSyncEnvelopeSchema,
  SessionTurnStatusSchema,
  WarmProjectSessionResultSchema,
} from '@kortix/api-contract';
import { isKe2eRetryableError } from '../core/client';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { createDatabaseSession, fundDatabaseAccount } from '../fixtures/database-project';
import { seedSessionTranscript } from '../fixtures/session-transcript';
import { openFlowDb, seedTurnSession } from '../fixtures/turn-end';

flow(
  'SESS-1',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    await ctx.step('create session → 201 provisioning', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions',
          { initial_prompt: 'noop' },
          { params: { projectId: p.id } },
        );
      r.status(201);
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track('session', id, { projectId: p.id });
    });
  },
);

flow(
  'SESS-4',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 120_000,
    routes: ['GET /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('list sessions', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions', { params: { projectId: p.id } });
      r.status(200);
    });
  },
);

flow(
  'SESS-5',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    await ctx.step('get session → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(200);
    });
    await ctx.step('non-uuid session id → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: p.id, sessionId: 'not-a-uuid' },
        });
      r.status(400);
    });
  },
);

flow(
  'SESS-8',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/sessions/:sessionId/start'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    await ctx.step('unified start reports the runtime readiness stage', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          { params: { projectId: p.id, sessionId: s.id } },
        );
      r.status(200).body().exists('$.stage').exists('$.retriable');
    });
  },
);

flow(
  'SESS-7',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['DELETE /v1/projects/:projectId/sessions/:sessionId'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    await ctx.step('delete session → 200 stopped', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(200);
    });
  },
);

/**
 * SESS-13 — session public shares: CRUD lifecycle + the unauthenticated
 * resolution endpoint. Source of truth: projects/routes/public-shares.ts +
 * shared/session-public-shares.ts (CRUD) and sandbox-proxy/routes/public-share.ts
 * (anon resolution, mounted BEFORE combinedAuth in sandbox-proxy/index.ts — it
 * is genuinely public, no token/cookie ever required).
 *
 * REAL status codes confirmed from source (not guessed):
 *  - a revoked token resolves → 410 "Share link revoked" (resolvePublicShare
 *    checks `revokedAt` BEFORE it ever looks at the sandbox) — NOT 404.
 *  - an unknown token → 404 "Share link not found".
 *  - a real, not-yet-revoked preview/file token whose sandbox has no
 *    `externalId` yet → 503 "Sandbox is not ready" (a transcript token needs no
 *    sandbox — SESS-36). `resolvePublicShare` LEFT (not INNER) JOINs
 *    `session_sandboxes` for exactly this reason: a freshly-created session
 *    frequently has no `session_sandboxes` row at all yet (provisioning is
 *    kicked off in the background, not awaited before POST /sessions
 *    responds), and an INNER JOIN made that case fall into `!row` → a false
 *    404 ("not found") for a share token that is perfectly valid. `session_id`
 *    is unique on `session_sandboxes` (one row per session), so the LEFT JOIN
 *    never fans out — only [200, 503] are legal for a fresh, unrevoked token.
 *  - `listPublicSharesForSession` does NOT filter out revoked shares —
 *    revoking sets `revoked_at`, it does not remove the row from the list.
 *  - revoke has no idempotency guard (the UPDATE...WHERE matches on
 *    shareId+sessionId only, not `revoked_at IS NULL`), so revoking twice is
 *    200 both times, not a 409/404 on the second call.
 */
flow(
  'SESS-13',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'GET /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
      'GET /v1/p/public-share/:token',
      'GET /v1/p/config',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);

    let shareId = '';
    let token = '';
    await ctx.step('create a preview public share → 201 with token + shape', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { preview: { port: 5173, path: '/', label: 'ke2e preview' } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201)
        .body()
        .has('$.share.session_id', session.id)
        .has('$.share.project_id', project.id)
        .has('$.share.resource_type', 'preview')
        .has('$.share.port', 5173)
        .has('$.share.mode', 'view')
        .exists('$.share.share_id')
        .matches('$.share.public_token', /^kps_[0-9a-f]{32}$/)
        .matches('$.share.public_path', /^\/share\/session\/kps_[0-9a-f]{32}$/)
        .exists('$.share.proxy_path');
      const body = r.json<any>();
      shareId = body.share.share_id;
      token = body.share.public_token;
    });

    await ctx.step('list shows the share → 200', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
        params: { projectId: project.id, sessionId: session.id },
      });
      r.status(200).body().has('$.shares[0].share_id', shareId);
    });

    await ctx.step('unauthenticated resolution of an unknown token → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/p/public-share/:token', { params: { token: 'kps_ke2e_does_not_exist' } });
      r.status(404);
    });

    await ctx.step(
      'unauthenticated resolution of the real token → 200 (sandbox ready) or 503 (not yet) — never an auth error',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/p/public-share/:token', { params: { token } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body()
            .has('$.share.share_id', shareId)
            .has('$.share.session_id', session.id)
            .exists('$.share.proxy_path');
        }
      },
    );

    await ctx.step('revoke the share → 200 with revoked_at set', async () => {
      const r = await owner.del(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
        {
          params: { projectId: project.id, sessionId: session.id, shareId },
        },
      );
      r.status(200).body().has('$.share.share_id', shareId).exists('$.share.revoked_at');
    });

    await ctx.step(
      'list still shows the (now revoked) share — revoke does not delete the row',
      async () => {
        const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
          params: { projectId: project.id, sessionId: session.id },
        });
        r.status(200).body().has('$.shares[0].share_id', shareId).exists('$.shares[0].revoked_at');
      },
    );

    await ctx.step(
      'unauthenticated resolution of the revoked token → 410 Gone (not 404)',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/p/public-share/:token', { params: { token } });
        r.status(410);
      },
    );

    await ctx.step(
      'revoking again is idempotent → 200 (no guard against double-revoke)',
      async () => {
        const r = await owner.del(
          '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
          {
            params: { projectId: project.id, sessionId: session.id, shareId },
          },
        );
        r.status(200);
      },
    );

    await ctx.step('revoking an unknown share id on this session → 404', async () => {
      const r = await owner.del(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
        {
          params: { projectId: project.id, sessionId: session.id, shareId: crypto.randomUUID() },
        },
      );
      r.status(404);
    });

    await ctx.step('malformed (non-uuid) share id → 400', async () => {
      const r = await owner.del(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
        {
          params: { projectId: project.id, sessionId: session.id, shareId: 'not-a-uuid' },
        },
      );
      r.status(400);
    });

    // The `file` branch of the same endpoint. Everything above exercises
    // `preview`; a file share takes a different path through
    // buildPublicShareInsert (normalizeWorkspaceFilePath, port forced null,
    // mode forced 'view') and resolves to `.../file` rather than `.../:port`.
    // It went uncovered while nothing in the product could create one — the
    // frontend only regained that ability in #5751.
    let fileShareId = '';
    let fileToken = '';

    await ctx.step('create a file public share → 201, portless, view-only', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { file: { path: '/workspace/README.md', label: 'ke2e file' } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201)
        .body()
        .has('$.share.resource_type', 'file')
        .has('$.share.file_path', '/workspace/README.md')
        .has('$.share.port', null)
        .has('$.share.mode', 'view')
        .has('$.share.allow_websocket', false)
        .matches('$.share.public_token', /^kps_[0-9a-f]{32}$/)
        .matches('$.share.proxy_path', /^\/v1\/p\/public-share\/kps_[0-9a-f]{32}\/file$/);
      const body = r.json<any>();
      fileShareId = body.share.share_id;
      fileToken = body.share.public_token;
    });

    await ctx.step('a workspace-relative path is normalized, not rejected', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { file: { path: 'notes/report.md' } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      // Not ctx.track'ed: public_share rows are FK'd to the session with ON
      // DELETE CASCADE, so the session fixture's own teardown reclaims them.
      r.status(201).body().has('$.share.file_path', '/workspace/notes/report.md');
    });

    await ctx.step('a traversing file path is refused → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { file: { path: '/workspace/../../etc/passwd' } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(400);
    });

    await ctx.step(
      'unauthenticated file resolution matches the deployment’s preview-origin configuration',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/p/public-share/:token', { params: { token: fileToken } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body().has('$.share.resource_type', 'file').has('$.share.file_path', '/workspace/README.md');
          const config = await ctx.client.as(ctx.P.ANON).get('/v1/p/config');
          config.status(200);
          if (config.json<any>().preview_url_template === null) {
            r.body().has('$.share.public_url', null)
              .has('$.share.proxy_path', `/v1/p/public-share/${fileToken}/file`);
            return;
          }
          const publicUrl = new URL(r.json<any>().share.public_url);
          if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/open') {
            throw new Error(`file share returned an invalid public_url: ${publicUrl}`);
          }
          if (publicUrl.searchParams.get('public_share') !== fileToken) {
            throw new Error('file share public_url does not carry its public token');
          }
        }
      },
    );

    await ctx.step('revoked file token → 410, same as a preview token', async () => {
      const del = await owner.del(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
        { params: { projectId: project.id, sessionId: session.id, shareId: fileShareId } },
      );
      del.status(200);

      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/p/public-share/:token', { params: { token: fileToken } });
      r.status(410);
    });
  },
);

/**
 * SESS-14 — public-share access boundary. `loadSessionForSharing()` returns TWO
 * verdicts and the three routes deliberately do not share one:
 *
 *   canManageLifecycle = isOwner || canManageProject   → LIST + REVOKE
 *   canManageSharing   = mayManageSessionSharing(...)  → MINT
 *
 * Revoking only ever REMOVES access, so a project manager must be able to kill
 * a leaking link on a session they did not create. Minting is the opposite: a
 * public share link is UNAUTHENTICATED, and a manager cannot read another
 * human's private session (isProjectSessionVisibleTo grants the manager
 * override to TRIGGER-created sessions only), so letting a manager mint one
 * would hand them the content the visibility gate had just refused. That is
 * the escalation the split closes, and it is what this flow pins.
 *
 * A plain project MEMBER who did not create the session is denied on all three
 * (403 — a real permission denial, not a 404: they are a legitimate member of
 * the project the session lives in). NONMEMBER is denied earlier by the
 * account-membership gate in `loadProjectForUser`. ANON never reaches the
 * handler (401, `supabaseAuth`).
 *
 * `loadSessionForSharing` is deliberately NOT `loadVisibleSession` (the
 * content-visibility gate used for reading a transcript): the public-shares
 * routes used to call it, and its `isSessionVisibleTo` check hides a
 * default-`private` session from everyone but its creator — so the route 404'd
 * before any permission check ran, even for a real project manager, and a
 * plain member got that same 404 instead of the informative 403.
 */
flow(
  'SESS-14',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'GET /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project({ seed: true });
    const plainMember = await team.addMember('member');
    await team.grantProjectRole(p.id, plainMember.userId!, 'member');
    const manager = await team.addMember('member');
    await team.grantProjectRole(p.id, manager.userId!, 'manager');

    const owner = ctx.client.as(ctx.P.OWNER);
    let sessionId = '';
    await ctx.step('OWNER (the account owner) creates the session — session creator', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions',
        { initial_prompt: 'noop' },
        { params: { projectId: p.id } },
      );
      r.status(201);
      sessionId = r.json<any>()?.session_id ?? r.json<any>()?.id;
      ctx.track('session', sessionId, { projectId: p.id });
    });

    let shareId = '';
    await ctx.step('the creator can create a public share', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { preview: { port: 3000 } },
        { params: { projectId: p.id, sessionId } },
      );
      r.status(201);
      shareId = r.json<any>()?.share?.share_id;
    });

    await ctx.step(
      'a plain project MEMBER who did not create the session cannot list shares → 403',
      async () => {
        const r = await ctx.client
          .as(plainMember)
          .get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
            params: { projectId: p.id, sessionId },
          });
        r.status(403);
      },
    );
    await ctx.step(
      "a plain project MEMBER cannot create a share on someone else's session → 403",
      async () => {
        const r = await ctx.client
          .as(plainMember)
          .post(
            '/v1/projects/:projectId/sessions/:sessionId/public-shares',
            { preview: { port: 3000 } },
            { params: { projectId: p.id, sessionId } },
          );
        r.status(403);
      },
    );
    await ctx.step("a plain project MEMBER cannot revoke someone else's share → 403", async () => {
      const r = await ctx.client
        .as(plainMember)
        .del('/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId', {
          params: { projectId: p.id, sessionId, shareId },
        });
      r.status(403);
    });

    await ctx.step(
      'a project MANAGER (not the creator) CAN list shares → 200 (canManageLifecycle)',
      async () => {
        const r = await ctx.client
          .as(manager)
          .get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
            params: { projectId: p.id, sessionId },
          });
        r.status(200).body().has('$.shares[0].share_id', shareId);
      },
    );

    await ctx.step(
      'a project MANAGER (not the creator) CANNOT mint a public link → 403 (canManageSharing)',
      async () => {
        // The escalation: the manager cannot read this private session, so a
        // link they minted and then opened anonymously would be a read the
        // visibility gate refused them.
        const r = await ctx.client
          .as(manager)
          .post(
            '/v1/projects/:projectId/sessions/:sessionId/public-shares',
            { preview: { port: 3000 } },
            { params: { projectId: p.id, sessionId } },
          );
        r.status(403)
          .body()
          .has('$.error', 'Only the session owner can create a public link to this session');
      },
    );

    await ctx.step(
      'a project MANAGER CAN revoke a link they did not mint → 200 (revoking only removes access)',
      async () => {
        const r = await ctx.client
          .as(manager)
          .del('/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId', {
            params: { projectId: p.id, sessionId, shareId },
          });
        r.status(200).body().exists('$.share.revoked_at');
      },
    );

    await ctx.step('NONMEMBER → 403 (no account membership at all)', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
          params: { projectId: p.id, sessionId },
        });
      r.status(403);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
          params: { projectId: p.id, sessionId },
        });
      r.status(401);
    });
  },
);

/**
 * SESS-26 — the session sharing POLICY is the owner's, not the project
 * manager's. Same `mayManageSessionSharing` predicate SESS-14 pins on minting a
 * public link, applied to `PUT .../sharing`.
 *
 * This route sits BEHIND the content-visibility gate, so a manager never
 * reaches another human's still-private session (404). The reachable defect was
 * the session that HAD been shared with them: a manager could rewrite the
 * owner's policy wholesale and revoke everyone, the owner included. Sharing a
 * session with a manager is not handing them its access list.
 *
 * Also pinned: `private` means "the OWNER only", never "only the person
 * editing". A non-owner who saved it lost the session for good, because undoing
 * it needs the read the save had just revoked. The route now refuses any change
 * that would strip the EDITOR's own access.
 */
flow(
  'SESS-26',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'PUT /v1/projects/:projectId/sessions/:sessionId/sharing',
      'GET /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project({ seed: true });
    const manager = await team.addMember('member');
    await team.grantProjectRole(p.id, manager.userId!, 'manager');
    const plainMember = await team.addMember('member');
    await team.grantProjectRole(p.id, plainMember.userId!, 'member');

    const owner = ctx.client.as(ctx.P.OWNER);
    let sessionId = '';
    await ctx.step('OWNER creates the session — the human owner of its policy', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions',
        { initial_prompt: 'noop' },
        { params: { projectId: p.id } },
      );
      r.status(201);
      sessionId = r.json<any>()?.session_id ?? r.json<any>()?.id;
      ctx.track('session', sessionId, { projectId: p.id });
    });

    await ctx.step('the session reports the creator as owner and sharing manager', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: p.id, sessionId },
      });
      r.status(200)
        .body()
        .has('$.is_owner', true)
        .has('$.can_manage_sharing', true)
        .has('$.can_manage_lifecycle', true)
        .has('$.visibility', 'private');
    });

    await ctx.step(
      'a project MANAGER cannot even see the still-private session → 404 (visibility gate first)',
      async () => {
        const r = await ctx.client
          .as(manager)
          .put(
            '/v1/projects/:projectId/sessions/:sessionId/sharing',
            { mode: 'project' },
            { params: { projectId: p.id, sessionId } },
          );
        r.status(404);
      },
    );

    await ctx.step('a plain project MEMBER cannot change sharing either → 404 or 403', async () => {
      // A private session is invisible to a plain member, so `loadVisibleSession`
      // hides it with 404 before the permission check. Either answer is a
      // refusal; what must never happen is a 200.
      const r = await ctx.client
        .as(plainMember)
        .put(
          '/v1/projects/:projectId/sessions/:sessionId/sharing',
          { mode: 'project' },
          { params: { projectId: p.id, sessionId } },
        );
      r.status([403, 404]);
    });

    await ctx.step('the OWNER shares it with the whole project → 200', async () => {
      const r = await owner.put(
        '/v1/projects/:projectId/sessions/:sessionId/sharing',
        { mode: 'project' },
        { params: { projectId: p.id, sessionId } },
      );
      r.status(200);
    });

    await ctx.step(
      'the manager can now READ it, and still cannot change its sharing → 403',
      async () => {
        const read = await ctx.client
          .as(manager)
          .get('/v1/projects/:projectId/sessions/:sessionId', {
            params: { projectId: p.id, sessionId },
          });
        // Reading a project-wide session is the whole point of sharing it.
        // Managing its policy is still not the reader's to do.
        read
          .status(200)
          .body()
          .has('$.is_owner', false)
          .has('$.can_manage_sharing', false)
          .has('$.can_manage_lifecycle', true);

        // The reachable defect: before this rule the manager could set it back
        // to `private` and revoke everyone, the OWNER included, on a session
        // they had merely been shown.
        const write = await ctx.client
          .as(manager)
          .put(
            '/v1/projects/:projectId/sessions/:sessionId/sharing',
            { mode: 'private' },
            { params: { projectId: p.id, sessionId } },
          );
        write
          .status(403)
          .body()
          .has('$.error', 'Only the session owner can change who opens this session');
      },
    );

    await ctx.step('the OWNER may still set it back to private — every mode keeps the owner', async () => {
      const r = await owner.put(
        '/v1/projects/:projectId/sessions/:sessionId/sharing',
        { mode: 'private' },
        { params: { projectId: p.id, sessionId } },
      );
      r.status(200).body().has('$.visibility', 'private');
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put(
          '/v1/projects/:projectId/sessions/:sessionId/sharing',
          { mode: 'project' },
          { params: { projectId: p.id, sessionId } },
        );
      r.status(401);
    });
  },
);

/**
 * SESS-15 — per-session agent action audit log. Same visibility gate as
 * session detail (project read + the session must be visible to the caller —
 * projects/routes/project-audit.ts). Non-Enterprise accounts degrade to pending-only
 * (never a 402 here: this is the always-on approval control plane the
 * launcher polls from every open session).
 */
flow(
  'SESS-15',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/audit'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('read the session audit trail → 200 (empty on a fresh session)', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/audit', {
        params: { projectId: p.id, sessionId: s.id },
      });
      r.status(200)
        .body()
        .has('$.session_id', s.id)
        .has('$.count', 0)
        .exists('$.actions')
        .exists('$.audit_access');
    });
    await ctx.step('non-uuid session id → 400', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/audit', {
        params: { projectId: p.id, sessionId: 'not-a-uuid' },
      });
      r.status(400);
    });
    await ctx.step('invalid limit (below 1) → 400', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/audit', {
        params: { projectId: p.id, sessionId: s.id },
        query: { limit: '0' },
      });
      r.status(400);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/sessions/:sessionId/audit', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(403);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sessions/:sessionId/audit', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(401);
    });
  },
);

/**
 * SESS-16 — anonymous session-share VIEWING: `GET /v1/public/session-shares/:shareId`
 * and `.../messages`, mounted at `apps/api/src/public-session-shares/index.ts`
 * (public/session-shares/index.ts, no auth middleware). Closes the backend
 * gap `(public)/share/[shareId]` (apps/web `ShareViewer.tsx`) had flagged
 * in-code since #4124: that page has no public-share token in its route and
 * the sandbox-proxy's own public-share family deliberately blocks port 8000
 * (`PUBLIC_SHARE_BLOCKED_PORTS` in shared/session-public-shares.ts), so it
 * could never serve a session's title/transcript to a logged-out visitor.
 *
 * `:shareId` here is the SESS-13 share's raw `share_id` (the uuid — the SAME
 * value the CRUD responses call `share.share_id`) or its `kps_...` public
 * token. The route resolves through the exact same `resolvePublicShare()`
 * SESS-13 covers, so it inherits identical 404 (unknown) / 410 (revoked or
 * expired) semantics. A share grants exactly the resource it names: a
 * `preview` share names one app port and a `file` share one document, so
 * neither reads the conversation — `.../messages` answers 404 for both
 * (SCOPE-4 pins this on the local profile). A `transcript` share
 * (`{transcript:true}`) reads it; SESS-36 pins that contract locally, and the
 * last steps here run it against a real sandbox.
 *
 * The metadata route (`GET /:shareId`) is DB-only (title/status/timestamps),
 * so it does not itself 503 on an inactive sandbox — only `resolvePublicShare`'s
 * missing-`externalId` check can, and only for a preview/file share. For a
 * transcript share the messages route reads the live sandbox when it is
 * `active` (`source:"live"`) and the saved transcript otherwise
 * (`source:"mirror"`); it 503s only when neither exists, and a running sandbox
 * with nothing readable degrades to a 200 `{available:false, source:"none"}`
 * digest a polling frontend should retry.
 */
flow(
  'SESS-16',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
      'GET /v1/public/session-shares/:shareId',
      'GET /v1/public/session-shares/:shareId/messages',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);

    let shareId = '';
    await ctx.step('create a preview public share → 201', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { preview: { port: 5173, path: '/', label: 'ke2e session-share' } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201);
      shareId = r.json<any>()?.share?.share_id;
    });

    await ctx.step('anon: unknown share id → 404 on metadata', async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId', {
        params: { shareId: crypto.randomUUID() },
      });
      r.status(404);
    });

    await ctx.step('anon: unknown share id → 404 on messages', async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId/messages', {
        params: { shareId: crypto.randomUUID() },
      });
      r.status(404);
    });

    await ctx.step('anon: malformed (non-uuid) share id → 400', async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId', {
        params: { shareId: 'not-a-uuid' },
      });
      r.status(400);
    });

    await ctx.step(
      'anon: view metadata for the real share → 200 (sandbox ready) or 503 (not yet) — never an auth error',
      async () => {
        const r = await anon.get('/v1/public/session-shares/:shareId', { params: { shareId } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body()
            .has('$.share.share_id', shareId)
            .has('$.share.session_id', session.id)
            .has('$.session.session_id', session.id)
            .exists('$.session.status')
            .exists('$.session.created_at');
        }
      },
    );

    await ctx.step(
      'anon: a preview share does not read the transcript → 404 (the share names one app port)',
      async () => {
        const r = await anon.get('/v1/public/session-shares/:shareId/messages', {
          params: { shareId },
        });
        r.status(404).body().has('$.error', 'This share does not include the conversation');
      },
    );

    await ctx.step('revoke the share → 200', async () => {
      const r = await owner.del(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
        {
          params: { projectId: project.id, sessionId: session.id, shareId },
        },
      );
      r.status(200);
    });

    await ctx.step("anon: revoked share's metadata → 410 Gone (not 404)", async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId', { params: { shareId } });
      r.status(410);
    });

    await ctx.step("anon: revoked share's messages → 410 Gone (not 404)", async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId/messages', {
        params: { shareId },
      });
      r.status(410);
    });

    let transcriptShareId = '';
    await ctx.step('mint a transcript public share → 201', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { transcript: true },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201).body().has('$.share.resource_type', 'transcript');
      transcriptShareId = r.json<any>()?.share?.share_id;
    });

    await ctx.step(
      'anon: the transcript share reads the conversation → 503 until the sandbox is active, then a 200 digest from the live sandbox or the saved transcript',
      async () => {
        // The fixture session was created moments ago; while its sandbox starts
        // and nothing is saved, the contract answers 503. Once the sandbox is
        // active but its runtime has no root conversation yet, it answers 200
        // `source:"none"` (the spec's retry signal) — a box that turns active
        // in ~5 s (a warm Platinum claim) sits in that window for seconds.
        const r = await waitFor(
          () => anon.get('/v1/public/session-shares/:shareId/messages', { params: { shareId: transcriptShareId } }),
          {
            until: (res) =>
              res.statusCode !== 503 &&
              !(res.statusCode === 200 && res.json<{ source?: string }>().source === 'none'),
            timeoutMs: 180_000,
            intervalMs: 2_000,
            description: 'the shared session to become readable',
            retryOnError: isKe2eRetryableError,
          },
        );
        r.status(200).body().exists('$.messages');
        const source = r.json<{ source?: string }>().source;
        if (source !== 'live' && source !== 'mirror') {
          throw new Error(`expected source live or mirror, got ${JSON.stringify(source)}`);
        }
      },
    );

    await ctx.step('revoke the transcript share → 200, then its messages → 410', async () => {
      (
        await owner.del('/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId', {
          params: { projectId: project.id, sessionId: session.id, shareId: transcriptShareId },
        })
      ).status(200);
      (
        await anon.get('/v1/public/session-shares/:shareId/messages', {
          params: { shareId: transcriptShareId },
        })
      ).status(410);
    });
  },
);

/**
 * SESS-36 — public transcript share. `POST .../public-shares {transcript:true}`
 * mints the ONE share kind that reads the conversation; the anonymous
 * `/v1/public/session-shares/:ref/messages` then answers with the sanitized
 * digest. Runs on the local profile: the session is a database row with a
 * stopped sandbox and a saved transcript, so the read proves the mirror
 * fallback a shared link depends on once its sandbox idles out.
 */
flow(
  'SESS-36',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'GET /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
      'GET /v1/public/session-shares/:shareId',
      'GET /v1/public/session-shares/:shareId/messages',
      'GET /v1/p/public-share/:token',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    // A human-owned PRIVATE session: only its creator may publish it.
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
      visibility: 'private',
    });
    ctx.track('session', sessionId, { projectId: project.id });
    await seedSessionTranscript(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      sessionId,
    });
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const sharesRoute = '/v1/projects/:projectId/sessions/:sessionId/public-shares';
    const params = { projectId: project.id, sessionId };
    type Share = {
      share_id: string;
      resource_type: string;
      public_token: string;
      public_path: string;
      public_url: string | null;
      proxy_path: string;
      revoked_at: string | null;
    };

    await ctx.step('ANON cannot mint a transcript share → 401', async () => {
      (await anon.post(sharesRoute, { transcript: true }, { params })).status(401);
    });

    await ctx.step('NONMEMBER cannot mint a transcript share → 403, no share is written', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).post(sharesRoute, { transcript: true }, { params })).status(403);
      const list = await owner.get(sharesRoute, { params });
      list.status(200);
      if (list.json<{ shares: Share[] }>().shares.length !== 0) throw new Error('a refused mint wrote a share');
    });

    await ctx.step('a project MEMBER who did not create the private session cannot mint → 403, no share is written', async () => {
      (await ctx.client.as(member).post(sharesRoute, { transcript: true }, { params })).status(403);
      const list = await owner.get(sharesRoute, { params });
      list.status(200);
      if (list.json<{ shares: Share[] }>().shares.length !== 0) throw new Error('a refused mint wrote a share');
    });

    await ctx.step('a transcript share combined with a file → 400', async () => {
      (await owner.post(sharesRoute, { transcript: true, file: { path: '/workspace/a.md' } }, { params }))
        .status(400)
        .body()
        .has('$.error', 'A public share names one resource');
    });

    let share!: Share;
    await ctx.step('the owner mints a transcript share → 201, a view-only link to the web viewer', async () => {
      const r = await owner.post(sharesRoute, { transcript: true }, { params });
      r.status(201)
        .body()
        .has('$.share.resource_type', 'transcript')
        .has('$.share.session_id', sessionId)
        .has('$.share.label', 'Conversation')
        .has('$.share.mode', 'view')
        .has('$.share.port', null)
        .has('$.share.file_path', null);
      share = r.json<{ share: Share }>().share;
      if (share.public_token !== `kps_${share.share_id.replaceAll('-', '')}`) throw new Error(`token ${share.public_token}`);
      if (share.public_path !== `/share/session/${share.public_token}`) throw new Error(`path ${share.public_path}`);
      if (!share.public_url?.endsWith(share.public_path)) throw new Error(`public_url ${share.public_url}`);
      if (share.proxy_path !== `/v1/public/session-shares/${share.public_token}/messages`) {
        throw new Error(`proxy_path ${share.proxy_path}`);
      }
    });

    await ctx.step('minting again returns the same live link → 200', async () => {
      (await owner.post(sharesRoute, { transcript: true }, { params }))
        .status(200)
        .body()
        .has('$.share.share_id', share.share_id);
    });

    await ctx.step('the owner lists exactly one transcript share', async () => {
      const r = await owner.get(sharesRoute, { params });
      r.status(200);
      const transcripts = r.json<{ shares: Share[] }>().shares.filter((s) => s.resource_type === 'transcript');
      if (transcripts.length !== 1 || transcripts[0].share_id !== share.share_id) {
        throw new Error(`expected one transcript share, got ${JSON.stringify(transcripts)}`);
      }
    });

    await ctx.step('anon reads the share metadata by share id and by token → 200, no sandbox needed', async () => {
      for (const ref of [share.share_id, share.public_token]) {
        (await anon.get('/v1/public/session-shares/:shareId', { params: { shareId: ref } }))
          .status(200)
          .body()
          .has('$.share.share_id', share.share_id)
          .has('$.share.resource_type', 'transcript')
          .has('$.session.session_id', sessionId);
      }
    });

    await ctx.step('anon reads the saved conversation through the token → 200 sanitized digest', async () => {
      const r = await anon.get('/v1/public/session-shares/:shareId/messages', {
        params: { shareId: share.public_token },
      });
      r.status(200)
        .body()
        .has('$.available', true)
        .has('$.source', 'mirror')
        .has('$.message_count', 2)
        .has('$.messages[0].role', 'user')
        .has('$.messages[0].text', 'Show my saved conversation.')
        .has('$.messages[1].role', 'assistant')
        .has('$.messages[1].text', 'This reply is stored in the database.');
      const [first] = r.json<{ messages: Record<string, unknown>[] }>().messages;
      const keys = Object.keys(first).sort().join(',');
      if (keys !== 'completed,created,files,reasoning_omitted,role,text,tools') {
        throw new Error(`an anonymous message carries more than the digest fields: ${keys}`);
      }
    });

    await ctx.step('anon resolves the token on the proxy edge → 200 transcript, opens no port', async () => {
      (await anon.get('/v1/p/public-share/:token', { params: { token: share.public_token } }))
        .status(200)
        .body()
        .has('$.share.resource_type', 'transcript')
        .has('$.share.proxy_path', share.proxy_path)
        .has('$.share.public_url', share.public_url);
    });

    let previewShareId = '';
    await ctx.step('a preview share of the same session still does not read the conversation → 404', async () => {
      const r = await owner.post(sharesRoute, { preview: { port: 3000 } }, { params });
      r.status(201);
      previewShareId = r.json<{ share: Share }>().share.share_id;
      (await anon.get('/v1/public/session-shares/:shareId/messages', { params: { shareId: previewShareId } }))
        .status(404)
        .body()
        .has('$.error', 'This share does not include the conversation');
    });

    await ctx.step('the owner revokes the transcript share → 200 with revoked_at', async () => {
      const r = await owner.del(`${sharesRoute}/:shareId`, { params: { ...params, shareId: share.share_id } });
      r.status(200);
      if (!r.json<{ share: Share }>().share.revoked_at) throw new Error('revoked_at is not set');
    });

    await ctx.step('anon: the revoked link → 410 on metadata and messages', async () => {
      (await anon.get('/v1/public/session-shares/:shareId', { params: { shareId: share.public_token } })).status(410);
      (await anon.get('/v1/public/session-shares/:shareId/messages', { params: { shareId: share.public_token } }))
        .status(410);
    });

    await ctx.step('minting after a revoke creates a new link → 201 with a new share id', async () => {
      const r = await owner.post(sharesRoute, { transcript: true }, { params });
      r.status(201);
      const next = r.json<{ share: Share }>().share;
      if (next.share_id === share.share_id) throw new Error('a revoked link was handed back');
      share = next;
    });

    await ctx.step('the owner deletes the session → its live links answer 410 and read back revoked', async () => {
      (await owner.del('/v1/projects/:projectId/sessions/:sessionId', { params })).status(200).body().has('$.ok', true);
      (await anon.get('/v1/public/session-shares/:shareId', { params: { shareId: share.public_token } })).status(410);
      (await anon.get('/v1/public/session-shares/:shareId/messages', { params: { shareId: share.public_token } }))
        .status(410);
      (await anon.get('/v1/p/public-share/:token', { params: { token: share.public_token } })).status(410);
      const list = await owner.get(sharesRoute, { params });
      list.status(200);
      const shares = list.json<{ shares: Share[] }>().shares;
      const live = shares.filter((s) => !s.revoked_at);
      if (shares.length === 0 || live.length !== 0) {
        throw new Error(`the delete did not revoke every share: ${JSON.stringify(shares)}`);
      }
    });

    await ctx.step('the delete keeps the session row and its branch, stopped and tombstoned; an unknown session → 404', async () => {
      const { Client } = await import('pg');
      const databaseUrl = ctx.env.databaseUrl as string;
      const db = new Client({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
      await db.connect();
      try {
        const row = (
          await db.query<{ status: string; branch_name: string; deleted_at: string | null }>(
            `SELECT status::text AS status, branch_name, metadata->>'deletedAt' AS deleted_at FROM kortix.project_sessions WHERE session_id = $1`,
            [sessionId],
          )
        ).rows[0];
        if (!row || row.status !== 'stopped' || row.branch_name !== `session/${sessionId}` || !row.deleted_at) {
          throw new Error(`deleted session row: ${JSON.stringify(row)}`);
        }
      } finally {
        await db.end();
      }
      (await owner.del('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId: project.id, sessionId: crypto.randomUUID() } }))
        .status(404)
        .body()
        .has('$.error', 'Not found');
    });
  },
);

/**
 * SESS-51 — a deleted session is restorable for 30 days (KRTX-1734). Runs on
 * the local profile: the session is a database row with a saved transcript, a
 * stored file and a stopped sandbox. The local provider is unreachable, so the
 * delete's box removal stays unconfirmed until the step that records the
 * confirmation the provider would send (`markRemoved` in
 * reaping/archived-box-removal.ts).
 */
flow(
  'SESS-51',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/projects/:projectId/sessions/:sessionId/restore',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'GET /v1/projects/:projectId/sessions/:sessionId/message-authors',
      'GET /v1/projects/:projectId/sessions/:sessionId/model-usage',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/config',
      'GET /v1/projects/:projectId/sessions/:sessionId/log',
      'GET /v1/projects/:projectId/sessions/:sessionId/question',
      'POST /v1/projects/:projectId/sessions/:sessionId/attachments',
      'GET /v1/projects/:projectId/sessions/:sessionId/attachments/:attachmentId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    // An account admin manages every project: may restore what others deleted.
    const admin = await team.addMember('admin');
    const newSession = async () => {
      // Shared with the project: the member can open it, but only its owner
      // or a project manager may delete or restore it.
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility: 'project',
      });
      ctx.track('session', id, { projectId: project.id });
      await seedSessionTranscript(ctx.env, { projectId: project.id, accountId: team.id, sessionId: id });
      return id;
    };
    const sessionId = await newSession();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };
    const sessionRoute = '/v1/projects/:projectId/sessions/:sessionId';
    const restoreRoute = `${sessionRoute}/restore`;
    const attachmentId = crypto.randomUUID();
    const download = `${sessionRoute}/attachments/:attachmentId`;
    const contents = 'Files come back with a restored session.';
    const listed = async () =>
      (await owner.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id } }))
        .status(200)
        .json<Array<{ session_id: string }>>()
        .some((row) => row.session_id === sessionId);
    // Recently deleted (KRTX-2853): the deleted sessions this caller may restore.
    const deletedRow = async (who: ReturnType<typeof ctx.client.as>, id = sessionId) => {
      const r = await who.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { deleted: 'only' },
      });
      r.status(200).body().schema(ProjectSessionSchema.array());
      return r
        .json<Array<{ session_id: string; deleted_at?: string | null; deleted_by?: string | null; restore_until?: string | null }>>()
        .find((row) => row.session_id === id);
    };
    const sessionRows = async (id: string) => {
      const db = await openFlowDb(ctx.env);
      try {
        const session = (
          await db.query<{ status: string; branch_name: string; deleted_at: string | null; restored_at: string | null; log_messages: string }>(
            `SELECT status::text AS status, branch_name, metadata->>'deletedAt' AS deleted_at, metadata->>'restoredAt' AS restored_at,
                    (SELECT count(*) FROM kortix.session_log_messages m WHERE m.session_id = s.session_id AND m.deleted_at IS NULL) AS log_messages
               FROM kortix.project_sessions s WHERE session_id = $1`,
            [id],
          )
        ).rows[0];
        const sandbox = (
          await db.query<{ status: string; external_id: string | null; metadata: Record<string, unknown> }>(
            'SELECT status::text AS status, external_id, metadata FROM kortix.session_sandboxes WHERE session_id = $1',
            [id],
          )
        ).rows[0];
        return { session, sandbox };
      } finally {
        await db.end();
      }
    };

    await ctx.step('the owner stores a file in the session → 201', async () => {
      const body = new FormData();
      body.append('attachment_id', attachmentId);
      body.append('file', new Blob([contents], { type: 'text/plain' }), 'notes.txt');
      (await owner.request('POST', `${sessionRoute}/attachments`, { params, body })).status(201);
    });

    await ctx.step('the session stores a session log (via the journal route) and an open agent question (via the relay); both read while it is alive', async () => {
      // The log the box's own route wrote, the question the sandbox relay persisted —
      // both are session content (KRTX-2744), so their reads share the tombstone
      // refusal of the sibling reads.
      const journal = await owner.post('/v1/accounts/tokens', { name: 'SESS-51 journal credential' });
      journal.status(201);
      // The sandbox row exists (the seed above); the journal adds only its log.
      await seedSessionTranscript(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        sessionId,
        ensureSandbox: false,
        log: { bearer: journal.json<{ secret_key: string }>().secret_key },
      });
      (await owner.post(
        '/v1/projects/:projectId/turn-question',
        {
          session_id: sessionId,
          request_id: 'sess-51-open-question',
          questions: [
            {
              question: 'Which stored read should refuse a deleted session first?',
              header: 'Next step',
              options: [
                { label: 'The log read', description: 'Refuse the deleted session' },
                { label: 'The question read', description: 'Refuse too' },
              ],
              multiple: false,
              custom: true,
            },
          ],
        },
        { params: { projectId: project.id } },
      )).status(200);
      for (const who of [owner, ctx.client.as(member)]) {
        (await who.get(`${sessionRoute}/log`, { params })).status(200).body().has('$.messages.length', 2);
        (await who.get(`${sessionRoute}/question`, { params }))
          .status(200)
          .body()
          .has('$.question.request_id', 'sess-51-open-question');
      }
    });

    await ctx.step('a project member who did not start the session cannot delete it → 403, it stays listed', async () => {
      (await ctx.client.as(member).del(sessionRoute, { params }))
        .status(403)
        .body()
        .has('$.error', 'Only the session owner or a project manager can stop this session');
      if (!(await listed())) throw new Error('a refused delete hid the session');
    });

    let restoreUntil = '';
    await ctx.step('the owner deletes the session → 200 with restore_until, 30 days after the delete', async () => {
      const r = await owner.del(sessionRoute, { params });
      r.status(200).body().has('$.ok', true).schema(SessionDeleteResultSchema);
      restoreUntil = r.json<{ restore_until: string }>().restore_until;
      const { session } = await sessionRows(sessionId);
      if (!session?.deleted_at) throw new Error('the delete wrote no stamp');
      const window = Date.parse(restoreUntil) - Date.parse(session.deleted_at);
      if (window !== 30 * 86_400_000) throw new Error(`restore window is ${window} ms, not 30 days`);
    });

    await ctx.step('a repeated delete answers the same restore_until: the window does not move', async () => {
      (await owner.del(sessionRoute, { params })).status(200).body().has('$.restore_until', restoreUntil);
    });

    await ctx.step('deleted=only lists it for its owner and a manager, with deleted_at, deleted_by and restore_until; not for a member who cannot restore it', async () => {
      for (const who of [owner, ctx.client.as(admin)]) {
        const row = await deletedRow(who);
        if (!row) throw new Error('deleted=only does not list the deleted session');
        if (!row.deleted_at || row.deleted_by !== ctx.P.OWNER.userId || row.restore_until !== restoreUntil) {
          throw new Error(`deleted row: ${JSON.stringify(row)}`);
        }
      }
      if (await deletedRow(ctx.client.as(member))) throw new Error('a member who cannot restore it sees it under deleted=only');
    });

    await ctx.step('deleted=only does not combine with pinned or archived → 400', async () => {
      for (const view of ['pinned', 'archived']) {
        (await owner.get('/v1/projects/:projectId/sessions', {
          params: { projectId: project.id },
          query: { deleted: 'only', [view]: 'only' },
        })).status(400);
      }
    });

    await ctx.step('the deleted session is hidden: the list omits it, and a read of it or of its file → 404', async () => {
      if (await listed()) throw new Error('the session list still shows a deleted session');
      (await owner.get(sessionRoute, { params })).status(404);
      (await owner.get(download, { params: { ...params, attachmentId } })).status(404);
    });

    await ctx.step('its content reads → 404 for the owner and a member, as the read of it (KRTX-2275); a prompt → 409 Session is deleted', async () => {
      for (const who of [owner, ctx.client.as(member)]) {
        (await who.get(`${sessionRoute}/transcript`, { params, query: { shape: 'sync', history: 'true' } })).status(404);
        (await who.get(`${sessionRoute}/message-authors`, { params })).status(404);
        (await who.get(`${sessionRoute}/model-usage`, { params })).status(404);
        (await who.get(`${sessionRoute}/prompts`, { params })).status(404);
        (await who.get(`${sessionRoute}/config`, { params })).status(404);
      }
      (await owner.post(
        `${sessionRoute}/prompts`,
        { client_message_id: `sess-51-${crypto.randomUUID()}`, parts: [{ type: 'text', text: 'into a deleted session' }] },
        { params },
      )).status(409).body().has('$.error', 'Session is deleted');
    });

    await ctx.step('the stored log and the open question read nothing → 404 for the owner and a member, as the reads of it (KRTX-2744)', async () => {
      for (const who of [owner, ctx.client.as(member)]) {
        (await who.get(`${sessionRoute}/log`, { params })).status(404);
        (await who.get(`${sessionRoute}/question`, { params })).status(404);
      }
    });

    await ctx.step('a project member who did not start the session cannot restore it → 403, it stays deleted', async () => {
      (await ctx.client.as(member).post(restoreRoute, {}, { params }))
        .status(403)
        .body()
        .has('$.error', 'Only the session owner or a project manager can restore this session');
      if (await listed()) throw new Error('a refused restore listed the session');
    });

    // The local provider is unreachable, so the seeded box's removal stays
    // unconfirmed until the flow records it. A deployed provider answers for
    // the seeded box during the delete (or the restore), so its first restore is 200.
    const local = ctx.env.target === 'local';
    if (local) await ctx.step('while the provider has not confirmed the old box removed → 409 session_sandbox_removal_pending', async () => {
      (await owner.post(restoreRoute, {}, { params }))
        .status(409)
        .body()
        .has('$.code', 'session_sandbox_removal_pending');
      const { session, sandbox } = await sessionRows(sessionId);
      if (!session?.deleted_at || sandbox?.status !== 'archived' || sandbox.external_id !== sessionId) {
        throw new Error(`a refused restore changed the rows: ${JSON.stringify({ session, sandbox })}`);
      }
    });

    await ctx.step('the provider confirms the removal; restore → 200, the session is listed and readable again', async () => {
      if (local) {
        const db = await openFlowDb(ctx.env);
        try {
          await db.query(
            `UPDATE kortix.session_sandboxes
                SET metadata = (metadata - 'providerRemovalPendingAt' - 'providerRemovalAttempts' - 'providerRemovalRetryAfterAt' - 'providerRemovalError')
                               || jsonb_build_object('providerRemovedAt', now()::text)
              WHERE session_id = $1 AND status = 'archived'`,
            [sessionId],
          );
        } finally {
          await db.end();
        }
      }
      (await owner.post(restoreRoute, {}, { params })).status(200).body().has('$.ok', true);
      if (!(await listed())) throw new Error('the restored session is not listed');
      if (await deletedRow(owner)) throw new Error('the restored session is still under deleted=only');
      (await owner.get(sessionRoute, { params })).status(200).body().has('$.status', 'stopped').has('$.deleted_at', null);
    });

    await ctx.step('the branch is kept, and the old box is gone: the next start boots a fresh one', async () => {
      const { session, sandbox } = await sessionRows(sessionId);
      if (session?.branch_name !== `session/${sessionId}` || session.deleted_at !== null) {
        throw new Error(`restored session row: ${JSON.stringify(session)}`);
      }
      // A retired row: no external id, marked so the next open claims it and provisions.
      if (sandbox?.status !== 'stopped' || sandbox.external_id !== null || sandbox.metadata.ephemeralRetiredExternalId !== sessionId) {
        throw new Error(`restored sandbox row: ${JSON.stringify(sandbox)}`);
      }
    });

    await ctx.step('the fresh box gets the conversation back: the session is marked to restore from its session log at boot, and its saved transcript is that log', async () => {
      const { session } = await sessionRows(sessionId);
      // `restoredAt` turns KORTIX_SESSION_LOG_RESTORE on for this session's
      // boxes (`session-sandbox-env-build.ts`); the v1 mirror is converted so
      // the box has a log to restore from.
      if (!session?.restored_at || Number(session.log_messages) !== 2) {
        throw new Error(`restored session conversation: ${JSON.stringify(session)}`);
      }
    });

    await ctx.step('the saved transcript and the stored file read back intact', async () => {
      (await owner.get(`${sessionRoute}/transcript`, { params, query: { shape: 'sync', history: 'true' } }))
        .status(200)
        .body()
        .has('$.source', 'mirror')
        .has('$.message_count', 2)
        .schema(SessionTranscriptSyncEnvelopeSchema);
      const file = (await owner.get(download, { params: { ...params, attachmentId } })).status(200);
      if (file.text() !== contents) throw new Error('the restored file bytes differ');
    });

    await ctx.step('the restored session reads its stored log and its open question again — the reads refuse the tombstone, never a restored session', async () => {
      (await owner.get(`${sessionRoute}/log`, { params })).status(200).body().has('$.messages.length', 2);
      (await owner.get(`${sessionRoute}/question`, { params }))
        .status(200)
        .body()
        .has('$.question.request_id', 'sess-51-open-question');
    });

    await ctx.step('a second restore → 409 session_not_deleted; an unknown session → 404; a non-uuid id → 400', async () => {
      (await owner.post(restoreRoute, {}, { params })).status(409).body().has('$.code', 'session_not_deleted');
      (await owner.post(restoreRoute, {}, { params: { projectId: project.id, sessionId: crypto.randomUUID() } })).status(404);
      (await owner.post(restoreRoute, {}, { params: { projectId: project.id, sessionId: 'not-a-uuid' } })).status(400);
    });

    await ctx.step('a session deleted more than 30 days ago → 410 session_purged, stays deleted, and is not under deleted=only', async () => {
      const lateId = await newSession();
      const late = { projectId: project.id, sessionId: lateId };
      (await owner.del(sessionRoute, { params: late })).status(200);
      const db = await openFlowDb(ctx.env);
      try {
        await db.query(
          `UPDATE kortix.project_sessions SET metadata = metadata || jsonb_build_object('deletedAt', $2::text) WHERE session_id = $1`,
          [lateId, new Date(Date.now() - 31 * 86_400_000).toISOString()],
        );
      } finally {
        await db.end();
      }
      (await owner.post(restoreRoute, {}, { params: late })).status(410).body().has('$.code', 'session_purged');
      (await owner.get(sessionRoute, { params: late })).status(404);
      // Past its window it can no longer be restored, so it is not offered.
      if (await deletedRow(owner, lateId)) throw new Error('deleted=only lists a session past its restore window');
    });
  },
);

/**
 * SESS-53 — one session by id, in any project (KRTX-2316). A client that holds
 * only a session id (the SDK's `restartSandbox(id)`) reads it here instead of
 * walking every project's first sessions page. The answer is the project
 * route's own, except that a caller the project gate refuses gets the
 * unknown-id 404, not 403: the id alone never proves a session exists. Local
 * profile: database sessions.
 */
flow(
  'SESS-53',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'GET /v1/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const seed = async (visibility: 'private' | 'project') => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility,
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    // The private session first: the two after it are newer, so it is past a 2-row page.
    const privateId = await seed('private');
    const sharedId = await seed('project');
    await seed('private');
    const owner = ctx.client.as(ctx.P.OWNER);
    const byId = '/v1/sessions/:sessionId';
    const inProject = '/v1/projects/:projectId/sessions/:sessionId';

    await ctx.step('the first 2-row page of the list does not hold the oldest session', async () => {
      const rows = (await owner.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id }, query: { limit: '2' } }))
        .status(200)
        .json<Array<{ session_id: string }>>();
      if (rows.some((row) => row.session_id === privateId)) throw new Error('the oldest session is on the first page');
    });

    await ctx.step('the owner reads it by id → 200 with its project_id, the project route`s body', async () => {
      const r = await owner.get(byId, { params: { sessionId: privateId } });
      r.status(200).body().has('$.session_id', privateId).has('$.project_id', project.id).schema(ProjectSessionSchema);
      const same = (await owner.get(inProject, { params: { projectId: project.id, sessionId: privateId } })).status(200).json();
      if (JSON.stringify(r.json()) !== JSON.stringify(same)) throw new Error('the two routes answered different bodies');
    });

    await ctx.step('detail reads report the persisted runtime status, including after a restart', async () => {
      const { Client } = await import('pg');
      const database = new Client({ connectionString: ctx.env.databaseUrl ?? undefined });
      await database.connect();
      try {
        await database.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
           VALUES ($1::uuid, $1, $2, $3, 'active')`,
          [sharedId, team.id, project.id],
        );
        for (const status of ['active', 'stopped', 'active']) {
          await database.query('UPDATE kortix.session_sandboxes SET status = $2 WHERE session_id = $1', [sharedId, status]);
          (await owner.get(byId, { params: { sessionId: sharedId } })).status(200).body().has('$.runtime_status', status);
          (await owner.get(inProject, { params: { projectId: project.id, sessionId: sharedId } })).status(200).body().has('$.runtime_status', status);
        }
        (await owner.get(byId, { params: { sessionId: privateId } })).status(200).body().has('$.runtime_status', null);
      } finally {
        await database.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sharedId]);
        await database.end();
      }
    });

    await ctx.step('a project member reads a project-visible session by id → 200', async () => {
      (await ctx.client.as(member).get(byId, { params: { sessionId: sharedId } }))
        .status(200)
        .body()
        .has('$.project_id', project.id);
    });

    await ctx.step('the member never receives the owner`s private session → 404, as on the project route', async () => {
      (await ctx.client.as(member).get(byId, { params: { sessionId: privateId } })).status(404);
      (await ctx.client.as(member).get(inProject, { params: { projectId: project.id, sessionId: privateId } })).status(404);
    });

    await ctx.step('an unknown id → 404, a malformed id → 400, no token → 401', async () => {
      (await owner.get(byId, { params: { sessionId: crypto.randomUUID() } })).status(404);
      (await owner.get(byId, { params: { sessionId: 'not-a-session' } })).status(400);
      (await ctx.client.as(ctx.P.ANON).get(byId, { params: { sessionId: sharedId } })).status(401);
    });

    await ctx.step('a caller outside the account gets 404 by id, as for an unknown id; the project route answers 403', async () => {
      const outsider = ctx.client.as(ctx.P.NONMEMBER);
      (await outsider.get(byId, { params: { sessionId: sharedId } })).status(404);
      (await outsider.get(byId, { params: { sessionId: crypto.randomUUID() } })).status(404);
      (await outsider.get(inProject, { params: { projectId: project.id, sessionId: sharedId } })).status(403);
    });

    await ctx.step('a deleted session is gone by id → 404', async () => {
      (await owner.del(inProject, { params: { projectId: project.id, sessionId: sharedId } })).status(200);
      (await owner.get(byId, { params: { sessionId: sharedId } })).status(404);
    });
  },
);

/**
 * SESS-54 — a person pins a session to the top of their list or archives it
 * out of the list (KRTX-2418). Per person: a pin or an archive changes only the
 * caller's own list, and neither moves the session's `updated_at`. Local
 * profile: database sessions.
 */
flow(
  'SESS-54',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'PUT /v1/projects/:projectId/sessions/:sessionId/pin',
      'PUT /v1/projects/:projectId/sessions/:sessionId/archive',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/open-bundle',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/accounts/tokens',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const seed = async (visibility: 'private' | 'project' = 'project') => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility,
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    // Oldest first: the list serves them newest first, [s4, s3, s2, s1, private].
    const privateId = await seed('private');
    const s1 = await seed();
    const s2 = await seed();
    const s3 = await seed();
    const s4 = await seed();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = (sessionId: string) => ({ projectId: project.id, sessionId });
    const pin = (sessionId: string, pinned: boolean, who = owner) =>
      who.put('/v1/projects/:projectId/sessions/:sessionId/pin', { pinned }, { params: params(sessionId) });
    const archive = (sessionId: string, archived: boolean, who = owner) =>
      who.put('/v1/projects/:projectId/sessions/:sessionId/archive', { archived }, { params: params(sessionId) });
    type Row = { session_id: string; pinned_at?: string | null; archived_at?: string | null };
    const list = async (query: Record<string, string> = {}, who = owner) => {
      const r = (await who.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id }, query })).status(200);
      // The private session belongs to the owner alone and is not part of these checks.
      return { rows: r.json<Row[]>().filter((row) => row.session_id !== privateId), cursor: r.header('x-next-cursor') ?? null };
    };
    /** A 200 state body with these fields. */
    const state = async (pending: ReturnType<typeof pin>, expected: Partial<Row>) => {
      const body = (await pending).status(200).json<Row>();
      for (const [key, value] of Object.entries(expected)) {
        if (body[key as keyof Row] !== value) throw new Error(`${key}: got ${String(body[key as keyof Row])}, want ${String(value)}`);
      }
      return body;
    };
    const ids = (rows: Row[]) => rows.map((row) => row.session_id).join(',');
    const expectIds = (rows: Row[], expected: string[], what: string) => {
      if (ids(rows) !== expected.join(',')) throw new Error(`${what}: got [${ids(rows)}], want [${expected.join(',')}]`);
    };

    await ctx.step('the list carries the person`s pinned_at and archived_at, both null at first', async () => {
      const { rows } = await list();
      expectIds(rows, [s4, s3, s2, s1], 'the first list');
      for (const row of rows) {
        if (row.pinned_at !== null || row.archived_at !== null) throw new Error(`${row.session_id} is not null/null`);
      }
    });

    await ctx.step('PUT …/pin {pinned:true} → 200 pinned_at set; a repeat keeps the first pinned_at; the order stays', async () => {
      const first = await state(pin(s1, true), { archived_at: null });
      if (!first.pinned_at) throw new Error('no pinned_at');
      (await pin(s1, true)).status(200).body().has('$.pinned_at', first.pinned_at);
      expectIds((await list({ pinned: 'only' })).rows, [s1], 'pinned=only');
      const { rows } = await list();
      expectIds(rows, [s4, s3, s2, s1], 'a pin does not move the session');
      if (rows.find((row) => row.session_id === s1)?.pinned_at !== first.pinned_at) throw new Error('the list row has no pinned_at');
      (await owner.get('/v1/projects/:projectId/sessions/:sessionId', { params: params(s1) }))
        .status(200).body().has('$.pinned_at', first.pinned_at).has('$.archived_at', null);
      // The session open bundle serves the same row as the read by id.
      (await owner.get('/v1/projects/:projectId/sessions/:sessionId/open-bundle', { params: params(s1), query: { transcript: '0' } }))
        .status(200).body().has('$.session.pinned_at', first.pinned_at).has('$.session.archived_at', null);
    });

    await ctx.step('PUT …/archive {archived:true} → 200; the default list leaves it out, archived=only lists it', async () => {
      const r = await state(archive(s2, true), { pinned_at: null });
      if (!r.archived_at) throw new Error('no archived_at');
      expectIds((await list()).rows, [s4, s3, s1], 'the default list');
      expectIds((await list({ archived: 'only' })).rows, [s2], 'archived=only');
    });

    await ctx.step('another member`s list is unchanged: no pin, nothing archived', async () => {
      const { rows } = await list({}, ctx.client.as(member));
      expectIds(rows.filter((row) => row.session_id !== privateId), [s4, s3, s2, s1], 'the member`s list');
      if (rows.some((row) => row.pinned_at !== null || row.archived_at !== null)) throw new Error('the member sees the owner`s state');
      expectIds((await list({ pinned: 'only' }, ctx.client.as(member))).rows, [], 'the member`s pinned=only');
    });

    await ctx.step('archiving a pinned session unpins it; pinning an archived one unarchives it', async () => {
      (await archive(s1, true)).status(200).body().has('$.pinned_at', null);
      expectIds((await list({ pinned: 'only' })).rows, [], 'pinned=only after the archive');
      expectIds((await list({ archived: 'only' })).rows, [s2, s1], 'archived=only');
      const repinned = await state(pin(s1, true), { archived_at: null });
      if (!repinned.pinned_at) throw new Error('no pinned_at after the re-pin');
      expectIds((await list({ archived: 'only' })).rows, [s2], 'archived=only after the re-pin');
    });

    await ctx.step('a page stays full: with the 2 newest and the oldest archived, ?limit=2 → the 2 between and no cursor', async () => {
      (await archive(privateId, true)).status(200);
      (await archive(s4, true)).status(200);
      (await archive(s3, true)).status(200);
      (await archive(s2, false)).status(200).body().has('$.archived_at', null);
      const page = await list({ limit: '2' });
      expectIds(page.rows, [s2, s1], 'the default page');
      if (page.cursor) throw new Error('the last page carries a cursor');
      const first = await list({ archived: 'only', limit: '1' });
      expectIds(first.rows, [s4], 'archived=only page 1');
      if (!first.cursor) throw new Error('archived=only page 1 has no cursor');
      expectIds((await list({ archived: 'only', limit: '1', cursor: first.cursor })).rows, [s3], 'archived=only page 2');
    });

    await ctx.step('unpin and unarchive → 200 null/null; the list is whole again', async () => {
      (await pin(s1, false)).status(200).body().has('$.pinned_at', null).has('$.archived_at', null);
      (await archive(s4, false)).status(200);
      (await archive(s3, false)).status(200);
      expectIds((await list()).rows, [s4, s3, s2, s1], 'the restored list');
    });

    await ctx.step('pinned=only with archived=only → 400; a body without the flag → 400', async () => {
      (await owner.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id }, query: { pinned: 'only', archived: 'only' } })).status(400);
      (await owner.put('/v1/projects/:projectId/sessions/:sessionId/pin', {}, { params: params(s1) })).status(400);
      (await owner.put('/v1/projects/:projectId/sessions/:sessionId/archive', { archived: 'yes' }, { params: params(s1) })).status(400);
    });

    await ctx.step('a session the caller cannot see → 404; ANON → 401; outside the account → 403', async () => {
      (await pin(privateId, true, ctx.client.as(member))).status(404);
      (await pin(crypto.randomUUID(), true)).status(404);
      (await pin(s1, true, ctx.client.as(ctx.P.ANON))).status(401);
      (await archive(s1, true, ctx.client.as(ctx.P.NONMEMBER))).status(403);
    });

    await ctx.step('a deleted session cannot be pinned or archived → 404', async () => {
      (await owner.del('/v1/projects/:projectId/sessions/:sessionId', { params: params(s4) })).status(200);
      (await pin(s4, true)).status(404);
      (await archive(s4, true)).status(404);
    });

    const db = await openFlowDb(ctx.env);
    try {
      const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: ctx.P.OWNER });
      try {
        await ctx.step('a session`s own sandbox token is not a person → 403; its list carries no pinned_at', async () => {
          (await turn.sandbox.put('/v1/projects/:projectId/sessions/:sessionId/pin', { pinned: true }, { params: params(turn.sessionId) })).status(403);
          (await turn.sandbox.put('/v1/projects/:projectId/sessions/:sessionId/archive', { archived: true }, { params: params(turn.sessionId) })).status(403);
          const rows = (await turn.sandbox.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id } }))
            .status(200).json<Row[]>();
          if (rows.some((row) => 'pinned_at' in row || 'archived_at' in row)) throw new Error('a sandbox token got pin state');
          const archivedView = (await turn.sandbox.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id }, query: { archived: 'only' } }))
            .status(200).json<Row[]>();
          if (archivedView.length !== 0) throw new Error('a sandbox token has an archive');
        });
      } finally {
        await turn.cleanup();
      }
    } finally {
      await db.end();
    }
  },
);

/**
 * SESS-55 — a lost session continues on a new computer from its saved
 * conversation (KRTX-2419). The provider removed the box and no in-place
 * recovery answered, so the sandbox row is `stopped` with
 * `runtimeIdentityState: 'unavailable'`. `POST …/recover` retires the row (the
 * next `/start` boots a fresh box from the branch) and marks the session so
 * that box restores the conversation from the session log. Local profile:
 * database sessions; the provider confirmation is a row stamp, as in SESS-51.
 */
flow(
  'SESS-55',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/recover',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/accounts/tokens',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const ownerToken = (await owner.post('/v1/accounts/tokens', { name: 'SESS-55 journal' })).status(201).json<{ secret_key: string }>().secret_key;
    /** A session whose computer the provider lost. `transcript`: none, the v1 mirror, or the session log. */
    const lostSession = async (transcript: 'none' | 'mirror' | 'log', confirmed = true) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility: 'project',
      });
      ctx.track('session', id, { projectId: project.id });
      const db = await openFlowDb(ctx.env);
      try {
        if (transcript === 'none') {
          await db.query(
            "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id, base_url) VALUES ($1::uuid,$1,$2,$3,'stopped',$1,'http://127.0.0.1:1')",
            [id, team.id, project.id],
          );
        } else {
          await seedSessionTranscript(ctx.env, {
            projectId: project.id,
            accountId: team.id,
            sessionId: id,
            ...(transcript === 'log' ? { log: { bearer: ownerToken } } : {}),
          });
        }
        await db.query(
          `UPDATE kortix.session_sandboxes SET status = 'stopped', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'runtimeIdentityState', 'unavailable', 'runtimeUnavailableReason', 'runtime_removed', 'preservedExternalId', external_id)
             || CASE WHEN $2 THEN jsonb_build_object('providerRemovedAt', now()::text) ELSE '{}'::jsonb END
           WHERE session_id = $1`,
          [id, confirmed],
        );
      } finally {
        await db.end();
      }
      return id;
    };
    const rows = async (id: string) => {
      const db = await openFlowDb(ctx.env);
      try {
        const sandbox = (await db.query<{ status: string; external_id: string | null; metadata: Record<string, unknown> }>(
          'SELECT status::text AS status, external_id, metadata FROM kortix.session_sandboxes WHERE session_id = $1',
          [id],
        )).rows[0];
        const session = (await db.query<{ recovered: string | null }>(
          "SELECT metadata->>'lostRecoveredAt' AS recovered FROM kortix.project_sessions WHERE session_id = $1",
          [id],
        )).rows[0];
        const logMessages = Number((await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM kortix.session_log_messages WHERE session_id = $1 AND deleted_at IS NULL',
          [id],
        )).rows[0]?.n ?? 0);
        return { sandbox, recovered: session?.recovered ?? null, logMessages };
      } finally {
        await db.end();
      }
    };
    const recover = (id: string, who = owner) =>
      who.post('/v1/projects/:projectId/sessions/:sessionId/recover', {}, { params: { projectId: project.id, sessionId: id } });
    const transcriptMessages = async (id: string) =>
      (await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
        params: { projectId: project.id, sessionId: id },
        query: { shape: 'sync', history: 'true' },
      }))
        .status(200)
        .json<{ messages?: unknown[] }>().messages?.length ?? 0;

    const fromLog = await lostSession('log');
    await ctx.step('a lost session with a session log → 200; the row is retired and the session restores from its log', async () => {
      const before = await rows(fromLog);
      if (before.logMessages !== 2) throw new Error(`seeded log holds ${before.logMessages} messages`);
      (await recover(fromLog)).status(200).body().has('$.ok', true);
      const after = await rows(fromLog);
      if (after.sandbox?.status !== 'stopped' || after.sandbox.external_id !== null) {
        throw new Error(`the row is not retired: ${JSON.stringify(after.sandbox)}`);
      }
      if (after.sandbox.metadata.ephemeralRetiredExternalId !== fromLog) throw new Error('the retired row does not name the lost box');
      if ('runtimeIdentityState' in after.sandbox.metadata) throw new Error('the row still reads lost');
      if (!after.recovered) throw new Error('the session has no lostRecoveredAt');
      if (after.logMessages !== 2) throw new Error('the recover changed the log');
    });

    await ctx.step('a second recover → 409 session_not_lost', async () => {
      (await recover(fromLog)).status(409).body().has('$.code', 'session_not_lost');
    });

    await ctx.step('a lost session with only the v1 mirror → 200; the mirror becomes its session log and still reads', async () => {
      const fromMirror = await lostSession('mirror');
      if ((await rows(fromMirror)).logMessages !== 0) throw new Error('the mirror session already has a log');
      (await recover(fromMirror)).status(200);
      const after = await rows(fromMirror);
      if (after.logMessages !== 2 || after.sandbox?.external_id !== null || !after.recovered) {
        throw new Error(`mirror recover: ${JSON.stringify({ logMessages: after.logMessages, sandbox: after.sandbox, recovered: after.recovered })}`);
      }
      if ((await transcriptMessages(fromMirror)) !== 2) throw new Error('the transcript lost messages');
    });

    await ctx.step('a lost session with no saved conversation → 409 session_transcript_missing, nothing changes', async () => {
      const bare = await lostSession('none');
      (await recover(bare)).status(409).body().has('$.code', 'session_transcript_missing');
      const after = await rows(bare);
      if (after.sandbox?.external_id !== bare || after.sandbox.metadata.runtimeIdentityState !== 'unavailable' || after.recovered) {
        throw new Error(`the refused recover changed the session: ${JSON.stringify(after)}`);
      }
    });

    await ctx.step('a lost box the provider has not confirmed removed → 409 session_sandbox_removal_pending, nothing changes', async () => {
      const pending = await lostSession('mirror', false);
      (await recover(pending)).status(409).body().has('$.code', 'session_sandbox_removal_pending');
      const after = await rows(pending);
      if (after.sandbox?.external_id !== pending || after.sandbox.metadata.runtimeIdentityState !== 'unavailable' || after.recovered) {
        throw new Error(`the pending recover changed the session: ${JSON.stringify(after)}`);
      }
      if ((await transcriptMessages(pending)) !== 2) throw new Error('the transcript lost messages');
    });

    await ctx.step('a session that is only stopped → 409 session_not_lost; a member who did not start it → 403', async () => {
      const stopped = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project' });
      ctx.track('session', stopped, { projectId: project.id });
      await seedSessionTranscript(ctx.env, { projectId: project.id, accountId: team.id, sessionId: stopped });
      (await recover(stopped)).status(409).body().has('$.code', 'session_not_lost');
      const lost = await lostSession('log');
      (await recover(lost, ctx.client.as(member))).status(403);
      if ((await rows(lost)).sandbox?.external_id !== lost) throw new Error('the refused member recover changed the row');
    });

    await ctx.step('no token → 401; a deleted session → 404', async () => {
      const lost = await lostSession('log');
      (await recover(lost, ctx.client.as(ctx.P.ANON))).status(401);
      (await owner.del('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId: project.id, sessionId: lost } })).status(200);
      (await recover(lost)).status(404);
    });
  },
);

/**
 * SESS-17 — session preview candidates (projects/routes/public-shares.ts). A
 * human-friendly fallback list of preview ports/paths for a session; the
 * frontend passes its own active tab when it has one. Same visibility gate as
 * session detail (project read + `loadVisibleSession`).
 */
flow(
  'SESS-17',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/previews'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('list preview candidates → 200', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/previews', {
        params: { projectId: p.id, sessionId: s.id },
      });
      r.status(200).body().exists('$.candidates');
    });
    await ctx.step('non-uuid session id → 400', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/previews', {
        params: { projectId: p.id, sessionId: 'not-a-uuid' },
      });
      r.status(400);
    });
    await ctx.step('unknown session → 404', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/previews', {
        params: { projectId: p.id, sessionId: crypto.randomUUID() },
      });
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/sessions/:sessionId/previews', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(403);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sessions/:sessionId/previews', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(401);
    });
  },
);

// GET /v1/projects/:projectId/sessions returns a BARE ARRAY of sessions
// (project-sessions.ts declares `json(z.array(SessionSchema))` and returns
// `c.json(items.map(...))`). Read it the same way run-session-backlog.flow.ts
// does, so an envelope change cannot silently break the flow.
function sessionRows(response: { json<T>(): T }): any[] {
  const body = response.json<any>();
  const rows = Array.isArray(body) ? body : (body?.sessions ?? []);
  if (!Array.isArray(rows)) throw new Error('session list body is neither an array nor {sessions:[…]}');
  return rows;
}

flow(
  'SESS-18',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'PATCH /v1/projects/:projectId/experimental',
      'POST /v1/projects/:projectId/sessions/warm',
      'POST /v1/projects/:projectId/sessions/warm/claim',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    // A DEDICATED project, not the shard-wide shared one. The warm pool is
    // scoped by (accountId, projectId, createdBy) — warm-sessions.ts:66-89 — so
    // every `reused: false` assertion below is only deterministic when nothing
    // else can leave a warm row in this project. On a shared project a warm row
    // whose create response was lost to an edge-laundered 503 is never learned,
    // never tracked, never torn down, and the next `reused: false` reads `true`.
    const p = await ctx.fixtures.project({ seed: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    let warmSessionId = '';
    let replacementId = '';
    let replacementInsertedAt = '';

    await ctx.step('warming is disabled until the project explicitly opts in', async () => {
      const params = { projectId: p.id };
      const denied = await owner.post('/v1/projects/:projectId/sessions/warm', {}, { params });
      denied.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'warm_sessions');
      const enabled = await owner.patch(
        '/v1/projects/:projectId/experimental',
        { feature: 'warm_sessions', enabled: true },
        { params },
      );
      enabled.status(200);
    });

    await ctx.step('warming creates an ordinary session marked unused, in the contract shape', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        {},
        { params: { projectId: p.id } },
      );
      r.status(200)
        .body()
        .has('$.reused', false)
        .has('$.session.metadata.warm', true)
        .exists('$.session.session_id')
        .schema(WarmProjectSessionResultSchema);
      warmSessionId = r.json<any>().session.session_id;
      ctx.track('session', warmSessionId, { projectId: p.id });
    });

    await ctx.step('warming again returns the same unused session', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        {},
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.reused', true).has('$.session.session_id', warmSessionId);
    });

    // A warm session stays hidden from the visible list for as long as it
    // carries the marker, however live its box — the sidebar must not paint an
    // untitled "New session" row the user never started (2026-10-12 product
    // call, revisiting KRTX-1068). The manager `project` scope keeps the live
    // warm row listed so the billed box is seen and stopped there.
    await ctx.step('an unused warm session stays hidden from the visible list', async () => {
      const visible = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: p.id },
        query: { scope: 'visible' },
      });
      visible.status(200);
      const visibleIds = sessionRows(visible).map((s: any) => s.session_id);
      if (visibleIds.includes(warmSessionId)) {
        throw new Error('An unused warm session is listed in the visible session list');
      }
    });

    await ctx.step('the same session IS in the project-wide inventory', async () => {
      const all = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: p.id },
        query: { scope: 'project' },
      });
      all.status(200);
      const ids = sessionRows(all).map((s: any) => s.session_id);
      if (!ids.includes(warmSessionId)) {
        throw new Error('A warm session is missing from the manager inventory');
      }
    });

    await ctx.step('the unused auto-session reports ready before its first prompt', async () => {
      await waitFor(async () => {
        const response = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: p.id, sessionId: warmSessionId },
        });
        response.status(200);
        const session = response.json<{ status: string; error: string | null }>();
        if (session.status === 'failed') {
          throw new Error(`Warm session failed provisioning: ${session.error}`);
        }
        return session.status;
      }, {
        until: (status) => status === 'running',
        timeoutMs: 120_000,
        intervalMs: 2_000,
        description: 'unused warm session reaches running',
      });
    });

    await ctx.step('using the session drops the marker', async () => {
      // A claim needs a placed box. On Platinum the sandbox row gets its
      // region a few seconds after /warm, and until then the claim is 409.
      const claim = () => owner.post(
        '/v1/projects/:projectId/sessions/warm/claim',
        { session_id: warmSessionId },
        { params: { projectId: p.id } },
      );
      let r = await claim();
      for (let attempt = 0; r.statusCode === 409 && attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        r = await claim();
      }
      r.status(200).body().has('$.session_id', warmSessionId);
      if ((r.json<any>().metadata ?? {}).warm !== undefined) {
        throw new Error('The warm marker survived first use');
      }
    });

    await ctx.step('a used session appears in the visible list', async () => {
      const visible = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: p.id },
        query: { scope: 'visible' },
      });
      visible.status(200);
      const visibleIds = sessionRows(visible).map((s: any) => s.session_id);
      if (!visibleIds.includes(warmSessionId)) {
        throw new Error('A used session is still hidden from the visible session list');
      }
    });

    await ctx.step('a second use returns the stable conflict code', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm/claim',
        { session_id: warmSessionId },
        { params: { projectId: p.id } },
      );
      r.status(409).body().has('$.code', 'WARM_SESSION_ALREADY_CLAIMED');
    });

    await ctx.step('the next warm creates a replacement', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        {},
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.reused', false);
      replacementId = r.json<any>().session.session_id;
      replacementInsertedAt = r.json<any>().session.created_at;
      if (replacementId === warmSessionId) {
        throw new Error('The replacement reused the used session id');
      }
      ctx.track('session', replacementId, { projectId: p.id });
    });

    // The REAL adoption path. The browser never calls /warm/claim (deprecated):
    // a home send navigates to the warm session and fires POST /start, which
    // must drop the marker (listing the row) and stamp last_activity_at (so
    // the just-started session sorts as the newest, not at its create time).
    await ctx.step('adopting via POST /start drops the marker and stamps activity', async () => {
      // Adoption needs a placed box, like the claim above. Until the Platinum
      // sandbox row has its region, /start answers 200 `stage: provisioning`
      // with `sandbox: null` and keeps the marker (session-runtime.ts, the
      // warmSessionPlacement 'pending' branch). The browser re-polls /start;
      // so does this step, until the listed row has lost the marker.
      const startAndRead = async () => {
        const start = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          { params: { projectId: p.id, sessionId: replacementId } },
        );
        start.status(200);
        const visible = await owner.get('/v1/projects/:projectId/sessions', {
          params: { projectId: p.id },
          query: { scope: 'visible' },
        });
        visible.status(200);
        return sessionRows(visible).find((s: any) => s.session_id === replacementId);
      };
      let row = await startAndRead();
      // Since #9695 a warm session is hidden from the visible list until the
      // marker drops, so a provisioning adoption first reads as no row at all:
      // keep polling while the row is hidden too.
      for (let attempt = 0; (!row || (row.metadata ?? {}).warm !== undefined) && attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        row = await startAndRead();
      }
      if (!row) {
        throw new Error('An adopted warm session is still hidden from the visible session list');
      }
      if ((row.metadata ?? {}).warm !== undefined) {
        throw new Error('The warm marker survived adoption via POST /start');
      }
      if (typeof (row.metadata ?? {}).last_activity_at !== 'string') {
        throw new Error('Adoption did not stamp last_activity_at — the session sorts at create time');
      }
      // Adoption is the user-visible creation (#8953): one UPDATE stamps
      // created_at and last_activity_at with the same moment, after the warm
      // row's insert. updated_at is not asserted here: a concurrent lifecycle
      // writer can land a timestamp it took before adoption (seen on staging,
      // 1.85 s earlier). integration-warm-session-adopt.test.ts pins
      // adoption's own updated_at write.
      const lastActivityAtMs = Date.parse(row.metadata.last_activity_at);
      const createdAtMs = Date.parse(row.created_at);
      const insertedAtMs = Date.parse(replacementInsertedAt);
      if (
        !Number.isFinite(lastActivityAtMs) ||
        !Number.isFinite(insertedAtMs) ||
        createdAtMs !== lastActivityAtMs ||
        lastActivityAtMs <= insertedAtMs
      ) {
        throw new Error(
          `Adoption did not move created_at to the adoption moment ` +
            `(inserted=${replacementInsertedAt}, created_at=${row.created_at}, ` +
            `last_activity_at=${row.metadata.last_activity_at})`,
        );
      }
    });

    // The regression that shipped: after adoption, a later warm ensure handed
    // the SAME (now used) session back, so the next project-home send landed
    // its prompt inside an existing conversation.
    await ctx.step('a later warm ensure never returns the adopted session', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        {},
        { params: { projectId: p.id } },
      );
      r.status(200).body().has('$.reused', false);
      const nextId = r.json<any>().session.session_id;
      if (nextId === replacementId) {
        throw new Error('The warm ensure handed back a session that was already adopted');
      }
      ctx.track('session', nextId, { projectId: p.id });

      // JAY-596, pinned BEHAVIORALLY: a replenish carries the id it just
      // took as exclude_session_id, and the server must create a fresh
      // session instead of echoing the excluded one back — even though its
      // warm marker is still set at that moment. `nextId` is exactly such a
      // still-markered, would-be-reused candidate.
      const excluded = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        { exclude_session_id: nextId },
        { params: { projectId: p.id } },
      );
      excluded.status(200).body().has('$.reused', false);
      const freshId = excluded.json<any>().session.session_id;
      if (freshId === nextId) {
        throw new Error('exclude_session_id was ignored — the excluded warm session came back');
      }
      ctx.track('session', freshId, { projectId: p.id });
    });
  },
);

flow(
  'SESS-28',
  {
    domain: 'sessions',
    requires: ['sandbox', 'funded'],
    timeoutMs: 600_000,
    routes: [
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'POST /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'PATCH /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
    ],
  },
  async (ctx) => {
    const { waitFor } = await import('../core/poll');
    const project = await ctx.fixtures.project({ managedGit: true, seed: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    let restrictedSessionId = '';
    for (const access of [false, true]) {
      await ctx.step(`create repository_access=${access} session and prove checkout plus session-token authorization`, async () => {
        const config = await owner.put('/v1/projects/:projectId/agents/:agentName/config', {
          repository_access: access,
          kortix_permissions: ['project.file.read', 'project.gitops.read'],
        }, { params: { projectId: project.id, agentName: 'kortix' } });
        config.status(200);
        const created = await owner.post('/v1/projects/:projectId/sessions', {
          agent_name: 'kortix', metadata: { repository_access: !access, workspace_mode: access ? 'runtime' : 'branch' },
        }, { params: { projectId: project.id } });
        created.status(201);
        const sessionId = created.json<any>().session_id;
        if (!sessionId) throw new Error('session create returned no session_id');
        ctx.track('session', sessionId, { projectId: project.id });
        if (!access) restrictedSessionId = sessionId;
        const params = { projectId: project.id, sessionId };
        const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId', { params });
        read.status(200).body().has('$.metadata.repository_access', access)
          .has('$.metadata.workspace_mode', access ? 'branch' : 'runtime');
        const patch = await owner.patch('/v1/projects/:projectId/sessions/:sessionId', {
          metadata: { repository_access: !access },
        }, { params });
        patch.status(400);
        const ready = await waitFor(async () => {
          const response = await owner.post('/v1/projects/:projectId/sessions/:sessionId/start', {},
            { params, query: { wait_ms: '8000' }, timeoutMs: 25_000 });
          response.status(200);
          const body = response.json<any>();
          if (body.stage === 'error' && body.retriable === false) throw new Error(JSON.stringify(body));
          return body;
        }, { until: (body) => body.stage === 'ready' && Boolean(body.sandbox?.external_id ?? body.sandbox?.externalId),
          timeoutMs: 240_000, intervalMs: 3000, description: 'repository policy session ready' });
        const externalId = ready.sandbox.external_id ?? ready.sandbox.externalId;
        // Only status codes and checkout state leave the sandbox. Its credential stays inside it.
        const script = `const fs = require("node:fs");
const expected = ${access};
const checkout = fs.existsSync("/workspace/.git");
if (checkout !== expected) throw new Error("unexpected checkout: " + checkout);
const base = process.env.KORTIX_API_URL.replace(/\\/$/, "");
const headers = { Authorization: "Bearer " + process.env.KORTIX_TOKEN };
const files = await fetch(base + "/projects/${project.id}/files", { headers });
if (files.status !== (expected ? 200 : 403)) throw new Error("file status: " + files.status);
await files.body?.cancel();
const git = await fetch(base + "/git/${project.id}.git/info/refs?service=git-upload-pack", { headers });
if (git.status !== (expected ? 200 : 403)) throw new Error("git status: " + git.status);
await git.body?.cancel();
console.log(JSON.stringify({ checkout, files: files.status, git: git.status }));`;
        const command = `bun -e '${script.replace(/'/g, "'\\''")}'`;
        const execution = await owner.post(`/v1/p/${externalId}/8000/kortix/env-rpc`,
          { op: 'exec', args: { command, timeout: 30_000 } }, { timeoutMs: 40_000 });
        execution.status(200).body().has('$.ok', true).has('$.value.exitCode', 0);
        const proof = JSON.parse(execution.json<any>().value.stdout.trim());
        if (proof.checkout !== access || proof.files !== (access ? 200 : 403) || proof.git !== (access ? 200 : 403)) {
          throw new Error(`unexpected repository proof: ${JSON.stringify(proof)}`);
        }
      });
    }
    await ctx.step('changing the agent to enabled leaves its existing restricted session restricted', async () => {
      const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: restrictedSessionId },
      });
      read.status(200).body().has('$.metadata.repository_access', false).has('$.metadata.workspace_mode', 'runtime');
    });
  },
);


flow(
  'SESS-29',
  {
    domain: 'sessions',
    global: true,
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts/hold',
      'GET /v1/projects/:projectId/sessions/:sessionId/scope',
      'PUT /v1/projects/:projectId/sessions/:sessionId/scope',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const { randomUUID } = await import('node:crypto');
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    const team = await ctx.fixtures.team();
    await db.connect();
    const sessionId = randomUUID();
    const commandId = randomUUID();
    try {
      await db.query(
        `INSERT INTO kortix.credit_accounts
         (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
         VALUES ($1, 1000, 1000, 1000, 1000, 'tier_2_20')
         ON CONFLICT (account_id) DO UPDATE SET
           balance = 1000, balance_precise = 1000,
           non_expiring_credits = 1000, non_expiring_credits_precise = 1000,
           tier = 'tier_2_20'`,
        [team.id],
      );
      const project = await team.project({ managedGit: true });
      const params = { projectId: project.id, sessionId };
      const promptPath = '/v1/projects/:projectId/sessions/:sessionId/prompts';
      await ctx.step(
        'seed a session whose required_connectors column still names an unconnected connector',
        async () => {
          const config = await owner.put(
            '/v1/projects/:projectId/agents/:agentName/config',
            { connectors: 'all', secrets: 'none', skills: 'all', kortix_permissions: 'all' },
            { params: { projectId: project.id, agentName: 'kortix' } },
          );
          config.status(200);
          // The column is populated and deliberately LEFT populated for the
          // whole flow. Proving a prompt is accepted while the stored value
          // still names an unconnected connector is stronger than clearing it
          // first: it pins that nothing reads the column, not that an empty
          // column is harmless.
          await db.query(
            `INSERT INTO kortix.project_sessions
        (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, required_connectors)
        VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'project', '["missing-gmail"]'::jsonb)`,
            [sessionId, team.id, project.id, ctx.P.OWNER.userId],
          );
        },
      );
      await ctx.step(
        'Stop holds an in-flight delivery immediately and GET preserves the hold',
        async () => {
          // A claimed row models the instant between worker claim and network send.
          // Its lease prevents the background worker from claiming the fixture.
          // It also holds every prompt queued after it, which is what keeps the
          // two acceptance steps below from reaching a runtime this flow never
          // provisions.
          await db.query(
            `INSERT INTO kortix.session_lifecycle_commands
        (command_id, command_type, source, status, project_id, session_id, account_id,
         actor_user_id, payload, locked_by, locked_until)
        VALUES ($1, 'continue_session', 'ui', 'running', $2, $3, $4, $5,
          '{"text":"hello","clientMessageId":"stop-running"}'::jsonb, 'SESS-29', now() + interval '1 hour')`,
            [commandId, project.id, sessionId, team.id, ctx.P.OWNER.userId],
          );
          const held = await owner.post(`${promptPath}/hold`, { held: true }, { params });
          held.status(200);
          for (const response of [held, await owner.get(promptPath, { params })]) {
            response.status(200).body().schema(SessionPromptListSchema);
            const mine = response.json<any>().prompts.find((p: any) => p.prompt_id === commandId);
            if (mine?.state !== 'waiting' || mine?.reason !== 'held')
              throw new Error(`Stop state: ${JSON.stringify(mine)}`);
          }
          const stored = await db.query(
            'SELECT result, payload FROM kortix.session_lifecycle_commands WHERE command_id = $1',
            [commandId],
          );
          if (!stored.rows[0]?.result.held || !stored.rows[0]?.payload.stopPausedOnDelivery)
            throw new Error('Stop did not persist both markers');
        },
      );
      await ctx.step(
        'a prompt is accepted 202 while the session still requires an unconnected connector',
        async () => {
          const accepted = await owner.post(
            promptPath,
            {
              client_message_id: 'unconnected-connector',
              message_id: 'msg_0123456789abAbCdEfGhIjKlMn',
              parts: [{ type: 'text', text: 'hello' }],
            },
            { params },
          );
          // 202, not 409. The pre-flight is gone: a turn is never refused for an
          // unconnected connector, because that refusal could not be cleared
          // from the product. The connector CALL denies instead and carries a
          // connect link.
          accepted.status(202).body().has('$.state', 'queued').schema(CreateSessionPromptResultSchema);
          const queued = await db.query(
            `SELECT command_id FROM kortix.session_lifecycle_commands
             WHERE session_id = $1 AND payload->>'clientMessageId' = 'unconnected-connector'`,
            [sessionId],
          );
          if (queued.rowCount !== 1) throw new Error('the accepted prompt was not persisted');
          const stored = await db.query(
            'SELECT required_connectors FROM kortix.project_sessions WHERE session_id = $1',
            [sessionId],
          );
          // Nothing cleared the column on the way through. The prompt was
          // accepted because no reader is left, which is the contract.
          if (
            JSON.stringify(stored.rows[0]?.required_connectors) !==
            JSON.stringify(['missing-gmail'])
          ) {
            throw new Error(`required_connectors changed: ${JSON.stringify(stored.rows[0])}`);
          }
          await db.query('DELETE FROM kortix.session_lifecycle_commands WHERE command_id = $1', [
            queued.rows[0].command_id,
          ]);
        },
      );
      await ctx.step(
        'PUT .../scope still accepts require_connectors and GET reports required_connectors: null',
        async () => {
          const replaced = await owner.put(
            '/v1/projects/:projectId/sessions/:sessionId/scope',
            { require_connectors: ['missing-gmail'] },
            { params },
          );
          // 200, not 400. `SessionScopeInputSchema` is `.strict()`, so an old
          // client that still sends the field would be rejected outright if the
          // key were deleted. It is accepted, inert, and answered with null.
          replaced.status(200).body().has('$.required_connectors', null);
          const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId/scope', {
            params,
          });
          // The key stays on the wire — `SessionScope` is a published
          // @kortix/sdk type and a consumer reading it must get null, not
          // undefined — and it never echoes back what the PUT sent.
          read.status(200).body().has('$.required_connectors', null);
        },
      );
      await ctx.step('a disabled optional connector binding does not hold a prompt either', async () => {
        const connector = await db.query(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, enabled)
           VALUES ($1, $2, 'optional-gmail', 'Optional Gmail', 'openapi', '{}'::jsonb, false)
           RETURNING connector_id`, [team.id, project.id],
        );
        const connection = await db.query(
          `INSERT INTO kortix.connector_connections (account_id, project_id, connector_id, owner_type, label)
           VALUES ($1, $2, $3, 'project', 'Optional Gmail') RETURNING connection_id`,
          [team.id, project.id, connector.rows[0].connector_id],
        );
        await db.query(
          `INSERT INTO kortix.project_session_connector_bindings
           (session_id, account_id, project_id, connector_alias, connector_id, connection_id)
           VALUES ($1, $2, $3, 'optional-gmail', $4, $5)`,
          [sessionId, team.id, project.id, connector.rows[0].connector_id, connection.rows[0].connection_id],
        );
        const accepted = await owner.post(
          promptPath,
          {
            client_message_id: 'optional-connector',
            message_id: 'msg_0123456789abAbCdEfGhIjKlMo',
            parts: [{ type: 'text', text: 'hello without Gmail' }],
          },
          { params },
        );
        accepted.status(202);
        const queued = await db.query(
          `SELECT command_id FROM kortix.session_lifecycle_commands
           WHERE session_id = $1 AND payload->>'clientMessageId' = 'optional-connector'`, [sessionId],
        );
        if (queued.rowCount !== 1) throw new Error('optional connector prompt was not persisted');
        // The fixture's claimed delivery prevents this row from reaching a runtime.
        await db.query('DELETE FROM kortix.session_lifecycle_commands WHERE command_id = $1', [queued.rows[0].command_id]);
      });
      await ctx.step('Resume clears both hold markers on a claimed delivery', async () => {
        const response = await owner.post(`${promptPath}/hold`, { held: false }, { params });
        response.status(200);
        const stored = await db.query(
          'SELECT result, payload FROM kortix.session_lifecycle_commands WHERE command_id = $1',
          [commandId],
        );
        if (stored.rows[0]?.result.held || stored.rows[0]?.payload.stopPausedOnDelivery)
          throw new Error('Resume left a hold marker');
      });
    } finally {
      await db
        .query('DELETE FROM kortix.session_lifecycle_commands WHERE session_id = $1', [sessionId])
        .catch(() => {});
      await db
        .query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId])
        .catch(() => {});
      await db.end();
    }
  },
);

flow(
  'SESS-34',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/turn'],
  },
  async (ctx) => {
    // A 2026-09-18 session: the sandbox memory guard stopped two turns and the
    // ledger dropped the reason, so the UI said nothing under four failed
    // sub-agent tasks. This pins what `/turn` reports about how turns died,
    // straight off seeded ledger rows: no runtime is needed to read history.
    const { randomUUID } = await import('node:crypto');
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    await db.connect();
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const sandboxId = randomUUID();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId: session.id };
    const turnPath = '/v1/projects/:projectId/sessions/:sessionId/turn';
    type Failure = { message_id: string; ended_at: string | null; error: { name: string | null; message: string | null } | null };
    type TurnBody = {
      turns: unknown[];
      last_ended?: { message_id?: string; end_reason: string | null; error?: unknown };
      recent_failures?: Failure[];
    };
    const GUARD = { name: 'SandboxMemoryGuard', message: 'sandbox memory at 97% (opencode 513 MB RSS of 3915 MB): turn stopped' };
    try {
      await ctx.step('seed one ledger row per way a turn can end', async () => {
        const rows: Array<[string, string, string, Record<string, unknown> | null, number]> = [
          // token suffix, end_reason, message_id, end_error, seconds ago (newest last)
          ['completed', 'completed', 'msg_fine', null, 90],
          // Ended before the end_error column existed (2026-08-21): a Stop and
          // an unexplained abort looked the same then, so it stays hidden.
          ['legacy', 'failed', 'msg_legacy', null, 60 * 60 * 24 * 400],
          // Ended after it: nobody said why, and the read must still say it died.
          ['unnamed', 'failed', 'msg_unnamed', null, 35],
          ['queue-interrupt', 'failed', 'msg_queue', { name: 'QueueInterrupt', message: null }, 70],
          ['user-stop', 'failed', 'msg_stop', { name: 'UserStop', message: null }, 60],
          ['box-gone', 'runtime_gone', 'msg_gone', null, 50],
          ['bare-abort', 'failed', 'msg_abort', { name: 'MessageAbortedError', message: 'Aborted' }, 40],
          ['memory', 'failed', 'msg_memory', GUARD, 30],
        ];
        for (const [suffix, endReason, messageId, endError, agoSeconds] of rows) {
          await db.query(
            `INSERT INTO kortix.session_turns
               (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id,
                message_id, state, end_reason, end_error, started_at, ended_at, created_at, updated_at)
             VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'ses_root', $6, 'ended', $7, $8::jsonb,
                     now() - ($9 || ' seconds')::interval, now() - ($9 || ' seconds')::interval, now(), now())`,
            [
              `${sandboxId}-${suffix}`,
              session.id,
              sandboxId,
              project.id,
              project.accountId,
              messageId,
              endReason,
              endError ? JSON.stringify(endError) : null,
              String(agoSeconds),
            ],
          );
        }
      });

      await ctx.step('the read lists the turns that died, newest first, names the cause it has, and matches the contract', async () => {
        const response = await owner.get(turnPath, { params });
        response.status(200).body().schema(SessionTurnStatusSchema);
        const body = response.json<TurnBody>();
        const listed = (body.recent_failures ?? []).map((f) => [f.message_id, f.error?.name ?? null]);
        const expected = [
          ['msg_memory', 'SandboxMemoryGuard'],
          ['msg_unnamed', null],
          ['msg_abort', null],
          ['msg_gone', null],
        ];
        if (JSON.stringify(listed) !== JSON.stringify(expected)) {
          throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(listed)}`);
        }
        const memory = body.recent_failures?.find((f) => f.message_id === 'msg_memory');
        if (memory?.error?.message !== GUARD.message) {
          throw new Error(`the named cause must carry its message, got ${JSON.stringify(memory)}`);
        }
        for (const f of body.recent_failures ?? []) {
          if (!f.ended_at || !/^\d{4}-\d{2}-\d{2}T/.test(f.ended_at)) {
            throw new Error(`every failure carries ended_at, got ${JSON.stringify(f)}`);
          }
        }
      });

      await ctx.step('a requested stop and a legacy row are never reported as failures', async () => {
        const body = (await owner.get(turnPath, { params })).json<TurnBody>();
        const ids = (body.recent_failures ?? []).map((f) => f.message_id);
        for (const hidden of ['msg_stop', 'msg_queue', 'msg_legacy', 'msg_fine']) {
          if (ids.includes(hidden)) throw new Error(`${hidden} must not be listed: ${JSON.stringify(ids)}`);
        }
      });

      await ctx.step('last_ended names its message and its cause', async () => {
        const body = (await owner.get(turnPath, { params })).json<TurnBody>();
        if (body.last_ended?.message_id !== 'msg_memory' || body.last_ended.end_reason !== 'failed') {
          throw new Error(`expected the memory turn as last_ended, got ${JSON.stringify(body.last_ended)}`);
        }
        if (JSON.stringify(body.last_ended.error) !== JSON.stringify(GUARD)) {
          throw new Error(`last_ended.error must be the named cause, got ${JSON.stringify(body.last_ended.error)}`);
        }
      });

      await ctx.step('a requested stop is not an error on last_ended either', async () => {
        await db.query(
          `INSERT INTO kortix.session_turns
             (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id,
              message_id, state, end_reason, end_error, started_at, ended_at, created_at, updated_at)
           VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'ses_root', 'msg_stop_2', 'ended', 'failed',
                   '{"name":"UserStop","message":null}'::jsonb, now(), now(), now(), now())`,
          [`${sandboxId}-user-stop-2`, session.id, sandboxId, project.id, project.accountId],
        );
        const body = (await owner.get(turnPath, { params })).json<TurnBody>();
        if (body.last_ended?.message_id !== 'msg_stop_2') {
          throw new Error(`expected the stopped turn as last_ended, got ${JSON.stringify(body.last_ended)}`);
        }
        if ('error' in body.last_ended) {
          throw new Error(`a requested stop must carry no error, got ${JSON.stringify(body.last_ended)}`);
        }
      });
    } finally {
      await db
        .query('DELETE FROM kortix.session_turns WHERE session_id = $1', [session.id])
        .catch(() => {});
      await db.end();
    }
  },
);


flow(
  'SESS-35',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/turn-stream',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
    ],
  },
  async (ctx) => {
    // Prod 2026-09-22: the memory guard stopped a turn three times and the UI
    // said "No reason was reported". The sandbox ran a daemon built before the
    // guard named its turn: its cause frame has no `turn_message_id` and says
    // `error_retryable: true`. The control plane must still attach it.
    const { randomUUID } = await import('node:crypto');
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    await db.connect();
    const project = await ctx.fixtures.project();
    const ownerUserId = ctx.P.OWNER.userId;
    if (!ownerUserId) throw new Error('OWNER principal has no userId');
    const owner = ctx.client.as(ctx.P.OWNER);
    const sessionId = randomUUID();
    let tokenId: string | null = null;
    let sandbox = ctx.client;
    const GUARD_MESSAGE =
      'sandbox memory at 92% (opencode 701 MB RSS of 12288 MB): turn stopped before the kernel would kill opencode';
    type Failure = { message_id: string; error: { name: string | null; message: string | null } | null };
    const failures = async () =>
      (
        await owner.get('/v1/projects/:projectId/sessions/:sessionId/turn', {
          params: { projectId: project.id, sessionId },
        })
      )
        .status(200)
        .json<{ recent_failures?: Failure[] }>().recent_failures ?? [];
    const insertEndedTurn = (suffix: string, messageId: string, endError: Record<string, unknown>) =>
      db.query(
        `INSERT INTO kortix.session_turns
           (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id,
            message_id, state, end_reason, end_error, started_at, ended_at, created_at, updated_at)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'ses_root', $6, 'ended', 'failed', $7::jsonb,
                 now() - interval '40 seconds', now() - interval '1 second', now(), now())`,
        [`${sessionId}-${suffix}`, sessionId, sessionId, project.id, project.accountId, messageId, JSON.stringify(endError)],
      );
    const oldDaemonGuardFrame = () =>
      sandbox.post(
        '/v1/projects/:projectId/turn-stream',
        {
          session_id: sessionId,
          kind: 'end',
          status: 'error',
          opencode_session_id: 'ses_root',
          error_name: 'SandboxMemoryGuard',
          error_message: GUARD_MESSAGE,
          error_retryable: true,
        },
        { params: { projectId: project.id } },
      );
    try {
      await ctx.step('seed a running session, its sandbox, and a sandbox-bound token', async () => {
        const minted = await owner.post('/v1/accounts/tokens', { name: `SESS-35 ${sessionId.slice(0, 8)}` });
        minted.status(201);
        const credential = minted.json<{ token_id: string; secret_key: string }>();
        tokenId = credential.token_id;
        sandbox = ctx.client.withBearer(credential.secret_key, 'SESSION_TOKEN');
        await db.query(
          `INSERT INTO kortix.project_sessions
             (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
           VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'project')`,
          [sessionId, project.accountId, project.id, ownerUserId],
        );
        await db.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
           VALUES ($1::uuid, $1, $2, $3, 'active')`,
          [sessionId, project.accountId, project.id],
        );
        await db.query(
          `UPDATE kortix.account_tokens
              SET account_id = $2, user_id = $3, project_id = $4, session_id = $5
            WHERE token_id = $1`,
          [tokenId, project.accountId, ownerUserId, project.id, sessionId],
        );
      });

      await ctx.step('a turn the abort just closed reads as a bare abort, with no cause', async () => {
        await insertEndedTurn('aborted', 'msg_aborted', { name: 'MessageAbortedError', message: 'Aborted' });
        const listed = (await failures()).find((f) => f.message_id === 'msg_aborted');
        if (!listed || listed.error !== null) {
          throw new Error(`expected msg_aborted listed with error null, got ${JSON.stringify(listed)}`);
        }
      });

      await ctx.step('the old daemon guard frame (no turn id, retryable) is accepted with 200', async () => {
        (await oldDaemonGuardFrame()).status(200);
      });

      await ctx.step('the aborted turn now names the memory guard and its message', async () => {
        const listed = (await failures()).find((f) => f.message_id === 'msg_aborted');
        if (listed?.error?.name !== 'SandboxMemoryGuard' || listed.error.message !== GUARD_MESSAGE) {
          throw new Error(`expected the guard cause on msg_aborted, got ${JSON.stringify(listed)}`);
        }
      });

      await ctx.step('a stop the user asked for is never turned into a memory failure', async () => {
        await insertEndedTurn('user-stop', 'msg_user_stop', { name: 'UserStop', message: null });
        (await oldDaemonGuardFrame()).status(200);
        const ids = (await failures()).map((f) => f.message_id);
        if (ids.includes('msg_user_stop')) {
          throw new Error(`a requested stop must stay hidden, got ${JSON.stringify(ids)}`);
        }
      });
    } finally {
      await db.query('DELETE FROM kortix.session_turns WHERE session_id = $1', [sessionId]).catch(() => {});
      await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [sessionId]).catch(() => {});
      await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]).catch(() => {});
      if (tokenId) await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]).catch(() => {});
      await db.end();
    }
  },
);

/**
 * SESS-37 — the session list's tree and starter filters (KRTX-639). A trigger
 * coordinator's workers must never drown a member's own chats, and search must
 * reach every session the viewer may see, not only the loaded page.
 */
flow(
  'SESS-37',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const seed = async (input: Omit<Parameters<typeof createDatabaseSession>[1], 'projectId' | 'accountId'>) => {
      const id = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, ...input });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const factory = { type: 'trigger' as const, id: 'software-factory' };
    const coordinator = await seed({
      userId: ctx.P.OWNER.userId!,
      visibility: 'project',
      initiator: factory,
      metadata: { source: 'trigger:manual', name: 'Factory intake' },
    });
    await seed({ userId: ctx.P.OWNER.userId!, visibility: 'project', parentSessionId: coordinator, initiator: factory, metadata: { source: 'agent', name: 'Fix login bug' } });
    await seed({ userId: ctx.P.OWNER.userId!, visibility: 'project', parentSessionId: coordinator, initiator: factory, metadata: { source: 'agent', name: 'Ledger probe' } });
    const myChat = await seed({ userId: ctx.P.OWNER.userId!, metadata: { source: 'ui', custom_name: 'Apartment rent research' } });
    await seed({ userId: ctx.P.OWNER.userId!, parentSessionId: myChat, metadata: { source: 'agent', name: 'Helper' } });
    const memberChat = await seed({ userId: member.userId!, visibility: 'project', metadata: { source: 'ui', name: 'Teammate plan' } });

    const owner = ctx.client.as(ctx.P.OWNER);
    const route = '/v1/projects/:projectId/sessions';
    const params = { projectId: project.id };
    type Row = {
      session_id: string;
      parent_session_id: string | null;
      initiator: { type: string; id: string | null; label: string | null } | null;
      child_count?: number;
      search_match?: 'self' | 'child';
    };
    const rows = async (as: typeof owner, query: Record<string, string>) => {
      const r = await as.get(route, { params, query });
      r.status(200);
      return r.json<Row[]>();
    };
    const expectIds = (got: Row[], want: string[], what: string) => {
      const ids = got.map((row) => row.session_id);
      if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(ids)}, want ${JSON.stringify(want)}`);
    };

    await ctx.step('started_by=me with parent=root lists only the OWNER’s own chat, with its child count', async () => {
      const got = await rows(owner, { parent: 'root', started_by: 'me' });
      expectIds(got, [myChat], 'mine');
      if (got[0]!.child_count !== 1) throw new Error(`child_count ${got[0]!.child_count}`);
      if (got[0]!.initiator?.type !== 'member' || got[0]!.initiator.id !== ctx.P.OWNER.userId) throw new Error('mine initiator');
    });

    await ctx.step('started_by=automated lists the trigger coordinator, labelled by its slug, and none of its workers', async () => {
      const got = await rows(owner, { parent: 'root', started_by: 'automated' });
      expectIds(got, [coordinator], 'automated');
      if (got[0]!.child_count !== 2) throw new Error(`child_count ${got[0]!.child_count}`);
      if (got[0]!.initiator?.label !== 'software-factory') throw new Error(`label ${got[0]!.initiator?.label}`);
    });

    await ctx.step('parent=<coordinator> lists its two workers, each attributed to the trigger', async () => {
      const got = await rows(owner, { parent: coordinator });
      if (got.length !== 2) throw new Error(`workers ${got.length}`);
      for (const row of got) {
        if (row.parent_session_id !== coordinator) throw new Error('worker parent');
        if (row.initiator?.type !== 'trigger') throw new Error('worker initiator');
      }
    });

    await ctx.step('started_by=others lists the MEMBER’s shared chat', async () => {
      expectIds(await rows(owner, { parent: 'root', started_by: 'others' }), [memberChat], 'others');
    });

    await ctx.step('q searches server-side: a title match is `self`, a worker match returns its coordinator as `child`', async () => {
      const own = await rows(owner, { parent: 'root', q: 'APARTMENT rent' });
      expectIds(own, [myChat], 'q self');
      if (own[0]!.search_match !== 'self') throw new Error('search_match self');
      const viaWorker = await rows(owner, { parent: 'root', q: 'ledger' });
      expectIds(viaWorker, [coordinator], 'q child');
      if (viaWorker[0]!.search_match !== 'child') throw new Error('search_match child');
      if ((await rows(owner, { parent: coordinator, q: 'ledger' })).length !== 1) throw new Error('q children');
    });

    await ctx.step('the MEMBER’s search never reaches the OWNER’s private chat', async () => {
      const asMember = ctx.client.as(member);
      expectIds(await rows(asMember, { parent: 'root', q: 'apartment' }), [], 'member q');
      expectIds(await rows(asMember, { parent: 'root', started_by: 'me' }), [memberChat], 'member mine');
    });

    await ctx.step('an unknown started_by, or a q over 200 characters → 400', async () => {
      (await owner.get(route, { params, query: { started_by: 'robots' } })).status(400);
      (await owner.get(route, { params, query: { q: 'x'.repeat(201) } })).status(400);
    });

    await ctx.step('without the new params the list stays the flat legacy list (old clients)', async () => {
      const flat = await rows(owner, {});
      if (flat.length !== 6) throw new Error(`flat ${flat.length}`);
    });
  },
);

/**
 * SESS-38 — Session labels and client metadata. Labels are a free-form list a
 * member, an agent or an SDK caller sets at create or with PATCH, and the list
 * filters on server-side. Client metadata is a free-form object PATCH merges
 * per key; a `null` value removes the key.
 */
flow(
  'SESS-38',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'PATCH /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const seed = async (input: Omit<Parameters<typeof createDatabaseSession>[1], 'projectId' | 'accountId'>) => {
      const id = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, ...input });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const coordinator = await seed({ userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name: 'Coordinator' } });
    const worker = await seed({ userId: ctx.P.OWNER.userId!, visibility: 'project', parentSessionId: coordinator, metadata: { source: 'agent', name: 'Worker' } });
    const shared = await seed({ userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name: 'Shared' } });
    const secret = await seed({ userId: ctx.P.OWNER.userId! });

    const owner = ctx.client.as(ctx.P.OWNER);
    const list = '/v1/projects/:projectId/sessions';
    const one = '/v1/projects/:projectId/sessions/:sessionId';
    const params = { projectId: project.id };
    type Row = { session_id: string; labels: string[]; metadata: Record<string, unknown>; search_match?: string };
    const patch = (as: typeof owner, sessionId: string, body: unknown) => as.patch(one, body, { params: { ...params, sessionId } });
    const ids = async (as: typeof owner, query: string) => {
      const r = await as.get(`${list}?${query}`, { params });
      r.status(200).body().schema(ProjectSessionSchema.array());
      return r.json<Row[]>().map((row) => row.session_id).sort();
    };
    const expectIds = (got: string[], want: string[], what: string) => {
      if (JSON.stringify(got) !== JSON.stringify([...want].sort())) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };

    await ctx.step('PATCH labels trims each label, drops duplicates, keeps order, and answers the saved list', async () => {
      const r = await patch(owner, coordinator, { labels: [' bug ', 'urgent', 'bug', 'customer: acme/eu'] });
      r.status(200);
      const labels = r.json<Row>().labels;
      if (JSON.stringify(labels) !== JSON.stringify(['bug', 'urgent', 'customer: acme/eu'])) throw new Error(`labels ${JSON.stringify(labels)}`);
    });

    await ctx.step('PATCH metadata merges free-form keys and leaves labels and system keys alone', async () => {
      const r = await patch(owner, coordinator, { metadata: { ticket: 'T-1', priority: 2, ui: { color: 'red' } } });
      r.status(200);
      const row = r.json<Row>();
      if (row.metadata.ticket !== 'T-1' || row.metadata.priority !== 2) throw new Error(`metadata ${JSON.stringify(row.metadata)}`);
      if ((row.metadata.ui as { color?: string })?.color !== 'red') throw new Error('nested metadata');
      if (row.metadata.name !== 'Coordinator') throw new Error('system key lost');
      if (row.labels.length !== 3) throw new Error('labels changed by a metadata PATCH');
    });

    await ctx.step('a null metadata value removes that key; GET reads back labels and metadata in the contract shape', async () => {
      (await patch(owner, coordinator, { metadata: { priority: null } })).status(200);
      const r = await owner.get(one, { params: { ...params, sessionId: coordinator } });
      r.status(200).body().schema(ProjectSessionSchema);
      const row = r.json<Row>();
      if ('priority' in row.metadata) throw new Error(`priority kept: ${JSON.stringify(row.metadata)}`);
      if (row.metadata.ticket !== 'T-1') throw new Error('ticket lost');
      if (!row.labels.includes('urgent')) throw new Error('labels not read back');
    });

    await ctx.step('?label= filters server-side; repeated labels AND together; an unknown label lists nothing', async () => {
      (await patch(owner, shared, { labels: ['bug'] })).status(200);
      (await patch(owner, secret, { labels: ['bug'] })).status(200);
      (await patch(owner, worker, { labels: ['worker'] })).status(200);
      expectIds(await ids(owner, 'label=bug'), [coordinator, shared, secret], 'bug');
      expectIds(await ids(owner, 'label=bug&label=urgent'), [coordinator], 'bug+urgent');
      expectIds(await ids(owner, `label=${encodeURIComponent('customer: acme/eu')}`), [coordinator], 'free-form label');
      expectIds(await ids(owner, 'label=nope'), [], 'unknown');
    });

    await ctx.step('a flat list filtered by label never adds an unlabeled coordinator as tree context', async () => {
      expectIds(await ids(owner, 'label=worker'), [worker], 'flat worker');
    });

    await ctx.step('with parent=root a label on a worker lists its coordinator, like q', async () => {
      expectIds(await ids(owner, 'parent=root&label=worker'), [coordinator], 'root via child');
      expectIds(await ids(owner, `parent=${coordinator}&label=worker`), [worker], 'children');
    });

    await ctx.step('q matches a label', async () => {
      expectIds(await ids(owner, 'parent=root&q=URGENT'), [coordinator], 'q label');
    });

    await ctx.step('the MEMBER filters by label but never sees the OWNER’s private session', async () => {
      expectIds(await ids(ctx.client.as(member), 'label=bug'), [coordinator, shared], 'member');
    });

    await ctx.step('the MEMBER may label a session it can see, like a rename', async () => {
      const r = await patch(ctx.client.as(member), shared, { labels: ['bug', 'triaged'] });
      r.status(200);
      if (!r.json<Row>().labels.includes('triaged')) throw new Error('member label');
    });

    await ctx.step('invalid labels and oversized metadata → 400, nothing saved', async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => `l${i}`);
      (await patch(owner, shared, { labels: tooMany })).status(400);
      (await patch(owner, shared, { labels: ['x'.repeat(65)] })).status(400);
      (await patch(owner, shared, { labels: ['  '] })).status(400);
      (await patch(owner, shared, { labels: 'bug' })).status(400);
      (await patch(owner, shared, { labels: [1] })).status(400);
      (await patch(owner, shared, { metadata: { blob: 'x'.repeat(16_385) } })).status(400);
      (await owner.get(`${list}?label=${'x'.repeat(65)}`, { params })).status(400);
      (await owner.post(list, { labels: tooMany }, { params })).status(400);
      const r = await owner.get(one, { params: { ...params, sessionId: shared } });
      if (JSON.stringify(r.json<Row>().labels) !== JSON.stringify(['bug', 'triaged'])) throw new Error('invalid PATCH wrote');
      if ('blob' in r.json<Row>().metadata) throw new Error('oversized metadata wrote');
    });

    await ctx.step('PATCH labels [] clears them', async () => {
      const r = await patch(owner, shared, { labels: [] });
      r.status(200);
      if (r.json<Row>().labels.length !== 0) throw new Error('labels not cleared');
    });

    await ctx.step('PATCH name stores an explicit override: name and custom_name answer it, and an empty name clears it back to the auto title', async () => {
      (await patch(owner, shared, { name: 'Human name', metadata: { custom: 'ok' } }))
        .status(200)
        .body()
        .has('$.name', 'Human name')
        .has('$.custom_name', 'Human name')
        .has('$.metadata.custom_name', 'Human name')
        .has('$.metadata.custom', 'ok')
        .has('$.metadata.name', 'Shared');
      (await owner.get(one, { params: { ...params, sessionId: shared } })).status(200).body().has('$.name', 'Human name').has('$.custom_name', 'Human name');
      (await patch(owner, shared, { name: '' })).status(200).body().has('$.name', 'Shared').has('$.custom_name', null);
    });

    await ctx.step('the project-wide inventory names each row owner and its access', async () => {
      const r = await owner.get(`${list}?scope=project`, { params });
      r.status(200);
      const row = r.json<Array<Record<string, unknown>>>().find((s) => s.session_id === coordinator);
      if (!row) throw new Error('the coordinator is missing from the project inventory');
      const want = { owner_email: ctx.P.OWNER.email, owner_type: 'user', can_access: true, runtime_status: null, deleted_at: null, deleted_by: null };
      for (const [key, value] of Object.entries(want)) {
        if (row[key] !== value) throw new Error(`inventory ${key}: got ${JSON.stringify(row[key])}, want ${JSON.stringify(value)}`);
      }
    });
  },
);

/**
 * SESS-40 — browser tab presence lease (KRTX-588). A visible tab renews a
 * 90-second lease; hiding the tab clears it. Only a human login may hold one.
 */
flow(
  'SESS-40',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['PUT /v1/projects/:projectId/sessions/:sessionId/presence'],
  },
  async (ctx) => {
    const { Client } = await import('pg');
    const project = await ctx.fixtures.project();
    if (!project.accountId) throw new Error('presence fixture project is missing accountId');
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: project.accountId,
      userId: ctx.P.OWNER.userId!,
      visibility: 'project',
    });
    ctx.track('session', sessionId, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const url = '/v1/projects/:projectId/sessions/:sessionId/presence';
    const put = (as: typeof owner, body: unknown, id = sessionId) =>
      as.put(url, body, { params: { projectId: project.id, sessionId: id } });
    const tabId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
    await db.connect();
    const leases = async () =>
      (await db.query('SELECT expires_at FROM kortix.session_presence_leases WHERE session_id = $1 AND tab_id = $2', [sessionId, tabId])).rows;
    try {
      await ctx.step('an anonymous caller is rejected with 401', async () => {
        (await put(ctx.client.as(ctx.P.ANON), { tab_id: tabId, active: true })).status(401);
      });

      await ctx.step('a body without a UUID tab_id is rejected with 400 and writes nothing', async () => {
        (await put(owner, { tab_id: 'not-a-uuid', active: true })).status(400);
        if ((await leases()).length !== 0) throw new Error('invalid body wrote a lease');
      });

      await ctx.step('an unknown session answers 404', async () => {
        (await put(owner, { tab_id: tabId, active: true }, 'ses_unknown')).status(404);
      });

      await ctx.step('active=true stores one lease that expires in the future; renewing keeps one row; with no computer, no awake window', async () => {
        (await put(owner, { tab_id: tabId, active: true }))
          .status(200)
          .body()
          .has('$.ok', true)
          .has('$.awake_until', null)
          .has('$.awake_cap_at', null);
        (await put(owner, { tab_id: tabId, active: true })).status(200);
        const rows = await leases();
        if (rows.length !== 1 || new Date(rows[0].expires_at).getTime() <= Date.now()) {
          throw new Error(`expected one live lease, got ${JSON.stringify(rows)}`);
        }
      });

      // KRTX-1729: each presence ping granted 30 minutes, so a tab left visible
      // kept the computer up all night. A ping grants the idle grace (15 min).
      await ctx.step('a present owner keeps the computer awake by the idle grace, not 30 minutes', async () => {
        await db.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
           VALUES ($1::uuid, $2, $3, $4, 'active')`,
          [sandboxId, sessionId, project.accountId, project.id],
        );
        await db.query("UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '1 minute' WHERE sandbox_id = $1::uuid", [sandboxId]);
        const res = (await put(owner, { tab_id: tabId, active: true })).status(200);
        const { rows } = await db.query(
          'SELECT extract(epoch from (deadline_at - now()))::int AS secs, (extract(epoch from deadline_at) * 1000)::float8 AS deadline_ms FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid',
          [sandboxId],
        );
        const minutes = Number(rows[0]?.secs) / 60;
        if (!(minutes > 10 && minutes <= 16)) throw new Error(`deadline is ${minutes.toFixed(1)} min away, expected the 15-min idle grace`);
        // KRTX-1729: the response says until when, for the composer's line.
        const body = res.json<{ awake_until: string | null; awake_cap_at: string | null }>();
        const until = Date.parse(body.awake_until ?? '');
        const capAt = Date.parse(body.awake_cap_at ?? '');
        if (Math.abs(until - Number(rows[0]?.deadline_ms)) > 1) {
          throw new Error(`awake_until ${body.awake_until} is not the stored deadline`);
        }
        // No turn yet: the cap is 2 h after the computer started, which was just now.
        const capHours = (capAt - Date.now()) / 3_600_000;
        if (!(capHours > 1.9 && capHours <= 2.01)) throw new Error(`awake_cap_at ${body.awake_cap_at} is not 2 h after the run start`);
      });

      await ctx.step('an absent report reads back no awake window; the next present report reads it again', async () => {
        (await put(owner, { tab_id: tabId, active: false }))
          .status(200)
          .body()
          .has('$.awake_until', null)
          .has('$.awake_cap_at', null);
        (await put(owner, { tab_id: tabId, active: true })).status(200).body().exists('$.awake_until');
      });

      await ctx.step('active=false clears the lease', async () => {
        (await put(owner, { tab_id: tabId, active: false })).status(200).body().has('$.ok', true);
        if ((await leases()).length !== 0) throw new Error('lease not cleared');
      });
    } finally {
      await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [sandboxId]).catch(() => {});
      await db.end();
    }
  },
);

/**
 * SESS-44 — session participants. One read answers who can open a session,
 * for the header's avatar stack. `multi_user` is the gate: a session with one
 * person renders as before. Who wrote each message is SESS-42.
 */
flow(
  'SESS-44',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/participants',
      'PUT /v1/projects/:projectId/sessions/:sessionId/sharing',
    ],
  },
  async (ctx) => {
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
    });
    ctx.track('session', sessionId, { projectId: project.id });

    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const params = { projectId: project.id, sessionId };
    const path = '/v1/projects/:projectId/sessions/:sessionId/participants';
    type Person = { user_id: string; name: string | null; email: string | null; avatar_url: string | null; is_viewer: boolean };
    type View = { participants: Person[]; total: number; multi_user: boolean };
    const read = async (as: typeof owner) => {
      const r = await as.get(path, { params });
      r.status(200);
      return r.json<View>();
    };
    const share = (body: unknown) =>
      owner.put('/v1/projects/:projectId/sessions/:sessionId/sharing', body, { params });

    await db.connect();
    try {
      await ctx.step('a private session has one participant, the OWNER, and is not multi-user', async () => {
        const view = await read(owner);
        if (view.total !== 1 || view.multi_user) throw new Error(`private: ${JSON.stringify(view)}`);
        const [only] = view.participants;
        if (only?.user_id !== ctx.P.OWNER.userId || !only.is_viewer) throw new Error(`owner row: ${JSON.stringify(only)}`);
      });

      await ctx.step('the MEMBER cannot read the participants of a session it cannot open → 404', async () => {
        (await asMember.get(path, { params })).status(404);
      });

      await ctx.step('sharing with the MEMBER lists two people, OWNER first, each flagged for its own viewer', async () => {
        (await share({ mode: 'members', memberIds: [member.userId] })).status(200);
        const mine = await read(owner);
        if (mine.total !== 2 || !mine.multi_user) throw new Error(`shared: ${JSON.stringify(mine)}`);
        const ids = mine.participants.map((person) => person.user_id);
        if (JSON.stringify(ids) !== JSON.stringify([ctx.P.OWNER.userId, member.userId])) throw new Error(`order ${ids}`);
        if (!mine.participants[0].is_viewer || mine.participants[1].is_viewer) throw new Error('owner viewer flag');
        const theirs = await read(asMember);
        if (theirs.participants[0].is_viewer || !theirs.participants[1].is_viewer) throw new Error('member viewer flag');
      });

      await ctx.step('each participant carries the name, email and profile picture from the auth profile', async () => {
        await db.query(
          `UPDATE auth.users SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
             || '{"full_name":"Sess44 Member","avatar_url":"https://img.example.test/sess44.png"}'::jsonb
           WHERE id = $1`,
          [member.userId],
        );
        const person = (await read(owner)).participants.find((p) => p.user_id === member.userId);
        if (person?.name !== 'Sess44 Member' || person.avatar_url !== 'https://img.example.test/sess44.png')
          throw new Error(`profile: ${JSON.stringify(person)}`);
        if (!person.email) throw new Error('email missing');
      });

      await ctx.step('after unsharing, the MEMBER gets 404 and the OWNER reads one person again', async () => {
        (await share({ mode: 'private' })).status(200);
        (await asMember.get(path, { params })).status(404);
        const view = await read(owner);
        if (view.total !== 1 || view.multi_user) throw new Error(`unshared: ${JSON.stringify(view)}`);
      });

      await ctx.step('unknown session → 404; NONMEMBER → 403; ANON → 401', async () => {
        (await owner.get(path, { params: { projectId: project.id, sessionId: crypto.randomUUID() } })).status(404);
        (await ctx.client.as(ctx.P.NONMEMBER).get(path, { params })).status(403);
        (await ctx.client.as(ctx.P.ANON).get(path, { params })).status(401);
      });
    } finally {
      await db.end();
    }
  },
);

// SESS-48 — POST /start answers from stored rows before any provider call, so
// each branch runs on the local profile: malformed and unknown ids, a fresh
// provisioning row, an abandoned one retired, and a stored terminal failure.
flow(
  'SESS-48',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['POST /v1/projects/:projectId/sessions/:sessionId/start', 'GET /v1/projects/:projectId/sessions/:sessionId'],
  },
  async (ctx) => {
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const db = new Client({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
    await db.connect();
    const team = await ctx.fixtures.team({ name: ctx.fixtures.name('sess-48') });
    const project = await team.project();
    await fundDatabaseAccount(ctx.env, team.id);
    const owner = ctx.client.as(ctx.P.OWNER);
    const start = (sessionId: string) => owner.post('/v1/projects/:projectId/sessions/:sessionId/start', {}, { params: { projectId: project.id, sessionId } });
    const seed = async (
      sessionStatus: 'provisioning' | 'failed',
      sandbox: { provider: 'platinum' | 'daytona'; status: 'provisioning' | 'error'; metadata: Record<string, unknown>; ageMinutes?: number },
    ): Promise<string> => {
      const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId! });
      ctx.track('session', sessionId, { projectId: project.id });
      await db.query('UPDATE kortix.project_sessions SET status = $2, sandbox_provider = $3 WHERE session_id = $1', [sessionId, sessionStatus, sandbox.provider]);
      await db.query(
        `INSERT INTO kortix.session_sandboxes
           (sandbox_id, session_id, account_id, project_id, provider, external_id, status, config, metadata, created_at, updated_at)
         VALUES ($1::uuid, $1, $2::uuid, $3::uuid, $4, NULL, $5, '{}'::jsonb, $6::jsonb,
                 now() - make_interval(mins => $7::int), now() - make_interval(mins => $7::int))`,
        [sessionId, team.id, project.id, sandbox.provider, sandbox.status, JSON.stringify(sandbox.metadata), sandbox.ageMinutes ?? 0],
      );
      return sessionId;
    };
    const sandboxRows = async (sessionId: string) =>
      (
        await db.query<{ status: string; external_id: string | null; age_seconds: number }>(
          'SELECT status::text AS status, external_id, extract(epoch from now() - created_at)::float8 AS age_seconds FROM kortix.session_sandboxes WHERE session_id = $1',
          [sessionId],
        )
      ).rows;
    try {
      await ctx.step('a malformed session id → 400 and an unknown one → 404, before any sandbox work', async () => {
        (await start('not-a-uuid')).status(400).body().has('$.error', 'Invalid session id');
        (await start(crypto.randomUUID())).status(404).body().has('$.error', 'Not found');
        (await owner.get('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId: project.id, sessionId: 'not-a-uuid' } }))
          .status(400)
          .body()
          .has('$.error', 'Invalid session id');
      });

      await ctx.step('a fresh provisioning row with no provider identity answers provisioning and is left alone', async () => {
        const sessionId = await seed('provisioning', { provider: 'platinum', status: 'provisioning', metadata: { initStatus: 'pending', initAttempts: 0, initMaxAttempts: 3 } });
        (await start(sessionId))
          .status(200)
          .body()
          .has('$.stage', 'provisioning')
          .has('$.retriable', true)
          .has('$.sandbox.sandbox_id', sessionId)
          .has('$.sandbox.external_id', null)
          .has('$.sandbox.status', 'provisioning')
          .schema(SessionStartResultSchema);
        const rows = await sandboxRows(sessionId);
        if (rows.length !== 1 || rows[0]!.status !== 'provisioning') throw new Error(`fresh row changed: ${JSON.stringify(rows)}`);
      });

      for (const [reason, metadata, ageMinutes] of [
        ['stale_provisioning_pending', { initStatus: 'pending', initAttempts: 0, initMaxAttempts: 3 }, 11],
        ['stale_provisioning_lost', { initStatus: 'provisioning', initAttempts: 1, initMaxAttempts: 3, initUpdatedAt: new Date(Date.now() - 6 * 60_000).toISOString() }, 6],
      ] as const) {
        await ctx.step(`an abandoned provisioning row is retired: ${reason}, no sandbox, the old row gone`, async () => {
          const sessionId = await seed('provisioning', { provider: 'platinum', status: 'provisioning', metadata, ageMinutes });
          (await start(sessionId)).status(200).body().has('$.stage', 'provisioning').has('$.retriable', true).has('$.sandbox', null).has('$.reason', reason);
          // A deployed target's sandboxes can reach the API, so /start begins a
          // replacement row at once; the local stack cannot, so it starts none.
          // Either way the backdated abandoned row must be gone.
          const rows = await sandboxRows(sessionId);
          if (rows.some((row) => row.age_seconds > 60)) throw new Error(`the abandoned row was not retired: ${JSON.stringify(rows)}`);
        });
      }

      const PROTECTED = 'This sandbox provider cannot enforce network-boundary secret delivery. Select Platinum or change the secret delivery policy.';
      for (const c of [
        {
          label: 'a stored capacity failure answers one typed terminal failure, twice, without re-provisioning',
          provider: 'platinum',
          metadata: { initStatus: 'failed', initAttempts: 1, initMaxAttempts: 1, failureCategory: 'provider-capacity', errorMessage: 'The sandbox provider is at capacity right now. Stop another session and retry.' },
          category: 'provider-capacity',
          message: 'The sandbox provider is at capacity right now. Stop another session and retry.',
          retryable: true,
        },
        {
          label: 'a stored placement error is transient, and once its automatic retries are spent /start answers the exhausted contract instead of replaying',
          provider: 'platinum',
          metadata: {
            initStatus: 'failed',
            initAttempts: 3,
            initMaxAttempts: 3,
            failureCategory: 'sandbox-provider',
            errorMessage: 'The sandbox provider could not start this session. Try again.',
            lastProvisioningError: '500: Failed to place sandbox',
            // TRANSIENT_PROVISION_MAX_RETRIES: every automatic retry is spent.
            transientRetryCount: 6,
          },
          category: 'provider-capacity',
          message: 'The sandbox provider could not start this session after 7 attempts. Restart the session to try again.',
          retryable: true,
          reason: 'provider_transient_retries_exhausted',
        },
        {
          label: 'a protected-delivery failure on a legacy Daytona row is actionable and not retryable',
          provider: 'daytona',
          metadata: { initStatus: 'failed', initAttempts: 1, initMaxAttempts: 1, failureCategory: 'unsupported-secret-delivery', errorMessage: PROTECTED },
          category: 'unsupported-secret-delivery',
          message: PROTECTED,
          retryable: false,
        },
      ] as const) {
        await ctx.step(c.label, async () => {
          const sessionId = await seed('failed', { provider: c.provider, status: 'error', metadata: c.metadata });
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const answer = (await start(sessionId)).status(200).body();
            answer
              .has('$.stage', 'failed')
              .has('$.retriable', false)
              .has('$.sandbox.status', 'error')
              .has('$.failure.category', c.category)
              .has('$.failure.message', c.message)
              .has('$.failure.retryable', c.retryable);
            // The transient case runs the #9489 retry path. Its exhausted answer is
            // deterministic on every target: the seeded row has spent every
            // automatic retry, so /start never allocates and reports the verdict.
            if ('reason' in c) answer.has('$.reason', c.reason);
          }
          const rows = await sandboxRows(sessionId);
          if (rows.length !== 1 || rows[0]!.status !== 'error' || rows[0]!.external_id !== null) throw new Error(`a terminal failure changed the row: ${JSON.stringify(rows)}`);
        });
      }
    } finally {
      await db.query('DELETE FROM kortix.session_sandboxes WHERE project_id = $1::uuid', [project.id]).catch(() => {});
      await db.end();
    }
  },
);

// SESS-50 — a stored agent question counts as waiting on a person only while
// the agent waits on it (KRTX-1739). The session's sandbox credential relays
// the question and the turn ends; GET needs-input and GET .../question read
// the stored row.
flow(
  'SESS-50',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'POST /v1/projects/:projectId/turn-question',
      'POST /v1/projects/:projectId/turn-stream',
      'GET /v1/projects/:projectId/approvals/needs-input',
      'GET /v1/projects/:projectId/sessions/:sessionId/question',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ name: ctx.fixtures.name('sess-50') });
    const project = await team.project();
    // A plain member: needs-input lists the sessions a non-manager created.
    const creator = await team.addMember('member');
    await team.grantProjectRole(project.id, creator.userId!, 'member');
    const db = await openFlowDb(ctx.env);
    const turn = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator }).catch(async (error) => {
      await db.end();
      throw error;
    });
    const params = { projectId: project.id };
    const sessionId = turn.sessionId;
    const ask = (requestId: string) =>
      turn.sandbox.post(
        '/v1/projects/:projectId/turn-question',
        {
          session_id: sessionId,
          request_id: requestId,
          runtime_session_id: 'ses_root',
          questions: [{ question: 'Which region should the service deploy to?', options: [{ label: 'eu-west-1' }] }],
        },
        { params },
      );
    const end = (messageId: string, frame: Record<string, unknown>) =>
      turn.sandbox.post(
        '/v1/projects/:projectId/turn-stream',
        { session_id: sessionId, kind: 'end', runtime_session_id: 'ses_root', turn_message_id: messageId, ...frame },
        { params },
      );
    /** needs-input for the creator, and the open question of GET .../question. */
    const expectWaiting = async (count: number, requestId: string | null) => {
      const listed = await ctx.client.as(creator).get('/v1/projects/:projectId/approvals/needs-input', { params });
      listed.status(200);
      const n = listed.json<{ sessions: Record<string, number> }>().sessions[sessionId] ?? 0;
      if (n !== count) throw new Error(`needs-input lists the session with ${n}, expected ${count}`);
      const read = await ctx.client
        .as(creator)
        .get('/v1/projects/:projectId/sessions/:sessionId/question', { params: { ...params, sessionId } });
      read.status(200);
      const open = read.json<{ question: { request_id: string } | null }>().question;
      if ((open?.request_id ?? null) !== requestId) throw new Error(`open question ${JSON.stringify(open)}, expected ${requestId}`);
    };
    try {
      await turn.startTurn('msg_sess50_a', creator.userId!);
      await ctx.step('the sandbox relays a question → 200 persisted; needs-input lists the session with 1 and GET question returns it', async () => {
        (await ask('que_sess50_a')).status(200).body().has('$.persisted', true);
        await expectWaiting(1, 'que_sess50_a');
      });

      await ctx.step('a retrying error frame → outcome non_terminal; the question stays open', async () => {
        (await end('msg_sess50_a', { status: 'error', error_name: 'APIError', error_retryable: true }))
          .status(200)
          .body()
          .has('$.turn_completion.outcome', 'non_terminal');
        await expectWaiting(1, 'que_sess50_a');
      });

      await ctx.step('the daemon reports the turn idle → closed; needs-input drops the session and GET question returns null', async () => {
        await turn.endTurn('msg_sess50_a');
        await expectWaiting(0, null);
      });

      await turn.startTurn('msg_sess50_b', creator.userId!);
      await ctx.step('the next turn asks again → 1; the person stops it (MessageAbortedError) → closed and 0', async () => {
        (await ask('que_sess50_b')).status(200);
        await expectWaiting(1, 'que_sess50_b');
        (await end('msg_sess50_b', { status: 'error', error_name: 'MessageAbortedError' }))
          .status(200)
          .body()
          .has('$.turn_completion.outcome', 'closed');
        await expectWaiting(0, null);
      });

      await turn.startTurn('msg_sess50_c', creator.userId!);
      await ctx.step('a replayed end frame of the stopped turn closes no turn → already_closed; the new question stays open', async () => {
        (await ask('que_sess50_c')).status(200);
        (await end('msg_sess50_b', { status: 'error', error_name: 'MessageAbortedError' }))
          .status(200)
          .body()
          .has('$.turn_completion.outcome', 'already_closed');
        await expectWaiting(1, 'que_sess50_c');
        await turn.endTurn('msg_sess50_c');
        await expectWaiting(0, null);
      });
    } finally {
      await turn.cleanup();
      await db.end();
    }
  },
);

/**
 * SESS-52 — a list page reads only the rows its viewer may see (KRTX-2316).
 * The page WHERE carries the visibility, tombstone and warm-draft rules, so a
 * page is full however many newer rows are someone else's private sessions or
 * deleted ones. A delete keeps the session's place in the list order. Runs on
 * the local profile: the sessions are database rows.
 */
flow(
  'SESS-52',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions', 'DELETE /v1/projects/:projectId/sessions/:sessionId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const shared = await team.project();
    const trash = await team.project();
    const author = await team.addMember('member');
    const reader = await team.addMember('member');
    for (const projectId of [shared.id, trash.id]) {
      for (const member of [author, reader]) await team.grantProjectRole(projectId, member.userId!, 'member');
    }
    type Row = { session_id: string; deleted_at: string | null };
    const route = '/v1/projects/:projectId/sessions';
    const list = async (as: ReturnType<typeof ctx.client.as>, projectId: string, query: Record<string, string>) => {
      const r = await as.get(route, { params: { projectId }, query });
      r.status(200);
      return { rows: r.json<Row[]>(), cursor: r.header('x-next-cursor') ?? null };
    };
    const expectIds = (got: Row[], want: string[], what: string) => {
      const ids = got.map((row) => row.session_id);
      if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(ids)}, want ${JSON.stringify(want)}`);
    };

    const db = await openFlowDb(ctx.env);
    // `count` rows in one statement, returned newest first. The projects'
    // teardown deletes them: the sessions cascade with the project.
    const seed = async (input: {
      projectId: string;
      owner: string;
      visibility: 'private' | 'project';
      count: number;
      newestMinutesAgo: number;
      deleted?: true;
    }): Promise<string[]> => {
      const metadata = input.deleted ? { deletedAt: new Date().toISOString(), deletedBy: input.owner } : {};
      const result = await db.query<{ session_id: string; updated_at: Date }>(
        `INSERT INTO kortix.project_sessions
           (session_id, account_id, project_id, branch_name, created_by, visibility,
            initiator_type, initiator_id, metadata, created_at, updated_at)
         SELECT s.id, $1::uuid, $2::uuid, 'session/' || s.id, $3::uuid, $4::kortix.project_session_visibility,
                'member', $8::text, $5::jsonb, s.at, s.at
           FROM (SELECT gen_random_uuid()::text AS id,
                        now() - make_interval(mins => $6::int) - make_interval(secs => g) AS at
                   FROM generate_series(1, $7::int) AS g) AS s
         RETURNING session_id, updated_at`,
        [team.id, input.projectId, input.owner, input.visibility, JSON.stringify(metadata), input.newestMinutesAgo, input.count, input.owner],
      );
      return result.rows
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((row) => row.session_id);
    };

    try {
      const [sharedOld] = await seed({ projectId: shared.id, owner: author.userId!, visibility: 'project', count: 1, newestMinutesAgo: 2 * 1440 });
      const authorPrivate = new Set(
        await seed({ projectId: shared.id, owner: author.userId!, visibility: 'private', count: 1000, newestMinutesAgo: 0 }),
      );

      await ctx.step('a member’s Shared query reads past 1,000 newer private sessions: page 1 holds the shared one, with no cursor', async () => {
        const page = await list(ctx.client.as(reader), shared.id, { parent: 'root', started_by: 'others', limit: '20' });
        expectIds(page.rows, [sharedOld!], 'shared');
        if (page.cursor) throw new Error('the last page carries a cursor');
      });

      await ctx.step('the member never receives the other member’s private sessions', async () => {
        const page = await list(ctx.client.as(reader), shared.id, { limit: '200' });
        expectIds(page.rows, [sharedOld!], 'flat');
        if (page.cursor) throw new Error('the last page carries a cursor');
        if (page.rows.some((row) => authorPrivate.has(row.session_id))) throw new Error('a private session leaked');
      });

      const live = await seed({ projectId: trash.id, owner: reader.userId!, visibility: 'project', count: 60, newestMinutesAgo: 60 });
      await seed({ projectId: trash.id, owner: reader.userId!, visibility: 'private', count: 1500, newestMinutesAgo: 0, deleted: true });

      await ctx.step('with 1,500 tombstones newer than them, the owner’s first page holds 50 live sessions and the second the last 10', async () => {
        const asReader = ctx.client.as(reader);
        const first = await list(asReader, trash.id, { limit: '50' });
        expectIds(first.rows, live.slice(0, 50), 'page 1');
        if (!first.cursor) throw new Error('page 1 has no cursor');
        const second = await list(asReader, trash.id, { limit: '50', cursor: first.cursor });
        expectIds(second.rows, live.slice(50), 'page 2');
        if (second.cursor) throw new Error('the last page carries a cursor');
      });

      await ctx.step('a deleted session keeps its place: the manager inventory lists the tombstone where the session was', async () => {
        const deleted = live[5]!;
        (await ctx.client
          .as(reader)
          .del('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId: trash.id, sessionId: deleted } })
        ).status(200);
        const inventory = await list(ctx.client.as(ctx.P.OWNER), trash.id, { scope: 'project', limit: '10' });
        expectIds(inventory.rows, live.slice(0, 10), 'manager inventory');
        if (!inventory.rows[5]!.deleted_at) throw new Error('the deleted session carries no deleted_at');
        const visible = await list(ctx.client.as(reader), trash.id, { limit: '50' });
        expectIds(visible.rows, [...live.slice(0, 5), ...live.slice(6, 51)], 'owner after delete');
      });
    } finally {
      await db.end();
    }
  },
);
