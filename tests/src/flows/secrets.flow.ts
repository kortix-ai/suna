/**
 * Project secrets — manage-gated CRUD + validation. Maps to spec §19 (SEC-1/2/3).
 */
import { flow } from "../core/flow";
import { createDatabaseSession } from '../fixtures/database-project';
import { subscribe } from '../fixtures/billing';

flow(
  "SEC-POOL-1",
  {
    domain: "secrets",
    routes: [
      "POST /v1/accounts/:accountId/secret-resources",
      "GET /v1/accounts/:accountId/secret-resources",
      "PUT /v1/accounts/:accountId/secret-resources/:secretId/value",
      "DELETE /v1/accounts/:accountId/secret-resources/:secretId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const path = "/v1/accounts/:accountId/secret-resources";
    const params = { accountId: team.id };
    const ids: string[] = [];
    for (const label of ["Primary", "Backup"]) {
      await ctx.step(`create ${label} provider key → separate stable ID`, async () => {
        const response = await ctx.client.as(ctx.P.OWNER).post(path, {
          label, provider_id: "anthropic", name: "ANTHROPIC_API_KEY",
          value: `${label.toLowerCase()}-test-value`, consumer: "llm_gateway", strategy: "broker",
        }, { params });
        response.status(201).body().has("$.label", label).exists("$.secret_id");
        const body = response.json<any>();
        if ("value" in body || "value_enc" in body) throw new Error("secret value leaked in create response");
        ids.push(body.secret_id);
      });
    }
    await ctx.step("list two keys without values; nonmember is denied", async () => {
      const list = await ctx.client.as(ctx.P.OWNER).get(path, { params });
      list.status(200);
      const keys = list.json<any>().secrets as any[];
      if (ids.some((id) => !keys.some((key) => key.secret_id === id))) throw new Error("created key missing from list");
      if (keys.some((key) => "value" in key || "value_enc" in key)) throw new Error("secret value leaked in list");
      (await ctx.client.as(ctx.P.NONMEMBER).get(path, { params })).status(403);
    });
    await ctx.step("rotate primary without changing ID", async () => {
      const response = await ctx.client.as(ctx.P.OWNER).put(`${path}/:secretId/value`,
        { value: "rotated-test-value" }, { params: { ...params, secretId: ids[0]! } });
      response.status(200).body().has("$.secret_id", ids[0]!);
      if ("value" in response.json<any>()) throw new Error("secret value leaked in rotation response");
    });
    await ctx.step("delete primary; backup remains", async () => {
      (await ctx.client.as(ctx.P.OWNER).del(`${path}/:secretId`, { params: { ...params, secretId: ids[0]! } })).status(200);
      const list = await ctx.client.as(ctx.P.OWNER).get(path, { params });
      const keys = list.json<any>().secrets as any[];
      if (keys.some((key) => key.secret_id === ids[0]) || !keys.some((key) => key.secret_id === ids[1])) {
        throw new Error("deletion changed the wrong key");
      }
      (await ctx.client.as(ctx.P.OWNER).del(`${path}/:secretId`, { params: { ...params, secretId: ids[1]! } })).status(200);
    });
  },
);

flow(
  "SEC-POOL-2",
  {
    domain: "secrets",
    routes: [
      "POST /v1/accounts/:accountId/secret-resources",
      "PUT /v1/accounts/:accountId/secret-resources/:secretId/grants/:userId",
      "DELETE /v1/accounts/:accountId/secret-resources/:secretId/grants/:userId",
      "GET /v1/accounts/:accountId/secret-resources",
      "PATCH /v1/projects/:projectId/features",
      "GET /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools/:providerId",
      "GET /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools",
      "PUT /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools/:providerId",
      "POST /v1/projects/:projectId/sessions",
      "PUT /v1/projects/:projectId/sessions/:sessionId/model",
      "PUT /v1/projects/:projectId/sessions/:sessionId/sharing",
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "DELETE /v1/accounts/:accountId/secret-resources/:secretId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ seed: true, allowAllSecrets: true });
    const session = await ctx.fixtures.session(project);
    const member = await team.addMember('member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const resourcePath = '/v1/accounts/:accountId/secret-resources';
    const poolPath = '/v1/projects/:projectId/sessions/:sessionId/provider-secret-pools/:providerId';
    const poolsPath = '/v1/projects/:projectId/sessions/:sessionId/provider-secret-pools';
    const resourceParams = { accountId: team.id };
    const poolParams = { projectId: project.id, sessionId: session.id, providerId: 'anthropic' };
    const ids: string[] = [];
    for (const label of ['Primary', 'Backup']) {
      const result = await owner.post(resourcePath, {
        label, provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
        value: `${label.toLowerCase()}-test-value`, consumer: 'llm_gateway', strategy: 'broker',
      }, { params: resourceParams });
      result.status(201);
      ids.push(result.json<any>().secret_id);
    }
    await ctx.step('flag off → session pool routes deny access', async () => {
      (await owner.get(poolPath, { params: poolParams })).status(403);
      (await owner.get(poolsPath, { params: poolParams })).status(403);
      (await owner.post('/v1/projects/:projectId/sessions', {
        provider_secret_pools: { anthropic: ids },
      }, { params: { projectId: project.id } })).status(403);
    });
    await ctx.step('member sees only granted resources', async () => {
      const memberPath = `${resourcePath}/:secretId/grants/:userId`;
      const grantParams = { ...resourceParams, secretId: ids[0]!, userId: member.userId! };
      (await owner.put(memberPath, {}, { params: grantParams })).status(200);
      const visible = await ctx.client.as(member).get(resourcePath, { params: resourceParams });
      visible.status(200);
      const seen = visible.json<any>().secrets as any[];
      if (seen.length !== 1 || seen[0].secret_id !== ids[0]) throw new Error('member grant did not isolate keys');
      (await owner.del(memberPath, { params: grantParams })).status(200);
      const revoked = await ctx.client.as(member).get(resourcePath, { params: resourceParams });
      revoked.status(200);
      if (revoked.json<any>().secrets.length !== 0) throw new Error('revoked key is still visible');
    });
    await ctx.step('account owner can manage a resource without its use grant', async () => {
      const created = await ctx.client.as(member).post(resourcePath, {
        label: 'Member owned', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
        value: 'member-test-value', consumer: 'llm_gateway', strategy: 'broker',
      }, { params: resourceParams });
      created.status(201);
      const id = created.json<any>().secret_id as string;
      const list = await owner.get(resourcePath, { params: resourceParams });
      const managed = (list.json<any>().secrets as any[]).find((secret) => secret.secret_id === id);
      if (!managed || managed.can_use !== false) throw new Error('owner could not see ungranted resource metadata');
      (await owner.del(`${resourcePath}/:secretId`, { params: { ...resourceParams, secretId: id } })).status(200);
    });
    await ctx.step('enable gateway and pool flags; select two keys', async () => {
      for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
        (await owner.patch('/v1/projects/:projectId/features', { feature, enabled: true },
          { params: { projectId: project.id } })).status(200);
      }
      const selected = await owner.put(poolPath, { secret_ids: ids }, { params: poolParams });
      if (selected.statusCode !== 200) throw new Error(`pool selection returned ${selected.statusCode}: ${selected.text()}`);
      selected.body().has('$.configured', true).has('$.secret_ids', ids);
      (await owner.get(poolPath, { params: poolParams })).status(200).body().has('$.secret_ids', ids);
      (await owner.get(poolsPath, { params: poolParams })).status(200).body()
        .has('$.can_edit', true).has('$.pools', [{ provider_id: 'anthropic', configured: true, secret_ids: ids }]);
    });
    await ctx.step('an account-key model passes creation preflight with the selected pool', async () => {
      const created = await owner.post('/v1/projects/:projectId/sessions', {
        opencode_model: 'anthropic/claude-sonnet-4.6', provider_secret_pools: { anthropic: ids },
      }, { params: { projectId: project.id } });
      if (ctx.env.target === 'local') {
        created.status(503).body().has('$.code', 'KORTIX_URL_UNREACHABLE');
      } else {
        created.status(201);
        const createdId = created.json<any>().session_id;
        ctx.track('session', createdId, { projectId: project.id });
        (await owner.get(poolPath, { params: { ...poolParams, sessionId: createdId } })).status(200).body().has('$.secret_ids', ids);
      }
      const refused = await owner.post('/v1/projects/:projectId/sessions', {
        opencode_model: 'anthropic/claude-sonnet-4.6', provider_secret_pools: { anthropic: [] },
      }, { params: { projectId: project.id } });
      refused.status(400).body().has('$.code', 'INVALID_SESSION_MODEL');
    });
    await ctx.step('a model on pooled keys needs no key list: create and model change select every usable key', async () => {
      // The CLI, the SDK and chat channels name only a model. This used to
      // answer 400 INVALID_SESSION_MODEL; an explicit empty list above still does.
      const created = await owner.post('/v1/projects/:projectId/sessions', {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params: { projectId: project.id } });
      if (ctx.env.target === 'local') {
        created.status(503).body().has('$.code', 'KORTIX_URL_UNREACHABLE');
      } else {
        created.status(201);
        const createdId = created.json<any>().session_id;
        ctx.track('session', createdId, { projectId: project.id });
        (await owner.get(poolPath, { params: { ...poolParams, sessionId: createdId } })).status(200).body().has('$.secret_ids', ids);
      }
      (await owner.put(poolPath, { secret_ids: null }, { params: poolParams })).status(200).body().has('$.configured', false);
      (await owner.put('/v1/projects/:projectId/sessions/:sessionId/model', {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params: poolParams })).status(200).body().has('$.opencode_model', 'kortix/anthropic/claude-sonnet-4.6');
      (await owner.get(poolPath, { params: poolParams })).status(200).body().has('$.configured', true).has('$.secret_ids', ids);
    });
    await ctx.step('a shared session uses only keys shared with the whole project', async () => {
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const memberSession = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: member.userId!, visibility: 'project',
      });
      const params = { ...poolParams, sessionId: memberSession };
      (await owner.put(poolPath, { secret_ids: ids }, { params })).status(403);
      for (const secretId of ids) {
        (await owner.put(`${resourcePath}/:secretId/grants/:userId`, {}, {
          params: { ...resourceParams, secretId, userId: member.userId! },
        })).status(200);
      }
      // Granted to the member, but the session is shared: the gateway serves it
      // with no personal user, so a member-granted key would never be used.
      (await owner.put(poolPath, { secret_ids: ids }, { params })).status(403)
        .body().has('$.code', 'SHARED_SESSION_PERSONAL_KEY');
      (await ctx.client.as(member).put(poolPath, { secret_ids: ids }, { params })).status(403)
        .body().has('$.code', 'SHARED_SESSION_PERSONAL_KEY');
      (await owner.get(poolPath, { params })).status(200).body().has('$.configured', false);
      // A model only those keys reach is refused, not accepted and then failed on every turn.
      (await owner.put('/v1/projects/:projectId/sessions/:sessionId/model', {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params })).status(400).body().has('$.code', 'INVALID_SESSION_MODEL');
    });
    await ctx.step('a private session selects keys granted to its owner', async () => {
      const privateSession = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: member.userId!, visibility: 'private',
      });
      const params = { ...poolParams, sessionId: privateSession };
      const asMember = ctx.client.as(member);
      (await asMember.put(poolPath, { secret_ids: ids }, { params })).status(200);
      (await asMember.get(poolPath, { params })).status(200).body().has('$.secret_ids', ids);
      (await asMember.put('/v1/projects/:projectId/sessions/:sessionId/model', {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params })).status(200).body().has('$.opencode_model', 'kortix/anthropic/claude-sonnet-4.6');
    });
    await ctx.step('sharing a session that runs on keys granted to its owner switches it to keys shared with the project', async () => {
      const privateSession = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: member.userId!, visibility: 'private',
      });
      const params = { ...poolParams, sessionId: privateSession };
      const sessionPath = '/v1/projects/:projectId/sessions/:sessionId';
      const asMember = ctx.client.as(member);
      (await asMember.put(poolPath, { secret_ids: ids }, { params })).status(200);
      (await asMember.put(`${sessionPath}/model`, {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params })).status(200);
      // A shared session uses nobody's personal keys: with no key shared with
      // the project, the share would leave the model with none. Refused, unchanged.
      (await asMember.put(`${sessionPath}/sharing`, { mode: 'project' }, { params })).status(409)
        .body().has('$.code', 'SHARED_SESSION_NEEDS_PROJECT_KEY');
      (await asMember.get(sessionPath, { params })).status(200).body().has('$.visibility', 'private');
      (await asMember.get(poolPath, { params })).status(200).body().has('$.secret_ids', ids);

      const shared = await owner.post(resourcePath, {
        project_id: project.id, label: 'Project key', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
        value: 'project-key-test-value', consumer: 'llm_gateway', strategy: 'broker',
      }, { params: resourceParams });
      shared.status(201).body().has('$.access_mode', 'project');
      const projectKey = shared.json<any>().secret_id as string;
      (await asMember.put(`${sessionPath}/sharing`, { mode: 'project' }, { params })).status(200)
        .body().has('$.visibility', 'project');
      (await asMember.get(poolPath, { params })).status(200).body().has('$.secret_ids', [projectKey]);
      // The shared session still runs its model, now on the project's key.
      (await asMember.put(`${sessionPath}/model`, {
        opencode_model: 'anthropic/claude-sonnet-4.6',
      }, { params })).status(200);
      (await owner.del(`${resourcePath}/:secretId`, { params: { ...resourceParams, secretId: projectKey } })).status(200);
    });
    await ctx.step('create rejects a secret ID without a grant before provisioning', async () => {
      const created = await owner.post('/v1/projects/:projectId/sessions', {
        provider_secret_pools: { anthropic: ['11111111-1111-4111-8111-111111111111'] },
        pending_prompt: { text: 'hello' },
      }, { params: { projectId: project.id } });
      created.status(403);
    });
    await ctx.step('deleting one key prunes only that selection', async () => {
      (await owner.del(`${resourcePath}/:secretId`, { params: { ...resourceParams, secretId: ids[0]! } })).status(200);
      (await owner.get(poolPath, { params: poolParams })).status(200).body().has('$.secret_ids', [ids[1]]);
    });
    await ctx.step('reset selection to inherited behavior', async () => {
      (await owner.del(`${resourcePath}/:secretId`, { params: { ...resourceParams, secretId: ids[1]! } })).status(200);
      (await owner.get(poolsPath, { params: poolParams })).status(200).body()
        .has('$.pools', [{ provider_id: 'anthropic', configured: true, secret_ids: [] }]);
      (await owner.put(poolPath, { secret_ids: null }, { params: poolParams })).status(200)
        .body().has('$.configured', false).has('$.secret_ids', []);
      (await owner.get(poolsPath, { params: poolParams })).status(200).body().has('$.pools', []);
    });
  },
);

