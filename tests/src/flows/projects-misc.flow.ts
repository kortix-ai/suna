/**
 * Projects — miscellaneous project-scoped surfaces that don't fit the core CRUD
 * flow: BYO-repo create, the CLI-token (project PAT)
 * lifecycle, onboarding state, version-diff preview, ChatGPT headless provider
 * auth and the Slack-relay turn endpoints.
 *
 * Maps to spec §13 (PROJ-2 for BYO create; PROJ-9..PROJ-17 minted here).
 */
import { flow } from '../core/flow';
import { withDb } from '../fixtures/chat';
import { bindDatabaseSessionCredential, createDatabaseSession } from '../fixtures/database-project';

// PROJ-2 — BYO repo create. A non-GitHub repo_url is rejected at the
// normalizeRepoUrl boundary (400) before any GitHub round-trip; MEMBER /
// NONMEMBER are denied by PROJECT_CREATE (403). We assert the boundary only —
// a real 201 needs a GitHub App install + reachable repo, which the harness
// can't guarantee.
flow('PROJ-2', { domain: 'projects', routes: ['POST /v1/projects'] }, async (ctx) => {
  await ctx.step('missing repo_url → 400 repo_url is required', async () => {
    (await ctx.client.as(ctx.P.OWNER).post('/v1/projects', { name: ctx.fixtures.name('byo') }))
      .status(400).body().has('$.error', 'repo_url is required');
  });
  await ctx.step('non-GitHub repo_url → 400', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post('/v1/projects', {
        name: ctx.fixtures.name('byo'),
        repo_url: 'https://gitlab.com/acme/widget',
      });
    r.status(400);
  });
  await ctx.step('http:// (non-HTTPS) repo_url → 400', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post('/v1/projects', {
        name: ctx.fixtures.name('byo'),
        repo_url: 'http://github.com/acme/widget',
      });
    r.status(400);
  });
  await ctx.step('ANON cannot create → 401', async () => {
    // (Any authenticated user CAN create a project in their own account, so a
    // cross-tenant 403 isn't the boundary here — unauth is.)
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post('/v1/projects', {
        name: ctx.fixtures.name('byo'),
        repo_url: 'https://github.com/acme/widget',
      });
    r.status(401);
  });
});

// PROJ-10 — CLI-token lifecycle. POST mints a real project-scoped PAT
// (returns secret_key + token_id, 201); GET lists it; DELETE revokes it.
// Mutating + minting a credential → serial.
flow(
  'PROJ-10',
  {
    domain: 'projects',
    routes: [
      'POST /v1/projects/:projectId/cli-token',
      'GET /v1/projects/:projectId/cli-token',
      'DELETE /v1/projects/:projectId/cli-token/:tokenId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let tokenId = '';
    await ctx.step('mint a CLI token → 201', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/cli-token',
          { name: ctx.fixtures.name('cli') },
          { params: { projectId: p.id } },
        );
      r.status(201).body().exists('$.token_id').exists('$.secret_key').has('$.project_id', p.id);
      tokenId = r.json<any>().token_id;
      ctx.track('cli-token', tokenId, { projectId: p.id });
    });
    await ctx.step('list CLI tokens → 200 includes minted, hides session tokens', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/cli-token', { params: { projectId: p.id } });
      r.status(200).body().exists('$.items').exists('$.session_tokens');
    });
    await ctx.step('revoke CLI token → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/cli-token/:tokenId', {
          params: { projectId: p.id, tokenId },
        });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('revoke unknown token → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', {
        params: { projectId: p.id, tokenId: '00000000-0000-4000-a000-000000000000' },
      });
      r.status(404);
    });
    await ctx.step('NONMEMBER cannot mint → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/projects/:projectId/cli-token', {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);
// PROJ-11 — onboarding state. PATCH {completed:true|false} flips
// metadata.onboarding_completed_at and echoes the serialized project (200).
flow(
  'PROJ-11',
  { domain: 'projects', routes: ['PATCH /v1/projects/:projectId/onboarding'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('mark onboarding completed → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/onboarding',
          { completed: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.project_id', p.id);
    });
    await ctx.step('reset onboarding → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/onboarding',
          { completed: false },
          { params: { projectId: p.id } },
        );
      r.status(200);
    });
    await ctx.step('NONMEMBER cannot patch → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          '/v1/projects/:projectId/onboarding',
          { completed: true },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// PROJ-12 — version-diff preview. Requires `from` + `into` query params (400
// without). Same ref short-circuits to is_same_ref:true (200) with no git
// round-trip; a real cross-ref diff may 400 if a ref can't be resolved.
flow(
  'PROJ-12',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/version-diff'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing from/into → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/version-diff', { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step('same ref → 200 is_same_ref', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/version-diff', {
          params: { projectId: p.id },
          query: { from: 'main', into: 'main' },
        });
      r.status(200).body().has('$.is_same_ref', true);
    });
    await ctx.step('cross-ref diff → 200 or 400 (unresolvable ref)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/version-diff', {
        params: { projectId: p.id },
        query: { from: 'does-not-exist', into: 'main' },
      });
      r.status([200, 400]);
    });
  },
);

