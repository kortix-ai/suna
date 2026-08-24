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
      'unauthenticated resolution of the file token → 200/503 with its public origin URL',
      async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/p/public-share/:token', { params: { token: fileToken } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body().has('$.share.resource_type', 'file').has('$.share.file_path', '/workspace/README.md');
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