flow('SEC-POOL-4', {
  domain: 'secrets',
  routes: [
    'PATCH /v1/projects/:projectId/features',
    'PUT /v1/projects/:projectId/agents/:agentName/config',
    'PUT /v1/projects/:projectId/access/:userId',
    'POST /v1/accounts/:accountId/secret-resources',
    'GET /v1/accounts/:accountId/secret-resources',
    'PUT /v1/accounts/:accountId/secret-resources/:secretId/access',
    'POST /v1/projects/:projectId/sessions',
    'DELETE /v1/accounts/:accountId/secret-resources/:secretId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team();
  if (ctx.env.target !== 'local') {
    await ctx.step('fund the isolated account for two managed projects', async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id);
    });
  }
  const project = await team.project({ seed: true, allowAllSecrets: true });
  const otherProject = await team.project({ seed: true, allowAllSecrets: true });
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'user');
  const owner = ctx.client.as(ctx.P.OWNER);
  await ctx.step('grant the other project agent access to the provider', async () => {
    (await owner.put('/v1/projects/:projectId/agents/:agentName/config',
      { secrets: ['ANTHROPIC_API_KEY'] },
      { params: { projectId: otherProject.id, agentName: 'kortix' } })).status(200);
  });
  const path = '/v1/accounts/:accountId/secret-resources';
  const params = { accountId: team.id };
  const listPath = `${path}?project_id=${project.id}`;
  const input = { project_id: project.id, label: 'Project key', provider_id: 'anthropic',
    name: 'ANTHROPIC_API_KEY', value: 'project-key-test-value', consumer: 'llm_gateway', strategy: 'broker' };
  await ctx.step('flag off rejects a project-scoped credential', async () => {
    (await owner.post(path, input, { params })).status(403);
  });
  for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
    (await owner.patch('/v1/projects/:projectId/features', { feature, enabled: true },
      { params: { projectId: project.id } })).status(200);
  }
  let secretId = '';
  await ctx.step('new key defaults to everyone in the project', async () => {
    const created = await owner.post(path, input, { params });
    created.status(201).body().has('$.access_mode', 'project').has('$.project_id', project.id);
    secretId = created.json<any>().secret_id;
    const visible = await ctx.client.as(member).get(listPath, { params });
    visible.status(200);
    const row = (visible.json<any>().secrets as any[]).find((secret) => secret.secret_id === secretId);
    if (!row || row.can_use !== true || 'value' in row || 'value_enc' in row) throw new Error('project member cannot use project key');
    const other = await owner.get(`${path}?project_id=${otherProject.id}`, { params });
    other.status(200);
    if ((other.json<any>().secrets as any[]).some((secret) => secret.secret_id === secretId)) throw new Error('key leaked into another project');
    for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
      (await owner.patch('/v1/projects/:projectId/features', { feature, enabled: true },
        { params: { projectId: otherProject.id } })).status(200);
    }
    (await owner.post('/v1/projects/:projectId/sessions', {
      agent_name: 'kortix', provider_secret_pools: { anthropic: [secretId] },
    }, { params: { projectId: otherProject.id } })).status(403)
      .body().has('$.error', 'Secret unavailable or not granted');
  });
  await ctx.step('selected-member mode revokes and restores access atomically', async () => {
    const accessPath = `${path}/:secretId/access`;
    const accessParams = { ...params, secretId };
    (await owner.put(accessPath, { mode: 'members', user_ids: [] }, { params: accessParams })).status(200)
      .body().has('$.access_mode', 'members');
    const restricted = await ctx.client.as(member).get(listPath, { params });
    restricted.status(200);
    if ((restricted.json<any>().secrets as any[]).some((secret) => secret.secret_id === secretId)) throw new Error('restricted key leaked to member');
    (await owner.put(accessPath, { mode: 'members', user_ids: [member.userId] }, { params: accessParams })).status(200);
    const granted = await ctx.client.as(member).get(listPath, { params });
    granted.status(200);
    if (!(granted.json<any>().secrets as any[]).some((secret) => secret.secret_id === secretId && secret.can_use)) throw new Error('member grant did not restore access');
    (await owner.put(accessPath, { mode: 'project', user_ids: [] }, { params: accessParams })).status(200)
      .body().has('$.access_mode', 'project');
  });
  await ctx.step('delete removes the scoped key', async () => {
    (await owner.del(`${path}/:secretId`, { params: { ...params, secretId } })).status(200);
    const listed = await owner.get(listPath, { params });
    listed.status(200);
    if ((listed.json<any>().secrets as any[]).some((secret) => secret.secret_id === secretId)) throw new Error('deleted key remained visible');
  });
});