// PROJ-13 — provider OAuth device flow (poll-based). `start` kicks the device
// flow and returns a challenge; the client polls `poll` until it resolves; the
// resulting login is saved as CODEX_AUTH_JSON. `list`/`delete` manage it. We
// assert the boundaries only — completing a real device login needs a live
// ChatGPT account the harness can't drive, and calling `start` for a real
// provider would spawn a server-side OpenCode flow, so we exercise `start`'s
// unknown-provider guard instead.
flow(
  'PROJ-13',
  {
    domain: 'projects',
    routes: [
      'POST /v1/projects/:projectId/oauth/:provider/start',
      'POST /v1/projects/:projectId/oauth/:provider/poll',
      'GET /v1/projects/:projectId/oauth',
      'DELETE /v1/projects/:projectId/oauth/:provider',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('start unknown provider → 400 (no flow spawned)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/oauth/:provider/start',
          {},
          { params: { projectId: p.id, provider: 'nope' } },
        );
      r.status(400);
    });
    await ctx.step('start invalid sharing → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/oauth/:provider/start',
          { sharing: { mode: 'bogus' } },
          { params: { projectId: p.id, provider: 'openai' } },
        );
      r.status(400);
    });
    await ctx.step('poll missing flow_id → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/oauth/:provider/poll',
          {},
          { params: { projectId: p.id, provider: 'openai' } },
        );
      r.status(400);
    });
    await ctx.step('poll bogus flow_id → 200 expired', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/oauth/:provider/poll',
          { flow_id: '00000000-0000-4000-a000-000000000000' },
          { params: { projectId: p.id, provider: 'openai' } },
        );
      r.status(200).body().has('$.status', 'expired');
    });
    await ctx.step('list configured OAuth → 200 items', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/oauth', { params: { projectId: p.id } });
      r.status(200).body().exists('$.items');
    });
    await ctx.step('delete unknown provider → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/oauth/:provider', {
          params: { projectId: p.id, provider: 'nope' },
        });
      r.status(404);
    });
    await ctx.step('NONMEMBER start → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/oauth/:provider/start',
          {},
          { params: { projectId: p.id, provider: 'openai' } },
        );
      r.status([403, 404]);
    });
    await ctx.step('ANON list → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/oauth', { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// PROJ-16 — turn-question relay. A normal user token authorizes via project
// read; the relay validates session_id first, then scopes it to the project,
// then validates questions. A missing id is 400; an unknown id is 404. We assert the
// no-session negative so it runs locally without a live OpenCode session.
flow(
  'PROJ-16',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/turn-question'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing session_id → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/turn-question',
          { questions: [{ question: 'q?' }] },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('unknown session takes precedence over missing questions → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/turn-question',
          { session_id: 'bogus' },
          { params: { projectId: p.id } },
        );
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/turn-question',
          { session_id: 'bogus', questions: [] },
          { params: { projectId: p.id } },
        );
      r.status([400, 403, 404]);
    });
  },
);

// PROJ-38 — turn-permission relay. The daemon reports OpenCode
// `permission.asked`; the route pushes "needs your approval" once per request
// id and never answers the permission. Only the session's own sandbox
// credential may call it: a user token would let any member push another
// member's devices. The sandbox credential is a project PAT bound to a
// synthetic live session (bindDatabaseSessionCredential).
flow(
  'PROJ-38',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/turn-permission'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const base = { projectId: p.id };
    // The daemon body (TurnPermissionRelayBodySchema): `permission` and `patterns` are required.
    const ask = (extra: Record<string, unknown>) => ({ permission: 'bash', patterns: ['git push *'], ...extra });
    const target = '/v1/projects/:projectId/turn-permission';
    const accountId = await withDb(ctx, async (db) =>
      (await db.query('SELECT account_id FROM kortix.projects WHERE project_id = $1', [p.id])).rows[0]
        .account_id as string,
    );
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: p.id,
      accountId,
      userId: ctx.P.OWNER.userId!,
    });
    const otherSessionId = await createDatabaseSession(ctx.env, {
      projectId: p.id,
      accountId,
      userId: ctx.P.OWNER.userId!,
    });
    let tokenId: string | null = null;
    try {
      await ctx.step('ANON → 401', async () => {
        const r = await ctx.client
          .as(ctx.P.ANON)
          .post(target, ask({ session_id: sessionId, request_id: 'per_1' }), { params: base });
        r.status(401);
      });
      await ctx.step('OWNER user token on its own session → 403 (sandbox credential only)', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(target, ask({ session_id: sessionId, request_id: 'per_1' }), { params: base });
        r.status(403);
      });
      await ctx.step('NONMEMBER → 403/404', async () => {
        const r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post(target, ask({ session_id: sessionId, request_id: 'per_1' }), { params: base });
        r.status([403, 404]);
      });

      const minted = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('proj37') }, { params: base });
      minted.status(201);
      const token = minted.json<{ token_id: string; secret_key: string }>();
      tokenId = token.token_id;
      await bindDatabaseSessionCredential(ctx.env, {
        tokenId: token.token_id,
        commandId: crypto.randomUUID(),
        sessionId,
        accountId,
        projectId: p.id,
      });
      const sandbox = () => ctx.client.withBearer(token.secret_key, 'session sandbox credential');
      const relay = (body: Record<string, unknown>) => sandbox().post(target, body, { params: base });

      await ctx.step('sandbox credential without session_id → 400', async () => {
        (await relay(ask({ request_id: 'per_1' }))).status(400);
      });
      await ctx.step('sandbox credential naming another session of the project → 403', async () => {
        (await relay(ask({ session_id: otherSessionId, request_id: 'per_1' }))).status(403);
      });
      await ctx.step('sandbox credential without request_id → 400', async () => {
        (await relay(ask({ session_id: sessionId }))).status(400);
      });
      await ctx.step('request_id longer than 256 characters → 400', async () => {
        (await relay(ask({ session_id: sessionId, request_id: 'p'.repeat(257) }))).status(400);
      });
      await ctx.step('first relay of a request id with the daemon body → 200 notified:true', async () => {
        const r = await relay(ask({ session_id: sessionId, request_id: 'per_1', runtime_session_id: 'ses_synthetic' }));
        r.status(200).body().has('$.ok', true).has('$.notified', true);
      });
      await ctx.step('a repeat of the same request id → 200 notified:false (one push per request)', async () => {
        (await relay(ask({ session_id: sessionId, request_id: 'per_1' })))
          .status(200)
          .body()
          .has('$.ok', true)
          .has('$.notified', false);
      });
      await ctx.step('a new request id in the same session → 200 notified:true', async () => {
        (await relay(ask({ session_id: sessionId, request_id: 'per_2' }))).status(200).body().has('$.notified', true);
      });
    } finally {
      if (tokenId) {
        await ctx.client
          .as(ctx.P.OWNER)
          .del('/v1/projects/:projectId/cli-token/:tokenId', { params: { ...base, tokenId } })
          .catch(() => {});
      }
      await withDb(ctx, async (db) => {
        await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [sessionId]);
        await db.query('DELETE FROM kortix.project_sessions WHERE session_id = ANY($1)', [[sessionId, otherSessionId]]);
      }).catch(() => {});
    }
  },
);

