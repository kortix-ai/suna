/**
 * Audit rows written by real requests: the git-proxy provenance flow (AUD-7),
 * the route-label flow (AUD-8) and the credential flow (AUD-CRED). These run
 * real git clones and pushes through the proxy and poll the asynchronous audit
 * queue, so they live apart from the fast audit surface flows in
 * audit.flow.ts (split from it — KRTX-1799; the runner's *.flow.ts glob
 * discovers both files).
 */
import { flow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import { serveFixtureRepoLocally } from '../fixtures/local-git';

// ── AUD-7: every inbound request is audited, whoever it names ────────────────
// The Git proxy authenticates its own credential, so the old request audit
// never saw a caller there and wrote no row for a clone or a push. The audit
// boundary now writes one row per inbound request; the proxy binds the caller
// it proved and names the transfer. A request nobody identified is written as
// `anonymous` instead of skipped.
interface AuditRow {
  event_id: string;
  account_id: string | null;
  project_id: string | null;
  actor_user_id: string | null;
  actor_type: string | null;
  authoritative_source: string | null;
  outcome: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  http_status: number | null;
  correlation_id: string | null;
  ip: string | null;
  metadata: {
    http?: string;
    auth?: { kind?: string; token_id?: string };
    refs?: Array<{ ref: string; old_sha: string; new_sha: string; kind: string }>;
  };
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`AUD-7 needs ${label}`);
  return value;
}