// Bring your own ChatGPT subscription. A plain project member (no
// project.secret.write) connects and reconnects ChatGPT accounts only they can
// use; sharing one stays a manager's secret write. Starting a device flow calls
// OpenAI after every check, so a permitted start answers 200 (device code) or
// 502 (OpenAI unreachable from this runner) — never 403.
flow('SEC-POOL-5', {
  domain: 'secrets', requires: ['database'],
  routes: [
    'PATCH /v1/projects/:projectId/features',
    'POST /v1/projects/:projectId/oauth/:provider/start',
    'GET /v1/accounts/:accountId/secret-resources',
    'DELETE /v1/accounts/:accountId/secret-resources/:secretId',
    'GET /v1/projects/:projectId/model-picker',
  ],
}, async (ctx) => {
  const { Client: PgClient } = await import('pg');
  const { randomUUID } = await import('node:crypto');
  const team = await ctx.fixtures.team();
  const project = await team.project({ seed: true, allowAllSecrets: true });
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'user');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const startPath = '/v1/projects/:projectId/oauth/:provider/start';
  const startParams = { projectId: project.id, provider: 'openai' };
  const resourcePath = '/v1/accounts/:accountId/secret-resources';
  const listPath = `${resourcePath}?project_id=${project.id}`;
  const params = { accountId: team.id };

  await ctx.step('with the flag off, a named ChatGPT account is refused', async () => {
    (await asMember.post(startPath, { resource_label: 'ChatGPT · Member', sharing: { mode: 'private', ownerId: member.userId } },
      { params: startParams })).status(403);
  });
  for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
    (await owner.patch('/v1/projects/:projectId/features', { feature, enabled: true }, { params: { projectId: project.id } })).status(200);
  }

  await ctx.step('a member cannot share a ChatGPT account with the project or another member', async () => {
    (await asMember.post(startPath, { resource_label: 'Team ChatGPT', sharing: { mode: 'project' } }, { params: startParams }))
      .status(403);
    (await asMember.post(startPath, {
      resource_label: 'Team ChatGPT', sharing: { mode: 'members', memberIds: [member.userId, ctx.P.OWNER.userId] },
    }, { params: startParams })).status(403);
  });

  await ctx.step('a member starts a ChatGPT account only they can use, however it is spelled', async () => {
    for (const sharing of [{ mode: 'private', ownerId: member.userId }, { mode: 'members', memberIds: [member.userId] }]) {
      const started = await asMember.post(startPath, { resource_label: 'ChatGPT · Member', sharing }, { params: startParams });
      started.status([200, 502]);
      if (started.statusCode === 200) started.body().exists('$.flow_id').exists('$.user_code');
    }
  });

  // Completing a device login needs a live ChatGPT account, so the accounts
  // are written the way a completed poll writes them.
  const mine = randomUUID();
  const ownersPrivate = randomUUID();
  const databaseUrl = ctx.env.databaseUrl!;
  const database = new PgClient({ connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  await database.connect();
  try {
    for (const [secretId, createdBy, label] of [[mine, member.userId!, 'ChatGPT · Member'], [ownersPrivate, ctx.P.OWNER.userId!, 'ChatGPT · Owner']]) {
      await database.query(`INSERT INTO kortix.account_secret_resources
        (secret_id, account_id, project_id, access_mode, label, provider_id, name, value_enc, consumer, strategy, created_by)
        VALUES ($1, $2, $3, 'members', $4, 'codex', 'CODEX_AUTH_JSON', 'v1:not:a:login', 'llm_gateway', 'broker', $5)`,
      [secretId, team.id, project.id, label, createdBy]);
      await database.query('INSERT INTO kortix.account_secret_grants (secret_id, account_id, user_id, granted_by) VALUES ($1, $2, $3, $3)',
        [secretId, team.id, createdBy]);
    }
  } finally { await database.end(); }

  await ctx.step("the member sees their own account and not the owner's private one", async () => {
    const listed = await asMember.get(listPath, { params });
    listed.status(200);
    const secrets = listed.json<any>().secrets as any[];
    const own = secrets.find((secret) => secret.secret_id === mine);
    if (!own || own.can_use !== true || own.access_mode !== 'members' || 'value' in own) throw new Error('member cannot use their own ChatGPT account');
    if (secrets.some((secret) => secret.secret_id === ownersPrivate)) throw new Error("owner's private ChatGPT account leaked to a member");
  });

  await ctx.step('their account lights up ChatGPT subscription models in their picker', async () => {
    const picker = await asMember.get('/v1/projects/:projectId/model-picker', { params: { projectId: project.id } });
    picker.status(200);
    const ids = Object.keys(picker.json<{ models: Record<string, unknown> }>().models);
    if (!ids.some((id) => id.startsWith('codex/'))) throw new Error(`no ChatGPT subscription model in the member picker: ${ids.join(', ')}`);
  });

  await ctx.step('the member reconnects only their own account, in place', async () => {
    const reconnect = await asMember.post(startPath, { resource_id: mine }, { params: startParams });
    reconnect.status([200, 502]);
    (await asMember.post(startPath, { resource_id: ownersPrivate }, { params: startParams })).status(403)
      .body().has('$.error', 'Only the person who connected this ChatGPT account can reconnect it');
    (await asMember.post(startPath, { resource_id: mine, resource_label: 'Renamed' }, { params: startParams })).status(400);
    (await asMember.post(startPath, { resource_id: randomUUID() }, { params: startParams })).status(404);
  });

  await ctx.step('the member deletes their own account', async () => {
    (await asMember.del(`${resourcePath}/:secretId`, { params: { ...params, secretId: mine } })).status(200);
    const listed = await asMember.get(listPath, { params });
    listed.status(200);
    if ((listed.json<any>().secrets as any[]).some((secret) => secret.secret_id === mine)) throw new Error('deleted ChatGPT account is still listed');
    (await owner.del(`${resourcePath}/:secretId`, { params: { ...params, secretId: ownersPrivate } })).status(200);
  });
});