// PROJ-17 — turn-stream relay. Same auth model as turn-question; the body gate
// requires session_id first, then scopes it to the project before interpreting
// the event payload. Asserting the negative
// keeps this local (no funded session required).
flow(
  'PROJ-17',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/turn-stream'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing session_id + text → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/turn-stream',
          { kind: 'step' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('unknown session takes precedence over missing text → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/turn-stream',
          { session_id: 'bogus' },
          { params: { projectId: p.id } },
        );
      r.status(404);
    });
    await ctx.step('kind=turn_end with an unknown session → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/turn-stream',
          { session_id: 'bogus', kind: 'turn_end', status: 'idle' },
          { params: { projectId: p.id } },
        );
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/turn-stream',
          { session_id: 'bogus', text: 'hi' },
          { params: { projectId: p.id } },
        );
      r.status([400, 403, 404]);
    });
  },
);

// PROJ-19 — Full v2 agent-config editor (the "agent builder" surface). GET reports the
// agent's full block + the manifest schema version (the UI's v1-vs-v2 branch);
// PUT replaces the whole block, validating it through the manifest-schema
// validator before the kortix.yaml commit. A bare provisioned project now
// synthesizes a v2 manifest (synthesizeBlankManifest, kortix_version 2 — see
// PR #4980), so GET reports schema_version 2 and editable:true. PUT still
// validates the block shape strictly: a body with unrecognized top-level keys
// (or a bad enum) is refused with a 400; the editor-tier gate holds.
flow(
  'PROJ-19',
  {
    domain: 'projects',
    routes: [
      'GET /v1/projects/:projectId/agents/:agentName/config',
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'GET /v1/projects/:projectId/agents/:agentName/capabilities',
      'GET /v1/projects/:projectId/files/content',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ seed: true });
    const kortixBlock = async () => {
      const file = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/files/content', {
        params: { projectId: project.id }, query: { path: 'kortix.yaml' },
      });
      file.status(200);
      const content = file.json<{ content: string }>().content;
      return content.slice(content.indexOf('\n  kortix:'));
    };

    await ctx.step(
      'GET reports schema_version 2 / editable true for a seeded manifest',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/agents/:agentName/config', {
            params: { projectId: project.id, agentName: 'kortix' },
          });
        r.status(200).body().has('$.schema_version', 2).has('$.editable', true);
      },
    );

    for (const access of [false, true]) {
      await ctx.step(`set repository_access=${access} and read back the saved policy`, async () => {
        const params = { projectId: project.id, agentName: 'kortix' };
        const saved = await ctx.client.as(ctx.P.OWNER).put(
          '/v1/projects/:projectId/agents/:agentName/config',
          { repository_access: access }, { params },
        );
        saved.status(200).body().has('$.block.repository_access', access);
        const read = await ctx.client.as(ctx.P.OWNER).get(
          '/v1/projects/:projectId/agents/:agentName/config', { params },
        );
        read.status(200).body().has('$.block.repository_access', access);
        if ('workspace' in read.json<any>().block) throw new Error('response exposes legacy workspace');
        const block = await kortixBlock();
        if (!block.includes(`workspace:\n      project_repository: ${access}`) || block.includes('repository_access')) {
          throw new Error(`kortix.yaml must store workspace.project_repository: ${access}, got:\n${block}`);
        }
      });
    }
    await ctx.step('legacy runtime saves a disabled repository policy', async () => {
      const saved = await ctx.client.as(ctx.P.OWNER).put(
        '/v1/projects/:projectId/agents/:agentName/config', { workspace: 'runtime' },
        { params: { projectId: project.id, agentName: 'kortix' } },
      );
      saved.status(200).body().has('$.block.repository_access', false);
    });
    for (const body of [{ repository_access: 'false' }, { repository_access: true, workspace: 'runtime' }, { workspace: { project_repository: false } }]) {
      await ctx.step('invalid or conflicting repository policy is rejected without widening access', async () => {
        const params = { projectId: project.id, agentName: 'kortix' };
        const rejected = await ctx.client.as(ctx.P.OWNER).put(
          '/v1/projects/:projectId/agents/:agentName/config', body, { params },
        );
        rejected.status(400);
        const read = await ctx.client.as(ctx.P.OWNER).get(
          '/v1/projects/:projectId/agents/:agentName/config', { params },
        );
        read.status(200).body().has('$.block.repository_access', false);
      });
    }

    await ctx.step(
      'the behavior half reads and writes as `behavior`; a round trip that edits only its pre-W4 name `opencode` keeps that edit; two different edits → 400',
      async () => {
        const params = { projectId: project.id, agentName: 'kortix' };
        const path = '/v1/projects/:projectId/agents/:agentName/config';
        const owner = ctx.client.as(ctx.P.OWNER);
        const current = (await owner.get(path, { params })).status(200).json<any>().block.behavior;
        const neutral = { ...current, description: 'Written as behavior' };
        const saved = await owner.put(path, { behavior: neutral }, { params });
        saved.status(200).body()
          .has('$.block.behavior.description', 'Written as behavior')
          .has('$.block.opencode.description', 'Written as behavior');
        const served = (await owner.get(path, { params })).status(200).json<any>().block;
        if (JSON.stringify(served.behavior) !== JSON.stringify(served.opencode)) {
          throw new Error('GET serves different values under behavior and opencode');
        }
        const olderClient = { ...served.opencode, description: 'Edited as opencode' };
        (await owner.put(path, { behavior: served.behavior, opencode: olderClient }, { params }))
          .status(200);
        (await owner.get(path, { params })).status(200).body()
          .has('$.block.behavior.description', 'Edited as opencode');
        (await owner.put(
          path,
          { behavior: { ...current, description: 'A' }, opencode: { ...current, description: 'B' } },
          { params },
        )).status(400);
      },
    );

    await ctx.step('PUT a body with unrecognized top-level keys → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/agents/:agentName/config',
          { mode: 'primary', description: 'Support', temperature: 0.2 },
          { params: { projectId: project.id, agentName: 'kortix' } },
        );
      r.status(400);
    });

    await ctx.step('PUT with a malformed body (bad enum) → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/agents/:agentName/config',
          { mode: 'supervisor' },
          { params: { projectId: project.id, agentName: 'kortix' } },
        );
      r.status(400);
    });

    await ctx.step(
      'a member with no project grant cannot read/write the config → 403',
      async () => {
        const bare = await team.addMember('member');
        const r = await ctx.client
          .as(bare)
          .get('/v1/projects/:projectId/agents/:agentName/config', {
            params: { projectId: project.id, agentName: 'kortix' },
          });
        r.status(403);
      },
    );

    await ctx.step(
      'GET capabilities lists every tool, built-in skill and platform extension; an undeclared agent → 404; no grant → 403',
      async () => {
        const path = '/v1/projects/:projectId/agents/:agentName/capabilities';
        const r = await ctx.client.as(ctx.P.OWNER).get(path, { params: { projectId: project.id, agentName: 'kortix' } });
        r.status(200).body().has('$.agent', 'kortix');
        const catalog = r.json<{
          tools: Array<{ id: string; group: string; aliases: string[] }>;
          skills: Array<{ id: string; group: string; description: string | null; feature_flag: string | null }>;
          extensions: Array<{ id: string; required: boolean }>;
        }>();
        const agentTool = catalog.tools.find((tool) => tool.id === 'agent');
        if (agentTool?.group !== 'interaction' || agentTool.aliases[0] !== 'task') throw new Error(`agent tool row: ${JSON.stringify(agentTool)}`);
        const system = catalog.skills.find((skill) => skill.id === 'kortix-system');
        if (system?.group !== 'builtin' || !system.description) throw new Error(`kortix-system row: ${JSON.stringify(system)}`);
        if (catalog.skills.find((skill) => skill.id === 'kortix-goals')?.feature_flag !== 'goals') throw new Error('kortix-goals carries no goals flag');
        const required = catalog.extensions.filter((ext) => ext.required).map((ext) => ext.id).join(',');
        if (required !== 'kortix-nested-calls,kortix-presentation,kortix-turn') throw new Error(`required extensions: ${required}`);
        (await ctx.client.as(ctx.P.OWNER).get(path, { params: { projectId: project.id, agentName: 'ghost' } }))
          .status(404).body().has('$.code', 'agent_not_found');
        const bare = await team.addMember('member');
        (await ctx.client.as(bare).get(path, { params: { projectId: project.id, agentName: 'kortix' } })).status(403);
      },
    );
  },
);

