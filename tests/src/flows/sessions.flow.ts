/**
 * Sessions — create/list/get/delete + unified runtime start. Maps to spec §16 (SESS-*).
 * Session creation provisions a REAL Daytona sandbox (fire-and-forget), so these
 * assert the contract (201 provisioning, status transitions) without blocking on
 * a full boot. Gated on the `daytona` capability.
 */
import { flow } from '../core/flow';

flow(
  'SESS-1',
  {
    domain: 'sessions',
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
 *  - a real, not-yet-revoked token whose sandbox has no `externalId` yet → 503
 *    "Sandbox is not ready". `resolvePublicShare` LEFT (not INNER) JOINs
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
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
 * value the CRUD responses call `share.share_id`), NOT the `kps_...` public
 * token `/v1/p/public-share/:token` uses. The route derives the token
 * server-side (`publicShareToken(shareId)`) and resolves through the exact
 * same `resolvePublicShare()` SESS-13 covers, so it inherits identical
 * 404 (unknown) / 410 (revoked or expired) / 503 (sandbox not provisioned
 * yet) semantics — and ANY existing share for the session (created as a
 * `preview` or a `file`, the only kinds the CRUD supports today) unlocks the
 * transcript view too: a share token already proves the owner handed this
 * link to someone outside the account, and the read-only conversation is not
 * more sensitive than the live preview or workspace file that SAME token
 * already exposes.
 *
 * The metadata route (`GET /:shareId`) is DB-only (title/status/timestamps),
 * so it does not itself 503 on an inactive sandbox — only `resolvePublicShare`'s
 * own missing-`externalId` check can. The messages route additionally 503s
 * when the sandbox row exists but isn't `active`, and otherwise degrades to a
 * 200 `{available:false, reason}` digest (mirroring the authenticated
 * `/transcript` debug endpoint's behavior) for transient OpenCode-not-ready
 * states — a polling frontend should retry those, not treat them as fatal.
 */
flow(
  'SESS-16',
  {
    domain: 'sessions',
    requires: ['daytona', 'funded'],
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
      'anon: read the sanitized transcript for the real share → 200 (digest) or 503 (sandbox not up)',
      async () => {
        const r = await anon.get('/v1/public/session-shares/:shareId/messages', {
          params: { shareId },
        });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body().exists('$.available').exists('$.messages').exists('$.message_count');
        }
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
    requires: ['daytona', 'funded'],
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
    requires: ['daytona', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions/warm',
      'POST /v1/projects/:projectId/sessions/warm/claim',
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

    await ctx.step('warming creates an ordinary session marked unused', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm',
        {},
        { params: { projectId: p.id } },
      );
      r.status(200)
        .body()
        .has('$.reused', false)
        .has('$.session.metadata.warm', true)
        .exists('$.session.session_id');
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

    await ctx.step('an unused warm session is hidden from the visible list', async () => {
      const visible = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: p.id },
        query: { scope: 'visible' },
      });
      visible.status(200);
      const visibleIds = sessionRows(visible).map((s: any) => s.session_id);
      if (visibleIds.includes(warmSessionId)) {
        throw new Error('An unused warm session appeared in the visible session list');
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

    await ctx.step('using the session drops the marker', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/warm/claim',
        { session_id: warmSessionId },
        { params: { projectId: p.id } },
      );
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
      const row = sessionRows(visible).find((s: any) => s.session_id === replacementId);
      if (!row) {
        throw new Error('An adopted warm session is still hidden from the visible session list');
      }
      if ((row.metadata ?? {}).warm !== undefined) {
        throw new Error('The warm marker survived adoption via POST /start');
      }
      if (typeof (row.metadata ?? {}).last_activity_at !== 'string') {
        throw new Error('Adoption did not stamp last_activity_at — the session sorts at create time');
      }
      // Adoption writes last_activity_at and updated_at in the same statement.
      // Later lifecycle writes can advance updated_at before this read-back.
      // Require monotonic ordering on this row instead of exact equality.
      const updatedAtMs = Date.parse(row.updated_at);
      const lastActivityAtMs = Date.parse(row.metadata.last_activity_at);
      const createdAtMs = Date.parse(row.created_at);
      if (
        !Number.isFinite(updatedAtMs) ||
        !Number.isFinite(lastActivityAtMs) ||
        lastActivityAtMs <= createdAtMs ||
        updatedAtMs < lastActivityAtMs
      ) {
        throw new Error(
          `Adoption did not advance last_activity_at and updated_at monotonically ` +
            `(created_at=${row.created_at}, updated_at=${row.updated_at}, ` +
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
    requires: ['daytona', 'funded'],
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
          kortix_cli: ['project.file.read', 'project.gitops.read'],
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
      await ctx.step('create a session requiring an unavailable connector', async () => {
        const config = await owner.put(
          '/v1/projects/:projectId/agents/:agentName/config',
          { connectors: 'all', secrets: 'none', skills: 'all', kortix_cli: 'all' },
          { params: { projectId: project.id, agentName: 'kortix' } },
        );
        config.status(200);
        await db.query(
          `INSERT INTO kortix.project_sessions
        (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, required_connectors)
        VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'project', '["missing-gmail"]'::jsonb)`,
          [sessionId, team.id, project.id, ctx.P.OWNER.userId],
        );
      });
      await ctx.step('POST returns the connector refusal and creates no inbox row', async () => {
        const response = await owner.post(
          promptPath,
          {
            client_message_id: 'blocked-connector',
            message_id: 'msg_0123456789abAbCdEfGhIjKlMn',
            parts: [{ type: 'text', text: 'hello' }],
          },
          { params },
        );
        response.status(409).body().has('$.code', 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE');
        const listed = await owner.get(promptPath, { params });
        listed.status(200);
        if (listed.json<any>().prompts.length !== 0)
          throw new Error('refused prompt entered the queue');
      });
      await ctx.step(
        'Stop holds an in-flight delivery immediately and GET preserves the hold',
        async () => {
          // A claimed row models the instant between worker claim and network send.
          // Its lease prevents the background worker from claiming the fixture.
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
            response.status(200);
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
      await ctx.step('a disabled optional binding allows a prompt; an explicit requirement still refuses it', async () => {
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
        await db.query('UPDATE kortix.project_sessions SET required_connectors = NULL WHERE session_id = $1', [sessionId]);
        const body = {
          client_message_id: 'optional-connector',
          message_id: 'msg_0123456789abAbCdEfGhIjKlMo',
          parts: [{ type: 'text', text: 'hello without Gmail' }],
        };
        const accepted = await owner.post(promptPath, body, { params });
        accepted.status(202);
        const queued = await db.query(
          `SELECT command_id FROM kortix.session_lifecycle_commands
           WHERE session_id = $1 AND payload->>'clientMessageId' = 'optional-connector'`, [sessionId],
        );
        if (queued.rowCount !== 1) throw new Error('optional connector prompt was not persisted');
        // The fixture's claimed delivery prevents this row from reaching a runtime.
        await db.query('DELETE FROM kortix.session_lifecycle_commands WHERE command_id = $1', [queued.rows[0].command_id]);
        await db.query(`UPDATE kortix.project_sessions SET required_connectors = '["optional-gmail"]'::jsonb WHERE session_id = $1`, [sessionId]);
        const refused = await owner.post(promptPath, { ...body, client_message_id: 'explicit-connector' }, { params });
        refused.status(409).body().has('$.code', 'CONNECTOR_CONNECTION_REQUIRED');
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