flow('SEC-POOL-3', {
  domain: 'secrets', requires: ['database'],
  routes: [
    'POST /v1/accounts/tokens',
    'GET /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools',
    'GET /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools/:providerId',
    'PUT /v1/projects/:projectId/sessions/:sessionId/provider-secret-pools/:providerId',
    'POST /v1/llm/chat/completions',
  ],
}, async (ctx) => {
  const { Client: PgClient } = await import('pg');
  const team = await ctx.fixtures.team();
  const project = await team.project({ seed: true, allowAllSecrets: true });
  const owner = ctx.client.as(ctx.P.OWNER);
  const first = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId! });
  const sibling = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId! });
  for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
    (await owner.patch('/v1/projects/:projectId/features', { feature, enabled: true }, { params: { projectId: project.id } })).status(200);
  }
  const minted = await owner.post('/v1/accounts/tokens', { name: 'Pool session isolation', account_id: team.id });
  minted.status(201);
  const credential = minted.json<{ token_id: string; secret_key: string }>();
  const databaseUrl = ctx.env.databaseUrl!;
  const database = new PgClient({ connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  await database.connect();
  try {
    await database.query("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')", [first, team.id, project.id]);
    await database.query('UPDATE kortix.account_tokens SET project_id = $2, session_id = $3, agent_grant = $4::jsonb, account_id = $5 WHERE token_id = $1', [
      credential.token_id, project.id, first,
      JSON.stringify({ agent: 'kortix', permissions: 'all', connectors: 'all', env: 'all' }), team.id,
    ]);
  } finally { await database.end(); }
  const caller = ctx.client.withBearer(credential.secret_key, 'BOUND_SESSION');
  const poolsPath = '/v1/projects/:projectId/sessions/:sessionId/provider-secret-pools';
  const poolPath = `${poolsPath}/:providerId`;
  const ownParams = { projectId: project.id, sessionId: first, providerId: 'anthropic' };
  const siblingParams = { ...ownParams, sessionId: sibling };
  await ctx.step('session token reads and changes only its own pool', async () => {
    (await caller.get(poolsPath, { params: ownParams })).status(200);
    (await caller.put(poolPath, { secret_ids: [] }, { params: ownParams })).status(200);
    for (const path of [poolsPath, poolPath]) {
      (await caller.get(path, { params: siblingParams })).status(404);
    }
    (await caller.put(poolPath, { secret_ids: null }, { params: siblingParams })).status(404);
    (await owner.get(poolPath, { params: siblingParams })).status(200).body().has('$.configured', false);
  });
  await ctx.step('a real gateway request refuses the explicitly empty session pool', async () => {
    const result = await caller.post('/v1/llm/chat/completions', {
      model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'Do not use another credential' }],
    });
    result.status(400).body().has('$.error.code', 'provider_not_connected');
  });
});