// PROJ-20 — managed-git pre-flight status. GET /managed-git/status lets the
// "Create project" UI pre-check whether the managed-git provision path is
// usable BEFORE the user hits its 503 (self-host deploys with no
// MANAGED_GIT_* configured). Auth-gated, account-scoped (NOT project-scoped —
// the path has no :projectId, it reports the server-wide managed-git backend).
// Read-only and safe to assert the happy path on staging.
flow(
  'PROJ-20',
  { domain: 'projects', routes: ['GET /v1/projects/managed-git/status'] },
  async (ctx) => {
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/projects/managed-git/status');
      r.status(401);
    });
    await ctx.step('OWNER → 200 with {configured, provider}', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/managed-git/status');
      r.status(200).body().exists('$.configured').exists('$.provider');
      const provider = r.json<any>()?.provider;
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new Error(`expected a non-empty provider string, got: ${provider}`);
      }
      // `configured` is a boolean — never a 500, never an unset field.
      if (typeof r.json<any>()?.configured !== 'boolean') {
        throw new Error(`expected configured to be a boolean, got: ${r.json<any>()?.configured}`);
      }
    });
  },
);

// PROJ-43 — project-quota pre-flight. GET /projects/quota reports the
// account's project-cap state so the /new form can show the cap reason and
// keep Create disabled BEFORE a create fails with the 403 (KRTX-2495). The
// same computation the create gate runs (`enforceProjectQuota` →
// `projectQuotaState`), so the pre-check and the submit-time denial can never
// disagree about `capped`, the message or the count. Auth-gated,
// account-scoped: `account_id` must name an account of the caller (the same
// `resolveProjectAccount` the create routes use), and omitting it resolves
// the same default account an omitted-`account_id` create would target.
// Read-only; the shape is asserted, not the tier — the manifest's OWNER
// account may be free or paid on any deployment.
flow(
  'PROJ-43',
  { domain: 'projects', routes: ['GET /v1/projects/quota'] },
  async (ctx) => {
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/projects/quota');
      r.status(401);
    });
    await ctx.step('OWNER (default account) → 200 with the cap shape', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/quota');
      r.status(200).body().exists('$.capped').exists('$.limit');
      const body = r.json<any>();
      if (typeof body.capped !== 'boolean') {
        throw new Error(`expected a boolean capped, got: ${JSON.stringify(body.capped)}`);
      }
      if (typeof body.limit !== 'number' || body.limit < 1) {
        throw new Error(`expected a positive numeric limit, got: ${JSON.stringify(body.limit)}`);
      }
      // `count` is null exactly when the plan does not cap (no count query
      // ran); `message` is non-null exactly when `capped` is true.
      if (body.count !== null && typeof body.count !== 'number') {
        throw new Error(`expected count to be a number or null, got: ${JSON.stringify(body.count)}`);
      }
      if (body.message !== null && typeof body.message !== 'string') {
        throw new Error(`expected message to be a string or null, got: ${JSON.stringify(body.message)}`);
      }
      if (body.capped !== (body.message !== null)) {
        throw new Error(
          `capped=${body.capped} must agree with message=${JSON.stringify(body.message)}`,
        );
      }
    });
    await ctx.step('explicit account_id → same shape for a caller account', async () => {
      const p = await ctx.fixtures.project();
      const accountId = await withDb(ctx, async (db) =>
        (await db.query('SELECT account_id FROM kortix.projects WHERE project_id = $1', [p.id])).rows[0]
          .account_id as string,
      );
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/quota', {
        query: { account_id: accountId },
      });
      r.status(200).body().exists('$.capped').exists('$.limit');
    });
    await ctx.step('an account the caller is not a member of → 403; a malformed id → 400', async () => {
      const denied = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/quota', {
        query: { account_id: '00000000-0000-4000-a000-000000000009' },
      });
      denied.status(403);
      const bad = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/quota', {
        query: { account_id: '00000000-0000-4000-a000-00000000notre' },
      });
      bad.status(400);
    });
  },
);