flow(
  'AUD-7',
  {
    domain: 'audit',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/git/:project/info/refs',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
      'GET /v1/projects/:projectId',
      'GET /v1/accounts/:accountId/audit',
    ],
  },
  async (ctx) => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { Client: PgClient } = await import('pg');
    const exec = promisify(execFile);
    const team = await ctx.fixtures.team({ enterprise: true });
    const outsider = await team.addMember('member');
    const projectMember = await team.addMember('member');
    const project = await team.project({ managedGit: true });
    const outsiderId = required(outsider.userId, 'the account member\u2019s user id');
    const projectMemberId = required(projectMember.userId, 'the project member\u2019s user id');
    await team.grantProjectRole(project.id, projectMemberId, 'member');
    const ownerId = required(ctx.P.OWNER.userId, 'the owner\u2019s user id');
    const databaseUrl = required(ctx.env.databaseUrl, 'a database URL');
    const db = new PgClient({ connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
    await db.connect();
    const root = await mkdtemp(join(tmpdir(), 'ke2e-audit-git-'));
    const branch = `refs/heads/${ctx.fixtures.name('aud7').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const tokenIds: string[] = [];
    let localGitServer: import('node:http').Server | null = null;
    let branchPushed = false;
    let ownerSecret: string | null = null;
    const remoteUrl = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;

    const personalToken = async (identity: typeof ctx.P.OWNER, label: string) => {
      const created = await ctx.client.as(identity).post('/v1/accounts/tokens', {
        name: `AUD-7 ${label}`, account_id: team.id,
      });
      created.status(201);
      const body = created.json<{ token_id: string; secret_key: string }>();
      tokenIds.push(body.token_id);
      return body;
    };
    const git = async (secret: string, args: string[], expected: 'ok' | 'rejected') => {
      let code = 0;
      let output = '';
      try {
        const result = await exec('git', args, { cwd: root, timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` } });
        output = result.stdout + result.stderr;
      } catch (error) {
        const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        code = typeof failed.code === 'number' ? failed.code : -1;
        output = String(failed.stdout ?? '') + String(failed.stderr ?? '');
      }
      if ((expected === 'ok') !== (code === 0)) {
        throw new Error(`git ${args[0]}: expected ${expected}, got exit ${code}: ${output.replaceAll(secret, '[redacted]')}`);
      }
      return output;
    };
    // Audit writes are an asynchronous queue, and a deployed target runs
    // several API tasks; poll the account log until the row is there.
    const auditRows = (query: Record<string, string>, description: string, send?: () => Promise<unknown>) =>
      waitFor(
        async () => {
          if (send) await send();
          return ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
            params: { accountId: team.id },
            query: { project_id: project.id, limit: '50', ...query },
          });
        },
        {
          until: (res) => res.statusCode === 200 && (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 20_000,
          intervalMs: 500,
          description,
          retryOnError: isKe2eRetryableError,
        },
      ).then((res) => {
        res.status(200);
        return res.json<{ events: AuditRow[] }>().events;
      });
    const expectRow = (row: AuditRow | undefined, expected: Partial<AuditRow>, label: string): AuditRow => {
      if (!row) throw new Error(`${label}: no row`);
      for (const [key, value] of Object.entries(expected)) {
        if (row[key as keyof AuditRow] !== value) {
          throw new Error(`${label}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(row)}`);
        }
      }
      return row;
    };

    try {
      localGitServer = await serveFixtureRepoLocally(ctx, db, project.id, 'AUD-7');
      const remote = remoteUrl;
      const owner = await personalToken(ctx.P.OWNER, 'owner');
      ownerSecret = owner.secret_key;
      const outsiderToken = await personalToken(outsider, 'account member');
      const memberToken = await personalToken(projectMember, 'project member');

      await ctx.step('the owner clones through the Git proxy; a git.clone row names the owner and the token', async () => {
        await git(owner.secret_key, ['clone', remote, '.'], 'ok');
        const rows = await auditRows({ action: 'git.clone', actor: ownerId }, 'the owner’s git.clone row');
        const row = expectRow(rows[0], {
          account_id: team.id,
          project_id: project.id,
          actor_user_id: ownerId,
          actor_type: 'human',
          authoritative_source: 'api_key',
          outcome: 'success',
          action: 'git.clone',
          resource_type: 'git_repository',
          resource_id: project.id,
          http_status: 200,
        }, 'git.clone');
        if (row.metadata.auth?.kind !== 'git' || row.metadata.auth?.token_id !== owner.token_id) {
          throw new Error(`git.clone must name the token, never its secret: ${JSON.stringify(row.metadata)}`);
        }
        if (!/git-upload-pack$/.test(String(row.metadata.http))) {
          throw new Error(`git.clone must keep its HTTP identity: ${JSON.stringify(row.metadata)}`);
        }
        if (JSON.stringify(row).includes(owner.secret_key)) throw new Error('the row contains the token secret');
      });

      await ctx.step('the owner pushes a new branch; a git.push row records the ref it created', async () => {
        await writeFile(join(root, 'aud7.txt'), 'audited push\n');
        await git(owner.secret_key, ['add', 'aud7.txt'], 'ok');
        await git(owner.secret_key, ['-c', 'user.name=KE2E', '-c', 'user.email=ke2e@kortix.ai', 'commit', '-m', 'AUD-7 probe'], 'ok');
        const head = (await git(owner.secret_key, ['rev-parse', 'HEAD'], 'ok')).trim();
        await git(owner.secret_key, ['push', remote, `HEAD:${branch}`], 'ok');
        branchPushed = true;
        const rows = await auditRows(
          { action: 'git.push', actor: ownerId, outcome: 'success' },
          'the owner’s git.push row',
        );
        const row = expectRow(rows[0], { actor_type: 'human', resource_id: project.id, http_status: 200 }, 'git.push');
        const refs = row.metadata.refs;
        const created = refs?.find((entry) => entry.ref === branch);
        if (!created || created.kind !== 'create' || created.new_sha !== head || !/^0{40}$/.test(created.old_sha ?? '')) {
          throw new Error(`git.push must record ${branch} created at ${head}: ${JSON.stringify(refs)}`);
        }
      });

      await ctx.step('the owner deletes the branch; its git.push row records the delete', async () => {
        await git(owner.secret_key, ['push', remote, `:${branch}`], 'ok');
        branchPushed = false;
        const rows = await waitFor(
          () => auditRows({ action: 'git.push', actor: ownerId, outcome: 'success' }, 'the owner’s git.push rows'),
          {
            until: (events) => events.some((row) => (row.metadata.refs ?? []).some((entry) => entry.ref === branch && entry.kind === 'delete')),
            timeoutMs: 20_000,
            intervalMs: 500,
            description: `the delete of ${branch} in the audit log`,
            retryOnError: isKe2eRetryableError,
          },
        );
        if (rows.length < 2) throw new Error(`expected a create and a delete row, got ${rows.length}`);
      });

      await ctx.step('an account member with no project role is refused, and the refusal names them', async () => {
        const read = await git(outsiderToken.secret_key, ['ls-remote', remote], 'rejected');
        if (!/403|not authorized/i.test(read)) throw new Error(`expected a 403 refusal, got: ${read}`);
        const rows = await auditRows(
          { actor: outsiderId, outcome: 'denied' },
          'the account member’s denied git row',
        );
        const row = expectRow(rows[0], {
          account_id: team.id,
          actor_type: 'human',
          authoritative_source: 'api_key',
          http_status: 403,
          action: 'git.ref.list',
        }, 'account member refusal');
        if (row.metadata.http !== 'GET /v1/git/:project/info/refs') {
          throw new Error(`the refusal keeps its HTTP identity: ${JSON.stringify(row.metadata)}`);
        }
        if (row.metadata.auth?.token_id !== outsiderToken.token_id) {
          throw new Error(`the refusal must name the refused token: ${JSON.stringify(row.metadata)}`);
        }
      });

      await ctx.step('a project member without gitops.push is refused a push, and the refusal names them', async () => {
        await git(memberToken.secret_key, ['push', remote, 'HEAD:refs/heads/main'], 'rejected');
        const rows = await auditRows(
          { actor: projectMemberId, outcome: 'denied' },
          'the project member’s denied push row',
        );
        expectRow(rows[0], { actor_type: 'human', http_status: 403, action: 'git.ref.list' }, 'project member refusal');
      });

      await ctx.step('an unauthenticated request to the project is an anonymous row in the owner’s log', async () => {
        const correlationId = ctx.fixtures.name('aud7-anonymous');
        // The anonymous budget may drop one probe under load; each poll sends
        // another, so the step waits for a written one rather than a lucky one.
        const rows = await auditRows(
          { actor_type: 'anonymous', correlation_id: correlationId },
          'the anonymous probe row',
          () => ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId', {
            params: { projectId: project.id },
            headers: { 'x-correlation-id': correlationId },
          }),
        );
        for (const row of rows) {
          expectRow(row, {
            account_id: team.id,
            project_id: project.id,
            actor_user_id: null,
            actor_type: 'anonymous',
            authoritative_source: 'anonymous',
            outcome: 'denied',
            http_status: 401,
            resource_type: 'project',
            resource_id: project.id,
          }, 'anonymous probe');
          // The auth middleware refuses before the handler runs, and the row
          // still names the endpoint the request asked for: its label, and
          // its template in `metadata.http`. Never the raw path.
          if (row.action !== 'project.read' || row.metadata.http !== 'GET /v1/projects/:projectId') {
            throw new Error(`anonymous probe: expected project.read, got ${JSON.stringify(row)}`);
          }
        }
      });

      await ctx.step('the actor_type filter still refuses an unknown type → 400', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
          params: { accountId: team.id },
          query: { actor_type: 'robot' },
        });
        r.status(400);
      });
    } finally {
      // A failed step can leave the probe branch on the project repository.
      if (branchPushed && ownerSecret) {
        await git(ownerSecret, ['push', remoteUrl, `:${branch}`], 'ok').catch(() => {});
      }
      for (const tokenId of tokenIds) {
        await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]);
      }
      const server = localGitServer;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// ── AUD-8: a request row is named by its route's audit label ────────────────