flow(
  "SEC-1",
  { domain: "secrets", routes: ["GET /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("list secret names", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      r.status(200);
    });
  },
);

flow(
  "SEC-2",
  { domain: "secrets", routes: ["POST /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("upsert a secret → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "MY_SECRET", value: "v1" }, { params: { projectId: p.id } });
      r.status([200, 201]);
    });
    await ctx.step("KORTIX_* reserved → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "KORTIX_HACK", value: "x" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("invalid name format → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "not a name!", value: "x" }, { params: { projectId: p.id } });
      r.status(400);
    });
  },
);

flow(
  "SEC-3",
  { domain: "secrets", routes: ["DELETE /v1/projects/:projectId/secrets/:name"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("create then delete a secret", async () => {
      await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "TO_DELETE", value: "x" }, { params: { projectId: p.id } });
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/secrets/:name", { params: { projectId: p.id, name: "TO_DELETE" } });
      r.status(200);
    });

    await ctx.step("system KORTIX_* secret cannot be deleted → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/secrets/:name", { params: { projectId: p.id, name: "KORTIX_TOKEN" } });
      r.status(403);
    });
  },
);

flow(
  "SEC-6",
  { domain: "secrets", routes: ["POST /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("two identifiers may share the same key (profile-like secrets)", async () => {
      const primary = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-primary", name: "GOOGLE_MAPS_API_KEY", value: "primary-key" },
          { params: { projectId: p.id } },
        );
      primary.status([200, 201]);
      primary.body().has("identifier", "GMAPS-primary").has("name", "GOOGLE_MAPS_API_KEY");
      // The per-project secret-write budget (2026-08-21 storm control) must be
      // armed on this route: its limiter stamps every allowed write.
      primary.headerEquals("X-RateLimit-Limit", /^\d+$/);

      const backup = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-backup", name: "GOOGLE_MAPS_API_KEY", value: "backup-key" },
          { params: { projectId: p.id } },
        );
      backup.status([200, 201]);
      backup.body().has("identifier", "GMAPS-backup").has("name", "GOOGLE_MAPS_API_KEY");

      const list = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      list.status(200);
      const items: any[] = list.json().items ?? [];
      const withKey = items.filter((i) => i.name === "GOOGLE_MAPS_API_KEY");
      if (withKey.length !== 2 || new Set(withKey.map((i) => i.identifier)).size !== 2) {
        throw new Error(`expected 2 distinct identifiers under GOOGLE_MAPS_API_KEY, got ${JSON.stringify(withKey)}`);
      }
    });

    await ctx.step("re-submitting the same identifier with a DIFFERENT key is rejected", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-primary", name: "SOME_OTHER_KEY", value: "x" },
          { params: { projectId: p.id } },
        );
      r.status(409);
    });
  },
);