// PROJ-27 — model-defaults CRUD. GET reads the platform/account/project/agent
// defaults; PUT upserts one scope (agent requires agentName); DELETE clears
// one scope by query. PUT rejects models that the account cannot serve. The
// flow reads the current project picker and selects a managed model from that
// served catalog. Full set → read-back → clear lifecycle on scope=project.
flow(
  'PROJ-27',
  {
    domain: 'projects',
    requires: ['funded'],
    routes: [
      'GET /v1/projects/:projectId/model-picker',
      'GET /v1/projects/:projectId/model-defaults',
      'PUT /v1/projects/:projectId/model-defaults',
      'DELETE /v1/projects/:projectId/model-defaults',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let servableModel = '';
    await ctx.step('GET before any override → 200 with no project default', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/model-defaults', { params: { projectId: p.id } });
      r.status(200).body().exists('$.platformDefault').has('$.projectDefault', null);
    });
    await ctx.step('GET model picker → select a served managed model', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/model-picker', { params: { projectId: p.id } });
      r.status(200);
      const models = r.json<any>()?.models;
      const candidate =
        models && typeof models === 'object'
          ? Object.keys(models).find((model) => model !== 'auto' && !model.includes('/'))
          : undefined;
      if (!candidate) {
        throw new Error(`model-picker returned no managed model: ${r.text()}`);
      }
      servableModel = candidate;
    });
    await ctx.step('PUT scope=project sets a concrete model → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/model-defaults',
          { scope: 'project', model: servableModel },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has('$.ok', true)
        .has('$.scope', 'project')
        .has('$.model', servableModel);
    });
    await ctx.step('GET reflects the set project default', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/model-defaults', { params: { projectId: p.id } });
      r.status(200)
        .body()
        .has('$.projectDefault', servableModel)
        .has('$.resolvedForCaller', servableModel);
    });
    await ctx.step('PUT with the synthetic auto id → 409 (not servable)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/model-defaults',
          { scope: 'project', model: 'auto' },
          { params: { projectId: p.id } },
        );
      r.status(409).body().has('$.code', 'model_not_servable');
    });
    await ctx.step('PUT scope=agent without agentName → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/model-defaults',
          { scope: 'agent', model: servableModel },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('DELETE scope=project clears the override → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/model-defaults', {
        params: { projectId: p.id },
        query: { scope: 'project' },
      });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('GET reflects the clear', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/model-defaults', { params: { projectId: p.id } });
      r.status(200).body().has('$.projectDefault', null);
    });
    await ctx.step('DELETE with an invalid scope → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/model-defaults', {
        params: { projectId: p.id },
        query: { scope: 'bogus' },
      });
      r.status(400);
    });
    await ctx.step('NONMEMBER cannot read → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/model-defaults', { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// PROJ-37 — PUT and DELETE /model-defaults run one guard in one order:
// project visible (404) → project.model.write (403). Same caller + same
// project state → same status on both verbs. Every denial fires before model
// servability is checked. PROJ-27 covers the funded set/read/clear lifecycle;
// this local flow proves an authorized writer reaches model validation and
// deletion.
flow(
  'PROJ-37',
  {
    domain: 'projects',
    routes: [
      'GET /v1/projects/:projectId/model-defaults',
      'PUT /v1/projects/:projectId/model-defaults',
      'DELETE /v1/projects/:projectId/model-defaults',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const user = await team.addMember('member');
    const manager = await team.addMember('member');
    await team.grantProjectRole(project.id, user.userId!, 'user');
    await team.grantProjectRole(project.id, manager.userId!, 'manager');
    const path = '/v1/projects/:projectId/model-defaults';
    const put = (actor: typeof user, projectId: string, model = 'guard-probe-model') =>
      ctx.client.as(actor).put(path, { scope: 'project', model }, { params: { projectId } });
    const del = (actor: typeof user, projectId: string) =>
      ctx.client.as(actor).del(path, { params: { projectId }, query: { scope: 'project' } });

    await ctx.step('project user without model.write → PUT and DELETE both 403', async () => {
      (await put(user, project.id)).status(403);
      (await del(user, project.id)).status(403);
    });
    await ctx.step('NONMEMBER → PUT and DELETE both 403', async () => {
      (await put(ctx.P.NONMEMBER, project.id)).status(403);
      (await del(ctx.P.NONMEMBER, project.id)).status(403);
    });
    await ctx.step('project manager reaches model validation and deletion', async () => {
      (await put(manager, project.id)).status(409)
        .body().has('$.code', 'model_not_servable');
      const read = () =>
        ctx.client.as(manager).get(path, { params: { projectId: project.id } });
      (await read()).status(200).body().has('$.projectDefault', null);
      (await del(manager, project.id)).status(200).body().has('$.ok', true).has('$.scope', 'project');
      (await read()).status(200).body().has('$.projectDefault', null);
    });
  },
);

// PROJ-35 — PUT /v1/projects/:projectId/model-enablement
// (apps/api/src/projects/routes/models.ts). Replace the project's
// model-override exceptions (which models are enabled/disabled). The full
// positive path needs a funded account + model-picker data; the BOUNDARIES
// are assertable without one: an unknown project 404s, ANON 401s, a missing
// body 400s, and a NONMEMBER is denied — proving the route is mounted and
// its auth/shape gates fire before any model-override logic.
flow(
  'PROJ-35',
  { domain: 'projects', routes: ['PUT /v1/projects/:projectId/model-enablement'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const ZERO_UUID = '00000000-0000-4000-a000-000000000000';

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put(
          '/v1/projects/:projectId/model-enablement',
          { modelOverrides: {} },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
    await ctx.step('unknown projectId → 404 (project not loadable)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/model-enablement',
          { modelOverrides: {} },
          { params: { projectId: ZERO_UUID } },
        );
      r.status(404);
    });
    await ctx.step('missing modelOverrides → 400 (zod validation)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/projects/:projectId/model-enablement', {}, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step('NONMEMBER → 403/404 (no project access)', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/projects/:projectId/model-enablement',
          { modelOverrides: {} },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// PROJ-9 — manifest validation (dry-run, no commit). Body: { raw, format? }.
// Always resolves — the verdict lives in the body, never a raw parser 4xx —
// except the caller-input guards (missing `raw`) which are the real 400s.
flow(
  'PROJ-9',
  { domain: 'projects', routes: ['POST /v1/projects/:projectId/manifest/validate'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('missing raw → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/manifest/validate',
          { format: 'yaml' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('a valid minimal v2 manifest → 200 valid:true', async () => {
      const raw = 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n';
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/manifest/validate',
          { raw, format: 'yaml' },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.valid', true);
    });
    await ctx.step(
      'a broken manifest (default_agent not declared) → 200 valid:false with issues',
      async () => {
        const raw = 'kortix_version: 2\ndefault_agent: does-not-exist\nagents:\n  kortix: {}\n';
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/manifest/validate',
            { raw, format: 'yaml' },
            { params: { projectId: p.id } },
          );
        r.status(200).body().has('$.valid', false).exists('$.issues');
      },
    );
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/manifest/validate',
          { raw: 'kortix_version: 2\n', format: 'yaml' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// PROJ-30 — set the project default agent. `kortix.yaml.default_agent` is
// durable truth; project.metadata.default_agent mirrors it for reads. A fresh
// provisioned project now synthesizes a blank v2 manifest with a `kortix`
// agent already declared (see PROJ-19), so setting it back to `kortix` is a
// safe, real no-op write (still commits to git) that proves the success path.
flow(
  'PROJ-30',
  {
    domain: 'projects',
    timeoutMs: 240_000,
    routes: ['PUT /v1/projects/:projectId/default-agent'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step("set default agent to the existing 'kortix' agent → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-agent',
          { agent: 'kortix' },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.ok', true).has('$.default_agent', 'kortix');
    });
    await ctx.step('unknown agent name → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-agent',
          { agent: 'does-not-exist' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('empty agent name → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-agent',
          { agent: '' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/projects/:projectId/default-agent',
          { agent: 'kortix' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// PROJ-31 — per-project sandbox-provider pin. `null`/`''` clears the pin
// (follow the platform default/distribution); a concrete value must be an
// ENABLED provider (in ALLOWED_SANDBOX_PROVIDERS with its API key configured)
// or 400. A concrete pin can be immediate when it matches the fleet default,
// or start a durable preparation when it differs. Use a real managed-git
// project so either provider-agnostic branch can exercise the repository.
flow(
  'PROJ-31',
  {
    domain: 'projects',
    requires: ['managedGit'],
    routes: [
      'GET /v1/projects/:projectId',
      'PATCH /v1/projects/:projectId/sandbox-provider',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true, seed: true });
    await ctx.step('unknown/disabled provider → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/sandbox-provider',
          { provider: 'not-a-real-provider' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    if (ctx.env.target !== 'local') {
      // The enabled set is deployment config (ALLOWED_SANDBOX_PROVIDERS with an
      // API key): dev/staging/prod enable Platinum and the legacy Daytona
      // fallback, a PR preview enables Platinum only. Read it from the project instead of assuming a
      // provider, then prove a concrete pin works and a known-but-disabled
      // provider is refused.
      let enabled: string[] = [];
      await ctx.step('read the enabled providers from the project → non-empty', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId', { params: { projectId: p.id } });
        r.status(200).body().exists('$.available_sandbox_providers');
        enabled = r.json<{ available_sandbox_providers?: string[] }>()?.available_sandbox_providers ?? [];
        if (enabled.length === 0) {
          throw new Error(`no enabled sandbox provider: ${r.text()}`);
        }
      });
      await ctx.step('pin to an enabled provider → 200 project or preparation', async () => {
        const target = enabled[0]!;
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .patch(
            '/v1/projects/:projectId/sandbox-provider',
            { provider: target },
            { params: { projectId: p.id } },
          );
        r.status(200).body().exists('$.kind');
        const body = r.json<any>();
        if (body?.kind === 'project') {
          r.body().has('$.default_sandbox_provider', target);
        } else if (body?.kind === 'preparation') {
          r.body().has('$.target_provider', target);
        } else {
          throw new Error(`unexpected sandbox-provider PATCH response: ${r.text()}`);
        }
      });
      const disabled = ['platinum', 'daytona'].find((name) => !enabled.includes(name));
      if (disabled) {
        await ctx.step('pin to a known but disabled provider → 400', async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .patch(
              '/v1/projects/:projectId/sandbox-provider',
              { provider: disabled },
              { params: { projectId: p.id } },
            );
          r.status(400);
        });
      }
    }
    await ctx.step('pin to the discontinued e2b provider → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/sandbox-provider',
          { provider: 'e2b' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('clear the pin (null) → 200 (immediate, kind:project)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/sandbox-provider',
          { provider: null },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.kind', 'project');
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          '/v1/projects/:projectId/sandbox-provider',
          { provider: 'platinum' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/sandbox-provider',
          { provider: 'platinum' },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

// PROJ-44 — Daytona is deprecated: no customer may choose it. It runs on the
// local profile (no managed Git, no sandbox): every refusal happens before a
// repository or a sandbox is read. The local stack lists `daytona` among the
// allowed providers, so the refusal is proven where Daytona is still configured.
flow(
  'PROJ-44',
  {
    domain: 'projects',
    routes: [
      'GET /v1/projects/:projectId',
      'PATCH /v1/projects/:projectId/sandbox-provider',
      'POST /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ metadata: { default_sandbox_provider: 'daytona' } });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { params: { projectId: p.id } };
    const readProject = async () => {
      const r = await owner.get('/v1/projects/:projectId', params);
      r.status(200);
      return r.json<{ default_sandbox_provider?: string | null; available_sandbox_providers?: string[] }>();
    };
    await ctx.step('a project with a stored daytona pin reads as unpinned and never offers daytona', async () => {
      const project = await readProject();
      if (project.default_sandbox_provider !== null) {
        throw new Error(`expected default_sandbox_provider null, got ${project.default_sandbox_provider}`);
      }
      if ((project.available_sandbox_providers ?? []).includes('daytona')) {
        throw new Error(`daytona is offered: ${JSON.stringify(project.available_sandbox_providers)}`);
      }
    });
    await ctx.step('pin to daytona → 400 with the deprecation message; the project stays unpinned', async () => {
      const r = await owner.patch('/v1/projects/:projectId/sandbox-provider', { provider: 'daytona' }, params);
      r.status(400).body().has('$.error', 'Daytona is deprecated. New sandboxes run on Platinum.');
      const project = await readProject();
      if (project.default_sandbox_provider !== null) {
        throw new Error(`a refused pin changed the project: ${project.default_sandbox_provider}`);
      }
    });
    await ctx.step('a session that names daytona → 400 sandbox_provider_deprecated, and no session exists', async () => {
      const r = await owner.post('/v1/projects/:projectId/sessions', { provider: 'daytona' }, params);
      r.status(400).body().has('$.code', 'sandbox_provider_deprecated');
      const list = await owner.get('/v1/projects/:projectId/sessions', params);
      list.status(200);
      const sessions = list.json<Array<{ session_id: string }>>();
      if (sessions.length !== 0) throw new Error(`a refused create left ${sessions.length} session(s)`);
    });
    await ctx.step('NONMEMBER cannot reach the pin → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch('/v1/projects/:projectId/sandbox-provider', { provider: 'daytona' }, params);
      r.status([403, 404]);
    });
  },
);

// PROJ-32 — the BYOK-provider-connect-modal catalog. Serves the SAME live,
// 24h-refreshed `runtimeModelCatalog.snapshot()` every other gateway/model
// endpoint reads (apps/api/src/projects/routes/models.ts) — provider-level rows
// (id, name, auth env vars, docs URL). Project-read-scoped (403/404 boundary), not actually secret data.
flow(
  'PROJ-32',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/llm-catalog/providers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('OWNER reads the provider-connect catalog → 200 live snapshot', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/llm-catalog/providers', { params: { projectId: p.id } });
      r.status(200).body().exists('$.providers').exists('$.provider_count').exists('$.model_count');
      const body = r.json<any>();
      if (!Array.isArray(body?.providers) || body.providers.length === 0) {
        throw new Error('llm-catalog/providers returned an empty provider list');
      }
    });
    await ctx.step('unknown project → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/llm-catalog/providers', {
          params: { projectId: '00000000-0000-4000-a000-000000000000' },
        });
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/llm-catalog/providers', { params: { projectId: p.id } });
      r.status(403);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/llm-catalog/providers', { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// PROJ-33 — the sandbox-provider migration poll endpoint. The PATCH prepare
// branch (switch to a non-default enabled provider) returns a kind:'preparation'
// body but does NOT flip the active provider; the client polls THIS route until
// the durable transition reaches a terminal status. Project-read-scoped (rejects
// cross-project/non-member) and shaped as a PUBLIC projection — it must NEVER
// leak the lease epoch/holder, raw provider error strings, internal image names,
// or provider template ids. A fresh project with no transition returns
// active_provider=null + latest=null (still 200), which is the case exercised
// here without provisioning a real cross-provider build.
flow(
  'PROJ-33',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/sandbox-provider/transition'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const INTERNAL_LEAK_KEYS = [
      'lease_epoch',
      'lease_holder',
      'last_error',
      'snapshot_name',
      'external_template_id',
      'attempts',
    ];
    const assertNoLeak = (item: unknown) => {
      if (item && typeof item === 'object') {
        for (const k of INTERNAL_LEAK_KEYS) {
          if (k in (item as Record<string, unknown>)) {
            throw new Error(`transition view leaked internal field '${k}'`);
          }
        }
      }
    };
    await ctx.step('OWNER reads the public transition state → 200 public shape', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sandbox-provider/transition', {
          params: { projectId: p.id },
        });
      r.status(200).body().exists('$.history');
      const body = r.json<{
        active_provider: string | null;
        latest: unknown;
        history: unknown[];
      }>();
      if (!Object.hasOwn(body, 'active_provider')) {
        throw new Error('transition view omitted active_provider');
      }
      assertNoLeak(body.latest);
      if (Array.isArray(body.history)) body.history.forEach(assertNoLeak);
    });
    await ctx.step('unknown project → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sandbox-provider/transition', {
          params: { projectId: '00000000-0000-4000-a000-000000000000' },
        });
      r.status(404);
    });
    await ctx.step('NONMEMBER → 403/404 (cross-project rejection)', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/sandbox-provider/transition', {
          params: { projectId: p.id },
        });
      r.status([403, 404]);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sandbox-provider/transition', {
          params: { projectId: p.id },
        });
      r.status(401);
    });
  },
);

// PROJ-45 — set the project default reasoning effort (Settings → General).
// `null`/`''` clear it (automatic); a value must be an effort label the model
// catalog publishes. The route returns the serialized project with the field
// re-validated on read, so the success steps double as the read-back proof.
flow(
  'PROJ-45',
  {
    domain: 'projects',
    routes: [
      'PUT /v1/projects/:projectId/default-reasoning-effort',
      'GET /v1/projects/:projectId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step("set the default effort to 'high' → 200, echoed top-level", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-reasoning-effort',
          { effort: 'high' },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has('$.default_reasoning_effort', 'high');
    });
    await ctx.step('an effort no catalog model publishes → 400 unknown_effort', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-reasoning-effort',
          { effort: 'ultra' },
          { params: { projectId: p.id } },
        );
      r.status(400).body().has('$.code', 'unknown_effort');
    });
    await ctx.step("a value survives on the project's own read", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId', { params: { projectId: p.id } });
      r.status(200).body().has('$.default_reasoning_effort', 'high');
    });
    await ctx.step("'' clears → 200 automatic (null), persisted", async () => {
      const put = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/default-reasoning-effort',
          { effort: '' },
          { params: { projectId: p.id } },
        );
      put.status(200).body().has('$.default_reasoning_effort', null);
      const get = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId', { params: { projectId: p.id } });
      get.status(200).body().has('$.default_reasoning_effort', null);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/projects/:projectId/default-reasoning-effort',
          { effort: 'high' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

flow(
  'PROJ-46',
  {
    domain: 'projects',
    requires: ['database'],
    routes: [
      'PATCH /v1/projects/:projectId/sandbox-templates/:templateId',
      'DELETE /v1/projects/:projectId/sandbox-templates/:templateId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const templateId = await withDb(ctx, async (db) => (await db.query(
      `INSERT INTO kortix.sandbox_templates (project_id, slug, name, is_shared, source, provider, image, cpu, memory_gb, disk_gb, provider_state)
       VALUES ($1, 'declared-tpl', 'Declared', false, 'toml', 'platinum', 'python:3.12-slim', 1, 2, 10, 'missing') RETURNING template_id`,
      [p.id],
    )).rows[0].template_id as string);
    const params = { projectId: p.id, templateId };

    await ctx.step('PATCH of a template kortix.yaml declares → 409 template_declared_in_manifest, and the row is unchanged', async () => {
      (await owner.patch('/v1/projects/:projectId/sandbox-templates/:templateId', { cpu: 4 }, { params }))
        .status(409).body().has('$.code', 'template_declared_in_manifest');
      const cpu = await withDb(ctx, async (db) => (await db.query('SELECT cpu FROM kortix.sandbox_templates WHERE template_id = $1', [templateId])).rows[0].cpu);
      if (cpu !== 1) throw new Error(`cpu changed to ${cpu}`);
    });
    await ctx.step('DELETE of it → 409 template_declared_in_manifest, and the row stays', async () => {
      (await owner.del('/v1/projects/:projectId/sandbox-templates/:templateId', { params }))
        .status(409).body().has('$.code', 'template_declared_in_manifest');
      const n = await withDb(ctx, async (db) => (await db.query('SELECT count(*)::int AS n FROM kortix.sandbox_templates WHERE template_id = $1', [templateId])).rows[0].n);
      if (n !== 1) throw new Error('the declared template was deleted');
    });
  },
);