// Every route has one label in `@kortix/shared/audit-labels`: a
// `domain.resource.verb` action that filters by prefix, and a title the web
// and the CLI show. The row keeps the route template in `metadata.http`. A
// handler that records its own event for the request makes that event the
// request's only row. A request no endpoint matched is `api.route.unmatched`.
flow(
  'AUD-8',
  {
    domain: 'audit',
    routes: [
      'GET /v1/projects/:projectId',
      'POST /v1/accounts/:accountId/iam/groups',
      'DELETE /v1/accounts/:accountId/iam/groups/:groupId',
      'GET /v1/accounts/:accountId/audit',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    let groupId: string | null = null;
    let forwardedGroupId: string | null = null;
    const auditRows = (query: Record<string, string>, description: string) =>
      waitFor(
        () => owner.get('/v1/accounts/:accountId/audit', { params, query: { limit: '50', ...query } }),
        {
          until: (res) => res.statusCode === 200 && (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 20_000,
          intervalMs: 500,
          description,
          retryOnError: isKe2eRetryableError,
        },
      ).then((res) => {
        res.status(200);
        return res.json<{ events: AuditRow[] }>().events;
      });

    try {
      await ctx.step('the owner reads the project; its row is `project.read`, with the route in metadata.http', async () => {
        const read = await owner.get('/v1/projects/:projectId', { params: { projectId: project.id } });
        read.status(200);
        const requestId = required(read.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the project read row');
        const row = rows[0];
        if (!row || row.action !== 'project.read' || row.metadata.http !== 'GET /v1/projects/:projectId') {
          throw new Error(`expected project.read with its HTTP identity, got ${JSON.stringify(rows)}`);
        }
        if (JSON.stringify(row.metadata).includes(project.id)) {
          throw new Error(`metadata must carry the template, not the path: ${JSON.stringify(row.metadata)}`);
        }
      });

      await ctx.step('the `project.` action prefix selects the labelled row', async () => {
        const rows = await auditRows({ action: 'project.', project_id: project.id }, 'project.* rows');
        const off = rows.filter((row) => !row.action.startsWith('project.'));
        if (off.length > 0) throw new Error(`the prefix filter returned ${JSON.stringify(off.map((row) => row.action))}`);
      });

      await ctx.step("creating a group writes one row: the handler's own `iam.group.create` event", async () => {
        const created = await owner.post(
          '/v1/accounts/:accountId/iam/groups',
          { name: ctx.fixtures.name('aud8-group') },
          { params },
        );
        created.status(201);
        groupId = created.json<{ group_id: string }>().group_id;
        const requestId = required(created.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the group create row');
        if (rows.length !== 1 || rows[0]?.action !== 'iam.group.create') {
          throw new Error(`expected exactly one iam.group.create row, got ${JSON.stringify(rows.map((row) => row.action))}`);
        }
      });

      await ctx.step(
        'a row stores the X-Forwarded-For entry that KORTIX_TRUSTED_PROXY_HOPS (2) selects, for a handler row and a request row',
        async () => {
          // RFC 5737 documentation addresses. Locally the API receives the header
          // as sent, so hop 2 (second from the right) is 203.0.113.9. A deployed
          // target's proxies append their own entries, so there the selected
          // entry is an infrastructure-appended one, never the leftmost.
          const forwarded = { 'x-forwarded-for': '192.0.2.1, 203.0.113.9, 198.51.100.7' };
          const expectIp = (row: AuditRow | undefined, label: string) => {
            if (!row) throw new Error(`no ${label} row`);
            const ok =
              ctx.env.target === 'local'
                ? row.ip === '203.0.113.9'
                : typeof row.ip === 'string' && row.ip !== '192.0.2.1';
            if (!ok) throw new Error(`${label} row stored ip=${JSON.stringify(row.ip)} (target ${ctx.env.target})`);
          };

          const created = await owner.post(
            '/v1/accounts/:accountId/iam/groups',
            { name: ctx.fixtures.name('aud8-xff') },
            { params, headers: forwarded },
          );
          created.status(201);
          forwardedGroupId = created.json<{ group_id: string }>().group_id;
          const createId = required(created.header('x-request-id'), 'the request id header');
          const createRows = await auditRows({ request_id: createId }, 'the forwarded group create row');
          expectIp(createRows.find((row) => row.action === 'iam.group.create'), 'iam.group.create');

          const read = await owner.get('/v1/projects/:projectId', {
            params: { projectId: project.id },
            headers: forwarded,
          });
          read.status(200);
          const readId = required(read.header('x-request-id'), 'the request id header');
          const readRows = await auditRows({ request_id: readId }, 'the forwarded project read row');
          expectIp(readRows.find((row) => row.action === 'project.read'), 'project.read');
        },
      );

      await ctx.step('a request no endpoint matched is `api.route.unmatched`, never its raw path', async () => {
        const missing = await owner.get('/v1/projects/:projectId/aud8-no-such-route', {
          params: { projectId: project.id },
        });
        missing.status(404);
        const requestId = required(missing.header('x-request-id'), 'the request id header');
        const rows = await auditRows({ request_id: requestId }, 'the unmatched request row');
        const row = rows[0];
        if (!row || row.action !== 'api.route.unmatched' || row.http_status !== 404) {
          throw new Error(`expected api.route.unmatched 404, got ${JSON.stringify(rows)}`);
        }
        if (JSON.stringify(row).includes('aud8-no-such-route')) {
          throw new Error(`the unmatched row must not carry the raw path: ${JSON.stringify(row)}`);
        }
      });
    } finally {
      for (const id of [groupId, forwardedGroupId]) {
        if (!id) continue;
        await owner.del('/v1/accounts/:accountId/iam/groups/:groupId', {
          params: { ...params, groupId: id },
        });
      }
    }
  },
);

// AUD-CRED — the audit records the credential the API authenticated, never a
// label the client reports. The same read done with a browser JWT and with a
// personal access token yields rows whose `credential_kind` / `credential_id`
// name each credential, and a PAT that sends `X-Kortix-Client: web` is still a
// PAT. (An OAuth app is asserted in MCP-3, which owns the OAuth dance.)
flow(
  'AUD-CRED',
  {
    domain: 'audit',
    routes: [
      'GET /v1/projects/:projectId',
      'GET /v1/accounts/:accountId/audit',
      'POST /v1/accounts/tokens',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();

    type Row = Record<string, unknown>;
    // Do one project read as `send`, then return its audit row (see AUD-FILTER
    // for why this polls: the audit queue flushes per API task).
    const readAndFind = async (
      label: string,
      send: (correlationId: string) => Promise<{ status(code: number): unknown }>,
    ): Promise<Row> => {
      const correlationId = ctx.fixtures.name(`audit-cred-${label}`);
      (await send(correlationId)).status(200);
      const r = await waitFor(
        async () =>
          ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
            params: { accountId: team.id },
            query: { project_id: project.id, correlation_id: correlationId, action: 'project.read' },
          }),
        {
          until: (res) =>
            res.statusCode === 200 &&
            (res.json<{ events?: unknown[] }>().events?.length ?? 0) > 0,
          timeoutMs: 15_000,
          intervalMs: 500,
          description: `the ${label} audit event for ${correlationId}`,
          retryOnError: isKe2eRetryableError,
        },
      );
      return r.json<{ events: Row[] }>().events[0]!;
    };

    let patSecret = '';
    let patId = '';
    const patName = ctx.fixtures.name('aud-cred-pat');
    await ctx.step('mint a personal access token as OWNER → 201', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: patName });
      r.status(201).body().exists('$.secret_key').exists('$.token_id');
      const j = r.json<{ secret_key: string; token_id: string }>();
      patSecret = j.secret_key;
      patId = j.token_id;
    });

    await ctx.step('browser JWT → credential_kind browser_session, no reported client', async () => {
      const row = await readAndFind('jwt', (correlationId) =>
        ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId', {
          params: { projectId: project.id },
          headers: { 'x-correlation-id': correlationId },
        }),
      );
      if (row.credential_kind !== 'browser_session' || row.client_reported_source != null) {
        throw new Error(`jwt row: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('PAT → credential_kind personal_access_token with the token id and name', async () => {
      const row = await readAndFind('pat', (correlationId) =>
        ctx.client.withBearer(patSecret, 'PAT').get(`/v1/projects/${project.id}`, {
          headers: { 'x-correlation-id': correlationId },
        }),
      );
      if (
        row.credential_kind !== 'personal_access_token' ||
        row.credential_id !== patId ||
        row.credential_name !== patName ||
        row.client_reported_source != null
      ) {
        throw new Error(`pat row: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('PAT that sends X-Kortix-Client: web is still a personal_access_token', async () => {
      const row = await readAndFind('spoof', (correlationId) =>
        ctx.client.withBearer(patSecret, 'PAT').get(`/v1/projects/${project.id}`, {
          headers: { 'x-correlation-id': correlationId, 'x-kortix-client': 'web' },
        }),
      );
      if (
        row.credential_kind !== 'personal_access_token' ||
        row.credential_id !== patId ||
        row.client_reported_source != null
      ) {
        throw new Error(`spoofed row: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('credential_kind filter selects the PAT rows only', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/audit', {
        params: { accountId: team.id },
        query: { project_id: project.id, action: 'project.read', credential_kind: 'personal_access_token' },
      });
      r.status(200);
      const rows = r.json<{ events: Row[] }>().events;
      if (rows.length < 2 || rows.some((e) => e.credential_kind !== 'personal_access_token')) {
        throw new Error(`filter: ${JSON.stringify(rows.map((e) => e.credential_kind))}`);
      }
    });
  },
);