flow(
  "SEC-8",
  {
    domain: "secrets",
    // SEC-8 provisions a REAL managed GitHub repository, and one provision
    // request is allowed 180_000ms on its own (fixtures/provision.ts
    // PROVISION_REQUEST_TIMEOUT_MS). On the deployed lane this flow inherited
    // the same 180_000ms floor (core/local-runner.ts DEPLOYED_FLOW_TIMEOUT_MS),
    // so a provision that took its full budget and SUCCEEDED still failed the
    // flow before its first step ran — which is how run 32306385663 recorded
    // `flow SEC-8 exceeded 180000ms` twice. The budget must exceed the bounds
    // the flow itself contains.
    timeoutMs: 300_000,
    routes: [
      "POST /v1/projects/:projectId/secrets",
      "GET /v1/projects/:projectId/secrets",
      "PUT /v1/projects/:projectId/secrets/:identifier/strategy",
      "POST /v1/projects/:projectId/secrets/:identifier/broker",
      "POST /v1/projects/:projectId/secrets/:identifier/relay",
      "POST /v1/projects/:projectId/secrets/:identifier/grant",
      "POST /v1/projects/:projectId/secrets/sync",
      "PATCH /v1/projects/:projectId/features",
      "GET /v1/accounts/:accountId/audit",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const p = await team.project();

    await ctx.step("create returns explicit runtime delivery metadata", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "CONTROL_PLANE_KEY", value: "control-plane-value" },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "runtime")
        .has("$.consumer", "sandbox")
        .has("$.delivery_status", "available")
        .has("$.requires_rotation", false)
        // One mechanism serves every sandbox provider, so this is unconditional.
        // It used to depend on Platinum or a per-project flag, and the egress
        // steps below had to branch on it.
        .has("$.network_boundary_available", true);
    });

    await ctx.step("manager disables sandbox delivery", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "denied" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "denied")
        .has("$.consumer", null)
        .has("$.delivery_status", "disabled")
        .has("$.requires_rotation", true);
    });

    await ctx.step("manager synchronizes the current policy to active sessions", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/sync",
          {},
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.ok", true)
        .has("$.active_sandboxes", 0)
        .has("$.targeted", 0)
        .has("$.synced", 0)
        .has("$.failed", 0)
        .has("$.exported", 0)
        .has("$.results", []);
    });

    await ctx.step("runtime delivery stays disabled until rotation", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "runtime" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(409).body().has("$.code", "secret_rotation_required");
    });

    await ctx.step("broker delivery requires an outbound policy", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "broker" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(400).body().has("$.code", "secret_delivery_policy_required");
    });

    await ctx.step("generic HTTPS broker accepts a validated policy", async () => {
      const policy = {
        backend: "kortix_fetch",
        rules: [{ host: "api.example.com", methods: ["POST"], path: "/v1/*" }],
        inject: { kind: "header", name: "authorization", template: "Bearer {{secret}}" },
      };
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "broker", egress_policy: policy, handle_prefix: "svc_" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "broker")
        .has("$.consumer", "http_broker")
        .has("$.delivery_status", "available")
        .has("$.egress_policy", policy);
    });

    // `secrets_egress` is ON by default since 2026-09-03 (Marko) — the OPTION
    // is available to every project, and a new secret still defaults to an
    // environment variable, so enforcing at the network stays a per-secret
    // choice. The gate did not go away; it only inverted, and that is what the
    // next two steps prove. Egress delivery itself is exercised straight after.
    await ctx.step("a project that turns secrets_egress OFF cannot enter egress → 403", async () => {
      const off = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/features",
          { feature: "secrets_egress", enabled: false },
          { params: { projectId: p.id } },
        );
      off.status(200).body().has("$.experimental.secrets_egress", false);

      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: { rules: [{ host: "api.example.com" }], on_no_match: "deny" },
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(403).body().has("$.code", "feature_disabled").has("$.feature", "secrets_egress");
    });

    await ctx.step("manager turns the secrets_egress flag back on → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/features",
          { feature: "secrets_egress", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.experimental.secrets_egress", true);
    });

    await ctx.step("egress-enforced delivery stores a host-list-only policy", async () => {
      // The default shape: no injection slot. The sandbox env carries a handle
      // and the relay substitutes the real value on an approved host.
      const policy = {
        rules: [{ host: "api.example.com" }],
        on_no_match: "deny",
      };
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: policy,
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "egress")
        .has("$.consumer", "network")
        .has("$.delivery_status", "available")
        .has("$.egress_policy", policy);
    });

    await ctx.step("egress-enforced delivery still stores a legacy injection policy", async () => {
      const policy = {
        rules: [{ host: "api.example.com" }],
        inject: { kind: "header", name: "authorization", template: "Bearer {{secret}}" },
      };
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: policy,
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "egress")
        .has("$.consumer", "network")
        .has("$.delivery_status", "available")
        .has("$.egress_policy", policy);
    });

    // The grant route's success path commits kortix.yaml, and the local profile
    // has no writable git backend — every sibling manifest-writing route
    // (agents/:agentName/scope in IAM-*, agents/:agentName/config in PROJ-*) is
    // covered the same way, at the boundary the profile can reach. The commit
    // itself is covered by apps/api/src/__tests__/unit-secret-grant-route.test.ts.
    await ctx.step("granting an unknown secret is refused", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/:identifier/grant",
          { agent: "kortix" },
          { params: { projectId: p.id, identifier: "NO_SUCH_SECRET" } },
        );
      r.status(404);
    });

    await ctx.step("granting rejects a malformed identifier before touching the manifest", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/:identifier/grant",
          { agent: "kortix" },
          { params: { projectId: p.id, identifier: "not a valid identifier" } },
        );
      r.status(400);
    });

    await ctx.step("granting requires an agent name", async () => {
      // Status only: the OpenAPI request validator rejects the body before the
      // handler runs, so the envelope is its ZodError shape, not the handler's
      // `{ code: 'invalid_body' }`. The handler's own codes are asserted in
      // apps/api/src/__tests__/unit-secret-grant-route.test.ts.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/:identifier/grant",
          {},
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(400);
    });

    await ctx.step("transparent egress rejects controls the provider cannot enforce", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: {
              rules: [{ host: "api.example.com", methods: ["POST"] }],
              inject: { kind: "header", name: "authorization" },
            },
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(400).body().has("$.code", "secret_delivery_policy_invalid");
    });

    await ctx.step("broker execution requires a session-scoped agent token", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/:identifier/broker",
          {
            url: "https://api.example.com/v1/messages",
            method: "POST",
            body_base64: "e30=",
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(403).body().has("$.code", "session_agent_token_required");
    });

    // The STREAMING sibling of the route above. It carries the same
    // credential-spending authority, so it must refuse the same caller — an
    // owner's user token is not a session-scoped agent token. Everything past
    // this gate needs a real sandbox (the shim holds the CA and the session
    // PAT), which the local profile excludes; the daemon's own shim tests and
    // apps/api/src/__tests__/unit-project-secret-relay-route.test.ts carry the
    // transport contract.
    await ctx.step("streaming relay execution requires a session-scoped agent token", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets/:identifier/relay", undefined, {
          params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" },
        });
      r.status(403).body().has("$.code", "session_agent_token_required");
    });

    await ctx.step("rotation permits runtime delivery", async () => {
      const rotate = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "CONTROL_PLANE_KEY", value: "rotated-control-plane-value" },
          { params: { projectId: p.id } },
        );
      rotate
        .status(200)
        .body()
        .has("$.strategy", "egress")
        .has("$.requires_rotation", false);

      const restore = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "runtime" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      restore
        .status(200)
        .body()
        .has("$.strategy", "runtime")
        .has("$.requires_rotation", false);
    });

    await ctx.step("central audit reconstructs the strategy change without a value", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit", {
        params: { accountId: team.id },
        query: { project_id: p.id, action: "secret.strategy.changed" },
      });
      r.status(200).body().exists("$.events[0]");
      const events = r.json<{ events: Array<Record<string, unknown>> }>().events;
      const matchingEvents = events.filter((item) => item.action === "secret.strategy.changed");
      const event = matchingEvents[0];
      if (!event || matchingEvents.length < 3) throw new Error("strategy audit events missing");
      if (
        event.project_id !== p.id ||
        event.resource_type !== "project_secret" ||
        JSON.stringify(matchingEvents).includes("control-plane-value")
      ) {
        throw new Error(`unsafe strategy audit event: ${JSON.stringify(event)}`);
      }
    });
  },
);

flow(
  "CONN-ATT-AUTH",
  {
    domain: "secrets",
    routes: [
      "POST /v1/connectors/attachments",
      "POST /v1/connectors/projects/:projectId/attachments",
    ],
  },
  async (ctx) => {
    await ctx.step("anonymous attachment upload is rejected", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/connectors/attachments", {});
      r.status(401);
    });

    await ctx.step("anonymous project attachment upload is rejected", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/connectors/projects/:projectId/attachments",
          {},
          { params: { projectId: "00000000-0000-4000-a000-000000000000" } },
        );
      r.status(401);
    });
  },
);

// SEC-7 — agent-minted secret setup links: the authenticated mint side
// (POST /secret-requests, projects/routes/setup-links.ts) and the PUBLIC,
// token-gated consume side (GET/POST /v1/setup-links/secret/:token,
// setup-links/public-app.ts). The token is a stateless AEAD envelope (no DB
// row) encrypted with the project's own key — see setup-links/token.ts. Full
// mint → resolve → submit lifecycle, plus the bogus-token boundary on both
// public routes.
flow(
  "SEC-7",
  {
    domain: "secrets",
    routes: [
      "POST /v1/projects/:projectId/secret-requests",
      "GET /v1/setup-links/secret/:token",
      "POST /v1/setup-links/secret/:token",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let token = "";

    await ctx.step("mint a secret-entry link → 200 with a token url", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_TEST_KEY"] },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.kind", "secret")
        .has("$.names[0]", "SEC7_TEST_KEY")
        .has("$.scope", "connector")
        .exists("$.url");
      const url = r.json<{ url: string }>().url;
      token = url.split("/").pop() ?? "";
      if (!token) throw new Error(`could not extract token from mint url: ${url}`);
    });

    await ctx.step("mint rejects a KORTIX_* reserved name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["KORTIX_HACK"] },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("mint with no names → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secret-requests", {}, { params: { projectId: p.id } });
      r.status(400);
    });

    await ctx.step("runtime delivery requires an explicit scope → 200 runtime", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_RUNTIME_KEY"], scope: "runtime" },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.scope", "runtime");
    });

    await ctx.step("unknown delivery scope → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_TEST_KEY"], scope: "surprise" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("NONMEMBER cannot mint → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_TEST_KEY"] },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step("public: resolve the real token → 200 with the requested field", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/setup-links/secret/:token", { params: { token } });
      r.status(200).body().has("$.kind", "secret").has("$.fields[0].name", "SEC7_TEST_KEY");
    });

    await ctx.step("public: resolve a bogus token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/setup-links/secret/:token", { params: { token: "ksl_bogus" } });
      r.status(404);
    });

    await ctx.step("public: submit a value for the real token → 200 saved", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/setup-links/secret/:token",
          { values: { SEC7_TEST_KEY: "e2e-value" } },
          { params: { token } },
        );
      r.status(200).body().has("$.ok", true).has("$.saved[0]", "SEC7_TEST_KEY");
    });

    await ctx.step("public: submit with no matching values → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/setup-links/secret/:token", { values: { UNREQUESTED_KEY: "x" } }, { params: { token } });
      r.status(400);
    });

    await ctx.step("public: submit against a bogus token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/setup-links/secret/:token",
          { values: { SEC7_TEST_KEY: "x" } },
          { params: { token: "ksl_bogus" } },
        );
      r.status(404);
    });
  },
);
