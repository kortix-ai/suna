/**
 * Agents as principals.
 * Maps to `AGP-1` … `AGP-12` in tests/spec/end-to-end.md §32.
 *
 * Black box: real HTTP to the running API, the real `kortix` CLI as a process,
 * real `git` through the Kortix Git proxy. No API handler is imported.
 *
 * Agent-session credentials: the local profile has no sandbox provider, so no
 * local route reaches `mintSessionToken`. `AgentPrincipalsWorld.mintAgentSession`
 * (tests/src/fixtures/agent-principals.ts) reproduces the production token row:
 * an API-minted secret, the service account from the real
 * `ensureAgentServiceAccount` (via `GET /iam/agent-identities`), the agent grant
 * written by the SERVER from kortix.yaml (connector-gateway reconciliation),
 * and `on_behalf_of_user_id`. Read that file's header for what the fixture does
 * NOT exercise.
 *
 * There is no project switch: every governed agent session authorizes as its
 * agent.
 *
 * Denials follow spec §4: `403 { code, action }`.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal, TeamFixture } from '../core/types';
import { CliSandbox } from '../fixtures/cli';
import {
  AgentPrincipalsWorld,
  type AgentSession,
  assertDenial,
  git,
  rawRequest,
} from '../fixtures/agent-principals';
import { serveFixtureRepoLocally } from '../fixtures/local-git';

type Grant = string[] | 'all' | 'none';
interface AgentDecl {
  kortix_permissions?: Grant;
  kortix_cli?: Grant;
  connectors?: Grant;
  apps?: Grant;
  secrets?: Grant;
}

/** A v2 kortix.yaml. `kortix` stays declared with no grant (deny by default). */
function manifest(agents: Record<string, AgentDecl>, tail = ''): string {
  let text = 'kortix_version: 2\nproject:\n  name: example-org-agp\ndefault_agent: kortix\nagents:\n  kortix: {}\n';
  for (const [name, decl] of Object.entries(agents)) {
    const entries = Object.entries(decl);
    if (entries.length === 0) {
      text += `  ${name}: {}\n`;
      continue;
    }
    text += `  ${name}:\n`;
    for (const [key, value] of entries) text += `    ${key}: ${JSON.stringify(value)}\n`;
  }
  return text + tail;
}

async function governedWorld(ctx: FlowContext, opts: { enterprise?: boolean } = {}) {
  const team = await ctx.fixtures.team(opts.enterprise ? { enterprise: true } : undefined);
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  return { team, project, world };
}

/** A project member (project role `member`) of the team. */
async function projectMember(team: TeamFixture, projectId: string): Promise<Principal> {
  const member = await team.addMember('member');
  await team.grantProjectRole(projectId, member.userId!, 'member');
  return member;
}

const filesOf = (s: AgentSession, projectId: string) =>
  s.client.get('/v1/projects/:projectId/files', { params: { projectId } });
const secretsOf = (s: AgentSession, projectId: string) =>
  s.client.get('/v1/projects/:projectId/secrets', { params: { projectId } });

/** The session-token environment the sandbox gives the CLI. */
function cliEnv(ctx: FlowContext, s: AgentSession, projectId: string): Record<string, string> {
  return { KORTIX_TOKEN: s.secret, KORTIX_PROJECT_ID: projectId, KORTIX_API_URL: ctx.env.apiUrl };
}

async function bindCeiling(
  ctx: FlowContext,
  world: AgentPrincipalsWorld,
  by: Principal,
  agent: string,
  roleKey: string,
): Promise<string> {
  const serviceAccountId = await world.serviceAccountId(agent);
  const r = await ctx.client.as(by).post(
    '/v1/accounts/:accountId/iam/assignments',
    {
      principal_type: 'service_account',
      principal_id: serviceAccountId,
      role_key: roleKey,
      scope_type: 'project',
      scope_id: world.projectId,
    },
    { params: { accountId: world.accountId } },
  );
  r.status(201).body().has('$.principal_id', serviceAccountId).has('$.role_key', roleKey);
  return r.json<{ assignment_id: string }>().assignment_id;
}

/** Poll until `probe` returns true (IAM caches refresh within 15 s). */
async function eventually(description: string, probe: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
  const deadline = Date.now() + 20_000;
  let detail = '';
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.ok) return;
    detail = result.detail;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${description} did not hold within 20 s: ${detail}`);
}

// ── AGP-1 — `kortix_permissions` is canonical; `kortix_cli` is a deprecated alias ──
flow(
  'AGP-1',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/manifest/validate',
      'PUT /v1/projects/:projectId/agents/:agentName/config',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/secrets',
    ],
  },
  async (ctx) => {
    const { world } = await governedWorld(ctx);
    const validate = (raw: string) =>
      world.owner.post(
        '/v1/projects/:projectId/manifest/validate',
        { raw, format: 'yaml' },
        { params: { projectId: world.projectId } },
      );
    type Issue = { path: string; message: string; severity: 'error' | 'warning' };
    const alias = manifest({ legacy: { kortix_cli: ['project.file.read'] } });
    const canonical = manifest({ modern: { kortix_permissions: ['project.file.read'] } });
    const conflict = manifest({ both: { kortix_cli: ['project.file.read'], kortix_permissions: ['project.secret.read'] } });
    const sandbox = new CliSandbox('agp1');
    try {
      // Runtime first: the agent-config PUT below reads kortix.yaml through the
      // project mirror, and GET /iam/agent-identities reads that mirror without
      // forcing a refresh (up to 60 s stale). Committing the agents after the
      // PUT made the fixture's service-account lookup see the pre-commit
      // manifest. Same assertions, order only.

      let legacy!: AgentSession;
      let modern!: AgentSession;
      await ctx.step('commit both spellings; the server stores the canonical `permissions` grant for each agent', async () => {
        await world.writeManifest(manifest({
          legacy: { kortix_cli: ['project.file.read'] },
          modern: { kortix_permissions: ['project.file.read'] },
        }));
        legacy = await world.mintAgentSession({ agent: 'legacy', launcher: ctx.P.OWNER });
        modern = await world.mintAgentSession({ agent: 'modern', launcher: ctx.P.OWNER });
        for (const s of [legacy, modern]) {
          if (JSON.stringify(s.grant?.permissions) !== JSON.stringify(['project.file.read'])) {
            throw new Error(`${s.agent}: stored grant lacks permissions ["project.file.read"]: ${JSON.stringify(s.grant)}`);
          }
        }
      });

      await ctx.step('both agents read files (200) and are refused secrets with 403 agent_scope_insufficient', async () => {
        for (const s of [legacy, modern]) {
          (await filesOf(s, world.projectId)).status(200);
          assertDenial(await secretsOf(s, world.projectId), 'agent_scope_insufficient', 'project.secret.read');
        }
      });

      await ctx.step('the deprecated kortix_cli key validates, with one warning on agents.legacy.kortix_cli', async () => {
        const r = await validate(alias);
        r.status(200).body().has('$.valid', true);
        const issues = r.json<{ issues: Issue[] }>().issues;
        const warning = issues.find((i) => i.severity === 'warning' && i.path === 'agents.legacy.kortix_cli');
        if (!warning || !/kortix_permissions/.test(warning.message)) {
          throw new Error(`expected a deprecation warning naming kortix_permissions, got ${JSON.stringify(issues)}`);
        }
      });

      await ctx.step('kortix_permissions validates with no issue on the agent', async () => {
        const r = await validate(canonical);
        r.status(200).body().has('$.valid', true);
        const issues = r.json<{ issues: Issue[] }>().issues.filter((i) => i.path.startsWith('agents.modern'));
        if (issues.length) throw new Error(`canonical key produced issues: ${JSON.stringify(issues)}`);
      });

      await ctx.step('both keys with different values is a validation error; the agent-config write answers 400', async () => {
        const r = await validate(conflict);
        r.status(200).body().has('$.valid', false);
        const errors = r.json<{ issues: Issue[] }>().issues.filter(
          (i) => i.severity === 'error' && i.path.startsWith('agents.both'),
        );
        if (!errors.length) throw new Error(`no error on agents.both: ${r.text()}`);
        const put = await world.owner.put(
          '/v1/projects/:projectId/agents/:agentName/config',
          { kortix_cli: ['project.file.read'], kortix_permissions: ['project.secret.read'] },
          { params: { projectId: world.projectId, agentName: 'both' }, timeoutMs: 60_000 },
        );
        put.status(400);
      });

      await ctx.step('real CLI `kortix validate --json`: alias exits 0 with the warning; conflicting keys exit 1', async () => {
        // `kortix validate` lints that each agent's file exists (KRTX-174).
        for (const agent of ['kortix', 'legacy', 'both']) sandbox.writeFile(`agents/${agent}.md`, `# ${agent}\n`);
        sandbox.writeFile('kortix.yaml', alias);
        const ok = await sandbox.run(['validate', '--json', '--no-dockerfile-lint']);
        if (ok.exitCode !== 0) throw new Error(`alias: exit ${ok.exitCode}: ${ok.all.slice(0, 600)}`);
        const report = JSON.parse(ok.stdout.trim()) as { valid: boolean; issues: Issue[] };
        if (!report.issues.some((i) => i.severity === 'warning' && i.path === 'agents.legacy.kortix_cli')) {
          throw new Error(`CLI report lacks the deprecation warning: ${ok.stdout.slice(0, 600)}`);
        }
        sandbox.writeFile('kortix.yaml', conflict);
        const bad = await sandbox.run(['validate', '--json', '--no-dockerfile-lint']);
        if (bad.exitCode !== 1) throw new Error(`conflict: expected exit 1, got ${bad.exitCode}: ${bad.all.slice(0, 600)}`);
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

// ── AGP-2 — flag ON: the agent's own authority, independent of the launcher ──
flow(
  'AGP-2',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/secrets',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const member = await projectMember(team, project.id);
    const sandbox = new CliSandbox('agp2');
    try {
      await ctx.step('commit agent `reader` with kortix_permissions [project.file.read]; grant the member run(reader)', async () => {
        await world.writeManifest(manifest({ reader: { kortix_permissions: ['project.file.read'] } }));
        await world.grantRun('reader', member);
      });

      await ctx.step('the member alone (own JWT) is refused files: 403 project_role_insufficient', async () => {
        const r = await ctx.client.as(member).get('/v1/projects/:projectId/files', { params: { projectId: project.id } });
        assertDenial(r, 'project_role_insufficient', 'project.file.read');
      });

      let memberRun!: AgentSession;
      await ctx.step('the member launches `reader`: its session token lists files → 200', async () => {
        memberRun = await world.mintAgentSession({ agent: 'reader', launcher: member });
        const r = await filesOf(memberRun, project.id);
        r.status(200);
        if (!Array.isArray(r.json<unknown>())) throw new Error(`files did not return a list: ${r.text().slice(0, 300)}`);
      });

      await ctx.step('real CLI `kortix files ls` with the member-launched session token exits 0 and prints kortix.yaml', async () => {
        const r = await sandbox.run(['files', 'ls'], { env: cliEnv(ctx, memberRun, project.id) });
        if (r.exitCode !== 0 || !r.stdout.includes('kortix.yaml')) {
          throw new Error(`kortix files ls: exit ${r.exitCode}: ${r.all.slice(0, 600)}`);
        }
      });

      await ctx.step('the owner launches the same agent: an action outside the list → 403 agent_scope_insufficient', async () => {
        const ownerRun = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER });
        assertDenial(await secretsOf(ownerRun, project.id), 'agent_scope_insufficient', 'project.secret.read');
        (await filesOf(ownerRun, project.id)).status(200);
      });

      await ctx.step('the member-launched run gets the same answer for the same out-of-list action', async () => {
        assertDenial(await secretsOf(memberRun, project.id), 'agent_scope_insufficient', 'project.secret.read');
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

// ── AGP-4 — the ceiling: IAM role bound to the agent's service account ───────
flow(
  'AGP-4',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'POST /v1/accounts/:accountId/iam/assignments',
      'GET /v1/accounts/:accountId/iam/assignments',
      'DELETE /v1/accounts/:accountId/iam/assignments/:assignmentId',
      'GET /v1/projects/:projectId',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const admin = await team.addMember('admin');
    try {
      await ctx.step('commit `auditor` with kortix_permissions [project.file.read, project.session.read]', async () => {
        await world.writeManifest(manifest({
          auditor: { kortix_permissions: ['project.file.read', 'project.session.read'] },
        }));
      });
      const run = await world.mintAgentSession({ agent: 'auditor', launcher: ctx.P.OWNER });
      const sessionsOf = () => run.client.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id } });

      await ctx.step('with no binding the default ceiling applies: files 200, sessions 200', async () => {
        (await filesOf(run, project.id)).status(200);
        (await sessionsOf()).status(200);
      });

      let assignmentId = '';
      await ctx.step("an account admin binds system role `member` to auditor's service account; read-back lists it", async () => {
        assignmentId = await bindCeiling(ctx, world, admin, 'auditor', 'member');
        const serviceAccountId = await world.serviceAccountId('auditor');
        const list = await ctx.client.as(admin).get('/v1/accounts/:accountId/iam/assignments', {
          params: { accountId: team.id },
          query: { principal_type: 'service_account', principal_id: serviceAccountId },
        });
        list.status(200);
        const rows = list.json<{ assignments: Array<{ assignment_id: string; role_key: string }> }>().assignments;
        if (!rows.some((a) => a.assignment_id === assignmentId && a.role_key === 'member')) {
          throw new Error(`assignment not listed: ${list.text().slice(0, 400)}`);
        }
      });

      await ctx.step('files (listed, outside `member`) → 403 agent_ceiling_insufficient', async () => {
        await eventually('ceiling denial', async () => {
          const r = await filesOf(run, project.id);
          const body = r.statusCode === 403 ? r.json<any>() : null;
          return { ok: body?.code === 'agent_ceiling_insufficient', detail: `${r.statusCode} ${r.text().slice(0, 200)}` };
        });
        assertDenial(await filesOf(run, project.id), 'agent_ceiling_insufficient', 'project.file.read');
      });

      await ctx.step('a system role is a working ceiling, not a trap: project.read 200 and sessions (inside `member`) 200', async () => {
        (await run.client.get('/v1/projects/:projectId', { params: { projectId: project.id } })).status(200);
        // The principal cache (15 s) is invalidated only on the replica that
        // took the write, so another replica can still see the binding without
        // its role until its own entry expires.
        await eventually('sessions inside the `member` ceiling', async () => {
          const r = await sessionsOf();
          return { ok: r.statusCode === 200, detail: `${r.statusCode} ${r.text().slice(0, 200)}` };
        });
      });

      await ctx.step('the admin removes the binding; files returns to 200', async () => {
        const r = await ctx.client.as(admin).del('/v1/accounts/:accountId/iam/assignments/:assignmentId', {
          params: { accountId: team.id, assignmentId },
        });
        r.status([200, 204]);
        await eventually('ceiling removal', async () => {
          const files = await filesOf(run, project.id);
          return { ok: files.statusCode === 200, detail: `${files.statusCode} ${files.text().slice(0, 200)}` };
        });
      });
    } finally {
      await world.close();
    }
  },
);

// ── AGP-5 — permissions decide: members.manage and project.delete are ordinary ──
flow(
  'AGP-5',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'PUT /v1/projects/:projectId/access/:userId',
      'GET /v1/projects/:projectId/access',
      'POST /v1/projects/:projectId/cli-token',
      'DELETE /v1/projects/:projectId',
      'GET /v1/projects/:projectId',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const member = await projectMember(team, project.id);
    try {
      await ctx.step('commit `viewer` [members.read], `steward` [members.read, members.manage] and `root` (all)', async () => {
        await world.writeManifest(manifest({
          viewer: { kortix_permissions: ['project.members.read'] },
          steward: { kortix_permissions: ['project.members.read', 'project.members.manage'] },
          root: { kortix_permissions: 'all' },
        }));
      });
      const viewer = await world.mintAgentSession({ agent: 'viewer', launcher: ctx.P.OWNER });
      const steward = await world.mintAgentSession({ agent: 'steward', launcher: ctx.P.OWNER });
      const root = await world.mintAgentSession({ agent: 'root', launcher: ctx.P.OWNER });
      const setRole = (s: AgentSession, role: string) =>
        s.client.put('/v1/projects/:projectId/access/:userId', { role },
          { params: { projectId: project.id, userId: member.userId! } });
      const memberRole = async () => {
        const r = await world.owner.get('/v1/projects/:projectId/access', { params: { projectId: project.id } });
        r.status(200);
        const text = r.text();
        const body = r.json<any>();
        const rows: any[] = Array.isArray(body) ? body : (body.members ?? body.access ?? body.entries ?? []);
        const row = rows.find((m) => m.user_id === member.userId || m.userId === member.userId);
        if (!row) throw new Error(`member missing from access list: ${text.slice(0, 400)}`);
        return String(row.role ?? row.project_role ?? '');
      };

      await ctx.step('without project.members.manage the agent is refused: 403 agent_scope_insufficient; the member stays `member`', async () => {
        assertDenial(await setRole(viewer, 'manager'), 'agent_scope_insufficient', 'project.members.manage');
        const role = await memberRole();
        if (role !== 'member' && role !== 'user') throw new Error(`member role changed to ${role}`);
      });

      await ctx.step('an explicitly listed project.members.manage promotes the member (2xx); read-back says `manager`', async () => {
        const r = await setRole(steward, 'manager');
        if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`steward promote: ${r.statusCode} ${r.text().slice(0, 400)}`);
        const role = await memberRole();
        if (role !== 'manager') throw new Error(`member role is ${role}, expected manager`);
      });

      await ctx.step('`all` includes project.members.manage: root demotes the member back (2xx); read-back says `member`', async () => {
        const r = await setRole(root, 'member');
        if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`root demote: ${r.statusCode} ${r.text().slice(0, 400)}`);
        const role = await memberRole();
        if (role !== 'member' && role !== 'user') throw new Error(`member role is ${role}, expected member`);
      });

      await ctx.step('the one human-only action: `all` cannot mint a project token (403 agent_human_only_action)', async () => {
        const r = await root.client.post('/v1/projects/:projectId/cli-token', {}, { params: { projectId: project.id } });
        assertDenial(r, 'agent_human_only_action', 'project.credentials.issue');
      });

      await ctx.step('`all` includes project.delete: root deletes the project (2xx); the owner no longer reads it as active', async () => {
        const r = await root.client.del('/v1/projects/:projectId', { params: { projectId: project.id } });
        if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`root delete: ${r.statusCode} ${r.text().slice(0, 400)}`);
        const read = await world.owner.get('/v1/projects/:projectId', { params: { projectId: project.id } });
        if (read.statusCode === 200 && read.json<any>().status === 'active') throw new Error('project still active after delete');
      });
    } finally {
      await world.close();
    }
  },
);

// ── AGP-6 — manual trigger fire needs run(firer, agent); the run has no human ──
flow(
  'AGP-6',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'POST /v1/accounts/:accountId/iam/assignments',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const member = await projectMember(team, project.id);
    const admin = await team.addMember('admin');
    const nightly: AgentDecl = { kortix_permissions: ['project.file.read', 'project.session.read'] };
    try {
      await world.fund();
      const { randomUUID } = await import('node:crypto');
      const pinnedSessionId = randomUUID();
      let run!: AgentSession;
      await ctx.step('commit agent `nightly` and a trigger pinned to a trigger-run session of it', async () => {
        // One commit: an API replica refreshes its mirror for unforced reads at
        // most every 60 s, so a second manifest commit could be read stale.
        await world.writeManifest(manifest(
          { nightly },
          `triggers:\n  - slug: agp-nightly\n    type: cron\n    cron: "0 9 * * *"\n    prompt: summarize open work\n    agent: nightly\n    session_mode: pinned\n    session_id: ${pinnedSessionId}\n`,
        ));
        run = await world.mintAgentSession({ agent: 'nightly', launcher: null, sessionId: pinnedSessionId });
        const r = await world.owner.get('/v1/projects/:projectId/triggers', { params: { projectId: project.id } });
        r.status(200);
        const trigger = r.json<{ triggers: Array<{ slug: string; agent: string; session_id: string | null }> }>().triggers
          .find((t) => t.slug === 'agp-nightly');
        if (!trigger || trigger.agent !== 'nightly' || trigger.session_id !== pinnedSessionId) {
          throw new Error(`trigger not listed as declared: ${r.text().slice(0, 400)}`);
        }
      });

      const fire = () =>
        ctx.client.as(member).post('/v1/projects/:projectId/triggers/:slug/fire', {},
          { params: { projectId: project.id, slug: 'agp-nightly' } });
      const queued = async () =>
        (await world.db.query(
          "SELECT command_id, source FROM kortix.session_lifecycle_commands WHERE session_id = $1 AND source LIKE 'trigger:%'",
          [run.sessionId],
        )).rows;

      await ctx.step('a member without run(nightly) fires the trigger → 403 agent_not_accessible; nothing is queued', async () => {
        const r = await fire();
        assertDenial(r, 'agent_not_accessible');
        if (typeof r.json<any>().action !== 'string') throw new Error(`denial has no action: ${r.text()}`);
        const rows = await queued();
        if (rows.length) throw new Error(`a denied fire queued ${rows.length} command(s)`);
      });

      await ctx.step('with run(member, nightly) the fire is accepted (202) and a prompt is queued for the pinned run', async () => {
        await world.grantRun('nightly', member);
        const r = await fire();
        r.status(202).body().has('$.session_id', run.sessionId);
        const rows = await queued();
        if (rows.length !== 1 || rows[0].source !== 'trigger:manual') {
          throw new Error(`expected one trigger:manual command, got ${JSON.stringify(rows)}`);
        }
      });

      await ctx.step("the trigger run's token has no human: on_behalf_of_user_id is NULL", async () => {
        const onBehalfOf = await world.readOnBehalfOf(run.sessionId);
        if (onBehalfOf !== null) throw new Error(`trigger run acts on behalf of ${onBehalfOf}`);
      });

      await ctx.step('it authorizes as `nightly`, not as the account owner: a `member` ceiling on nightly denies files', async () => {
        (await filesOf(run, project.id)).status(200);
        await bindCeiling(ctx, world, admin, 'nightly', 'member');
        await eventually('ceiling on trigger run', async () => {
          const r = await filesOf(run, project.id);
          return { ok: r.statusCode === 403, detail: `${r.statusCode} ${r.text().slice(0, 200)}` };
        });
        assertDenial(await filesOf(run, project.id), 'agent_ceiling_insufficient', 'project.file.read');
        await eventually('sessions inside the `member` ceiling', async () => {
          const r = await run.client.get('/v1/projects/:projectId/sessions', { params: { projectId: project.id } });
          return { ok: r.statusCode === 200, detail: `${r.statusCode} ${r.text().slice(0, 200)}` };
        });
      });
    } finally {
      await world.close();
    }
  },
);

// ── AGP-7 — a child session needs run(on_behalf_of, child); no human → same agent only ──
flow(
  'AGP-7',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'POST /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const member = await projectMember(team, project.id);
    try {
      await world.fund();
      await ctx.step('commit `coordinator` (may start sessions) and `vault` (secrets); the member may run coordinator only', async () => {
        await world.writeManifest(manifest({
          coordinator: { kortix_permissions: ['project.session.start', 'project.session.read', 'project.agent.read'] },
          vault: { kortix_permissions: ['project.secret.read'] },
        }));
        await world.grantRun('coordinator', member);
      });
      const spawn = (s: AgentSession, agent: string) =>
        s.client.post('/v1/projects/:projectId/sessions', { agent_name: agent }, { params: { projectId: project.id } });
      /** Past the run gate: created (201/202), or the local profile's no-sandbox 503. */
      const passedGate = (r: { statusCode: number; json<T>(): T; text(): string }) => {
        const code = r.statusCode === 503 ? r.json<any>().code : null;
        if (!(r.statusCode === 201 || r.statusCode === 202 || code === 'KORTIX_URL_UNREACHABLE')) {
          throw new Error(`expected the run gate to pass, got ${r.statusCode} ${r.text().slice(0, 300)}`);
        }
      };
      const vaultSessions = async () =>
        Number((await world.db.query(
          "SELECT count(*)::int AS n FROM kortix.project_sessions WHERE project_id = $1 AND agent_name = 'vault'",
          [project.id],
        )).rows[0].n);

      await ctx.step('baseline: the member (own JWT) cannot start `vault` → 403', async () => {
        const r = await ctx.client.as(member).post('/v1/projects/:projectId/sessions', { agent_name: 'vault' },
          { params: { projectId: project.id } });
        r.status(403);
      });

      const humanRun = await world.mintAgentSession({ agent: 'coordinator', launcher: member });
      await ctx.step("the member's coordinator run spawns `vault` → 403 agent_not_accessible; no vault session exists", async () => {
        assertDenial(await spawn(humanRun, 'vault'), 'agent_not_accessible');
        if ((await vaultSessions()) !== 0) throw new Error('a denied spawn created a vault session');
      });
      await ctx.step("the member's coordinator run spawns `coordinator` → passes the run gate", async () => {
        passedGate(await spawn(humanRun, 'coordinator'));
      });

      const triggerRun = await world.mintAgentSession({ agent: 'coordinator', launcher: null });
      await ctx.step('a trigger run of coordinator (no human) spawns `vault` → 403 agent_not_accessible', async () => {
        assertDenial(await spawn(triggerRun, 'vault'), 'agent_not_accessible');
        if ((await vaultSessions()) !== 0) throw new Error('a denied spawn created a vault session');
      });
      await ctx.step('a trigger run of coordinator spawns `coordinator` (Y == X) → passes the run gate', async () => {
        passedGate(await spawn(triggerRun, 'coordinator'));
      });
    } finally {
      await world.close();
    }
  },
);

// ── AGP-8 — personal resources: owner == on_behalf_of AND private session ─────
flow(
  'AGP-8',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'PATCH /v1/accounts/:accountId/iam/session-oversight',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/connectors/projects/:projectId/connectors/:slug/accounts',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const human = await projectMember(team, project.id);
    const admin = await team.addMember('admin');
    const slug = `agp-mail-${Date.now().toString(36)}`;
    const PERSONAL = 'example-org personal inbox';
    const SHARED = 'example-org shared inbox';
    try {
      await world.fund();
      await ctx.step('commit `assistant` with connectors [the mail connector]; the human may run it; oversight on', async () => {
        await world.writeManifest(manifest({ assistant: { kortix_permissions: ['project.session.read'], connectors: [slug] } }));
        await world.grantRun('assistant', human);
        const oversight = await world.owner.patch('/v1/accounts/:accountId/iam/session-oversight', { enabled: true },
          { params: { accountId: team.id } });
        oversight.status(200).body().has('$.enabled', true);
      });
      await ctx.step("seed the connector with one shared account and one account owned by the human", async () => {
        const connector = await world.db.query<{ connector_id: string }>(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, $3, 'Example Mail', 'openapi', $4::jsonb, 'active') RETURNING connector_id`,
          [team.id, project.id, slug, JSON.stringify({ base_url: 'https://mail.example.test', auth: { type: 'none' } })],
        );
        const connectorId = connector.rows[0]!.connector_id;
        await world.db.query(
          `INSERT INTO kortix.connector_connections
             (account_id, project_id, connector_id, owner_type, owner_id, label, status, is_default, metadata)
           VALUES ($1, $2, $3, 'project', NULL, $4, 'active', true, $6::jsonb),
                  ($1, $2, $3, 'member', $5, $7, 'active', true, $6::jsonb)`,
          [team.id, project.id, connectorId, SHARED, human.userId, JSON.stringify({ provider: 'openapi', connector_slug: slug }), PERSONAL],
        );
      });
      const labels = async (s: AgentSession) => {
        const r = await s.client.get('/v1/connectors/projects/:projectId/connectors/:slug/accounts',
          { params: { projectId: project.id, slug } });
        r.status(200);
        return (r.json<{ accounts: Array<{ label: string }> }>().accounts ?? []).map((a) => a.label);
      };
      const expectReach = async (s: AgentSession, personal: boolean, who: string) => {
        const seen = await labels(s);
        if (!seen.includes(SHARED)) throw new Error(`${who}: shared account missing: ${JSON.stringify(seen)}`);
        if (seen.includes(PERSONAL) !== personal) {
          throw new Error(`${who}: personal account ${personal ? 'missing' : 'exposed'}: ${JSON.stringify(seen)}`);
        }
      };

      const privateRun = await world.mintAgentSession({ agent: 'assistant', launcher: human, visibility: 'private' });
      await ctx.step("the human's private session acts on behalf of the human and reaches the human's account", async () => {
        const onBehalfOf = await world.readOnBehalfOf(privateRun.sessionId);
        if (onBehalfOf !== human.userId) throw new Error(`on_behalf_of = ${onBehalfOf}, expected ${human.userId}`);
        await expectReach(privateRun, true, 'private session');
      });
      await ctx.step("the human's shared (project-visible) session does not reach the personal account", async () => {
        const shared = await world.mintAgentSession({ agent: 'assistant', launcher: human, visibility: 'project' });
        await expectReach(shared, false, 'shared session');
      });
      await ctx.step('a trigger run of the same agent does not reach the personal account', async () => {
        const trigger = await world.mintAgentSession({ agent: 'assistant', launcher: null });
        await expectReach(trigger, false, 'trigger session');
      });

      await ctx.step("an admin prompts the private session (202) while its delivery waits; the token still acts for the human", async () => {
        // Hold delivery: a claimed command keeps the queued prompts away from
        // a runtime this flow never provisions (same device as SESS-29).
        await world.db.query(
          `INSERT INTO kortix.session_lifecycle_commands
             (command_id, command_type, source, status, project_id, session_id, account_id,
              actor_user_id, payload, locked_by, locked_until)
           VALUES (gen_random_uuid(), 'continue_session', 'ui', 'running', $1, $2, $3, $4,
             '{"text":"hold","clientMessageId":"agp8-hold"}'::jsonb, 'AGP-8', now() + interval '1 hour')`,
          [project.id, privateRun.sessionId, team.id, human.userId],
        );
        const r = await ctx.client.as(admin).post('/v1/projects/:projectId/sessions/:sessionId/prompts', {
          client_message_id: 'agp8-admin',
          message_id: 'msg_0123456789abAgPeIgHtAdMnXy',
          parts: [{ type: 'text', text: 'status please' }],
        }, { params: { projectId: project.id, sessionId: privateRun.sessionId } });
        r.status([200, 202]);
        // The session token changes hands when the admin's TURN starts
        // (SESS-39), not when the prompt is queued behind the human's turn.
        const onBehalfOf = await world.readOnBehalfOf(privateRun.sessionId);
        if (onBehalfOf !== human.userId) throw new Error(`on_behalf_of = ${onBehalfOf} while the admin's prompt waits`);
        await expectReach(privateRun, true, 'private session while the admin prompt waits');
      });
    } finally {
      await world.db.query('DELETE FROM kortix.connectors WHERE project_id = $1 AND slug = $2', [project.id, slug]).catch(() => {});
      await world.close();
    }
  },
);

// ── AGP-9 — a restricted App admits the agents listed in `apps` ─────────────
flow(
  'AGP-9',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/apps',
      'PATCH /v1/projects/:projectId/apps/:appId/access',
      'GET /v1/projects/:projectId/apps/:appId/agents',
      'PUT /v1/projects/:projectId/agents/:agentName/scope',
      'DELETE /v1/projects/:projectId/apps/:appId',
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const human = await projectMember(team, project.id);
    const appSlug = ctx.fixtures.name('dashboards').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
    let appId = '';
    let appUrl = '';
    try {
      await ctx.step('enable Apps; create an App restricted to the owner', async () => {
        await world.setFeature('apps', true);
        const created = await world.owner.post('/v1/projects/:projectId/apps', { slug: appSlug, name: 'Example Org dashboards' },
          { params: { projectId: project.id } });
        created.status(201);
        appId = created.json<any>().app_id;
        appUrl = created.json<any>().url;
        const restricted = await world.owner.patch('/v1/projects/:projectId/apps/:appId/access',
          { mode: 'restricted', member_ids: [ctx.P.OWNER.userId] },
          { params: { projectId: project.id, appId } });
        restricted.status(200).body().has('$.mode', 'restricted');
      });
      await ctx.step('commit `reporter` with apps [the App] and `bystander` without it; the human may run both', async () => {
        await world.writeManifest(manifest({
          reporter: { kortix_permissions: ['project.app.read'], apps: [appSlug] },
          bystander: { kortix_permissions: ['project.app.read'] },
        }));
        await world.grantRun('reporter', human);
        await world.grantRun('bystander', human);
      });
      await ctx.step('GET /apps/:appId/agents lists `reporter` (grant `listed`) and omits `bystander`', async () => {
        const r = await world.owner.get('/v1/projects/:projectId/apps/:appId/agents',
          { params: { projectId: project.id, appId } });
        r.status(200);
        const agents = r.json<{ agents: Array<{ agent_name: string; grant: string; path: string }> }>().agents;
        const names = agents.map((a) => a.agent_name);
        if (JSON.stringify(names) !== JSON.stringify(['reporter'])) {
          throw new Error(`expected exactly [reporter], got ${JSON.stringify(agents)}`);
        }
        if (agents[0]!.grant !== 'listed' || !agents[0]!.path.endsWith('#agents.reporter')) {
          throw new Error(`unexpected grant row ${JSON.stringify(agents[0])}`);
        }
      });
      // The editor and `kortix agents scope --apps` both write the grant
      // through the scope route, so `apps` has to round-trip on it exactly
      // like `connectors` does — no whole-block /config PUT for one list.
      await ctx.step('PUT /agents/bystander/scope {apps} writes the grant and answers with it', async () => {
        const scoped = await world.owner.put('/v1/projects/:projectId/agents/:agentName/scope',
          { apps: [appSlug] },
          { params: { projectId: project.id, agentName: 'bystander' } });
        scoped.status(200).body().has('$.apps[0]', appSlug);
        const r = await world.owner.get('/v1/projects/:projectId/apps/:appId/agents',
          { params: { projectId: project.id, appId } });
        r.status(200);
        const names = r.json<{ agents: Array<{ agent_name: string }> }>().agents.map((a) => a.agent_name).sort();
        if (JSON.stringify(names) !== JSON.stringify(['bystander', 'reporter'])) {
          throw new Error(`expected [bystander, reporter] after the scope write, got ${JSON.stringify(names)}`);
        }
      });
      await ctx.step('PUT the same route with apps `all` replaces the list with the sentinel', async () => {
        const scoped = await world.owner.put('/v1/projects/:projectId/agents/:agentName/scope',
          { apps: 'all' },
          { params: { projectId: project.id, agentName: 'bystander' } });
        scoped.status(200).body().has('$.apps', 'all');
        const r = await world.owner.get('/v1/projects/:projectId/apps/:appId/agents',
          { params: { projectId: project.id, appId } });
        r.status(200);
        const row = r.json<{ agents: Array<{ agent_name: string; grant: string }> }>().agents
          .find((a) => a.agent_name === 'bystander');
        if (row?.grant !== 'all') {
          throw new Error(`expected bystander to hold grant "all", got ${JSON.stringify(row)}`);
        }
      });
      await ctx.step('PUT with apps `[]` clears the grant again', async () => {
        const scoped = await world.owner.put('/v1/projects/:projectId/agents/:agentName/scope',
          { apps: [] },
          { params: { projectId: project.id, agentName: 'bystander' } });
        scoped.status(200);
        const r = await world.owner.get('/v1/projects/:projectId/apps/:appId/agents',
          { params: { projectId: project.id, appId } });
        r.status(200);
        const names = r.json<{ agents: Array<{ agent_name: string }> }>().agents.map((a) => a.agent_name);
        if (JSON.stringify(names) !== JSON.stringify(['reporter'])) {
          throw new Error(`expected exactly [reporter] after clearing, got ${JSON.stringify(names)}`);
        }
      });
    } finally {
      if (appId) {
        await world.owner.del('/v1/projects/:projectId/apps/:appId', { params: { projectId: project.id, appId } }).catch(() => {});
      }
      await world.close();
    }
  },
);

// ── AGP-13 — the App gate admits the listed agent, at the App's own host ────
//
// Split from AGP-9 because these steps need the App's PUBLIC hostname. Local
// Apps answer under `*.apps.localhost`; a deployed preview has no DNS for its
// Apps domain and runs the API in direct-edge mode, where `x-kortix-app-host`
// is ignored. `requires: ['appHost']` states that instead of hiding it.
//
// Staging has no working public Apps host (probed 2026-10-09):
// `staging-<slug>-<key>.apps.kortix.com` answers Cloudflare 530 "Tunnel error |
// staging-api.kortix.com", while the same probe on dev and prod answers 404
// `{"error":"App not found"}` from the API. The apps-router Worker fetches
// STAGING_API_ORIGIN (infra/cloudflare/workers/apps-router/wrangler.toml).
// staging-api is a Worker ROUTE over a dead cfargotunnel record, so the
// same-zone subrequest skips staging-api-kortix-router and hits the tunnel.
// Un-quarantine in the PR that points STAGING_API_ORIGIN at a live origin
// and sets KE2E_CAP_APP_HOST=1 in tests-release.yml. The local lane still runs it.
flow(
  'AGP-13',
  {
    domain: 'agent-principals',
    requires: ['database', 'appHost'],
    ...(process.env.KE2E_TARGET === 'staging'
      ? {
          quarantine:
            'staging Apps edge: *.apps.kortix.com staging hosts return Cloudflare 530 (apps-router STAGING_API_ORIGIN=staging-api.kortix.com resolves to a dead tunnel), so the gate cannot set KE2E_CAP_APP_HOST — quarantined 2026-10-09 until the apps-router staging origin is fixed',
        }
      : {}),
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/apps',
      'PATCH /v1/projects/:projectId/apps/:appId/access',
      'GET /v1/projects/:projectId/apps/:appId/agents',
      'DELETE /v1/projects/:projectId/apps/:appId',
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const human = await projectMember(team, project.id);
    const appSlug = ctx.fixtures.name('dashboards').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
    let appId = '';
    let appUrl = '';
    try {
      await ctx.step('enable Apps; create an App restricted to the owner', async () => {
        await world.setFeature('apps', true);
        const created = await world.owner.post('/v1/projects/:projectId/apps', { slug: appSlug, name: 'Example Org dashboards' },
          { params: { projectId: project.id } });
        created.status(201);
        appId = created.json<any>().app_id;
        appUrl = created.json<any>().url;
        const restricted = await world.owner.patch('/v1/projects/:projectId/apps/:appId/access',
          { mode: 'restricted', member_ids: [ctx.P.OWNER.userId] },
          { params: { projectId: project.id, appId } });
        restricted.status(200).body().has('$.mode', 'restricted');
      });
      await ctx.step('commit `reporter` with apps [the App] and `bystander` without it; the human may run both', async () => {
        await world.writeManifest(manifest({
          reporter: { kortix_permissions: ['project.app.read'], apps: [appSlug] },
          bystander: { kortix_permissions: ['project.app.read'] },
        }));
        await world.grantRun('reporter', human);
        await world.grantRun('bystander', human);
      });
      await ctx.step('GET /apps/:appId/agents lists `reporter` (grant `listed`) and omits `bystander`', async () => {
        const r = await world.owner.get('/v1/projects/:projectId/apps/:appId/agents',
          { params: { projectId: project.id, appId } });
        r.status(200);
        const agents = r.json<{ agents: Array<{ agent_name: string; grant: string; path: string }> }>().agents;
        const names = agents.map((a) => a.agent_name);
        if (JSON.stringify(names) !== JSON.stringify(['reporter'])) {
          throw new Error(`expected exactly [reporter], got ${JSON.stringify(agents)}`);
        }
        if (agents[0]!.grant !== 'listed' || !agents[0]!.path.endsWith('#agents.reporter')) {
          throw new Error(`unexpected grant row ${JSON.stringify(agents[0])}`);
        }
      });
      const reporter = await world.mintAgentSession({ agent: 'reporter', launcher: human });
      const bystander = await world.mintAgentSession({ agent: 'bystander', launcher: human });

      // Local Apps are served by the API under `<route-key>.apps.localhost`;
      // the API honours `x-kortix-app-host` for local hosts. A deployed target
      // is requested at its public App URL.
      const host = new URL(appUrl).host;
      const local = new URL(appUrl).hostname.endsWith('.apps.localhost');
      const request = (headers: Record<string, string>) =>
        rawRequest(local ? `${ctx.env.apiUrl.replace(/\/v1$/, '')}/agp-probe` : `${appUrl}/agp-probe`, {
          headers: { accept: 'application/json', ...(local ? { 'x-kortix-app-host': new URL(appUrl).hostname } : {}), ...headers },
        });
      const admitted = (r: { status: number; body: any; text: string }, who: string) => {
        if (r.status === 401 || r.body?.code === 'app_auth_required') {
          throw new Error(`${who}: refused by the App gate: ${r.status} ${r.text.slice(0, 300)}`);
        }
      };
      const refused = (r: { status: number; body: any; text: string }, who: string) => {
        if (r.status !== 401 || r.body?.code !== 'app_auth_required') {
          throw new Error(`${who}: expected 401 app_auth_required, got ${r.status} ${r.text.slice(0, 300)}`);
        }
      };

      await ctx.step(`an anonymous request to ${host} → 401 app_auth_required`, async () => {
        refused(await request({}), 'anonymous');
      });
      await ctx.step('`reporter` (listed in apps) passes the gate with Authorization: Bearer', async () => {
        admitted(await request({ authorization: `Bearer ${reporter.secret}` }), 'reporter via Authorization');
      });
      await ctx.step('`reporter` passes the gate with X-Kortix-App-Authorization: Bearer', async () => {
        admitted(await request({ 'x-kortix-app-authorization': `Bearer ${reporter.secret}` }), 'reporter via X-Kortix-App-Authorization');
      });
      await ctx.step('`bystander` (not listed) → 401 app_auth_required through either header', async () => {
        refused(await request({ authorization: `Bearer ${bystander.secret}` }), 'bystander via Authorization');
        refused(await request({ 'x-kortix-app-authorization': `Bearer ${bystander.secret}` }), 'bystander via X-Kortix-App-Authorization');
      });
    } finally {
      if (appId) {
        await world.owner.del('/v1/projects/:projectId/apps/:appId', { params: { projectId: project.id, appId } }).catch(() => {});
      }
      await world.close();
    }
  },
);

// ── AGP-10 — merging agents/triggers needs what the direct route needs ───────
flow(
  'AGP-10',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/git/:project/info/refs',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
      'POST /v1/projects/:projectId/change-requests',
      'POST /v1/projects/:projectId/change-requests/:crId/merge',
      'POST /v1/projects/:projectId/change-requests/:crId/close',
      'GET /v1/projects/:projectId/change-requests/:crId',
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/secrets/:identifier/grant',
      'GET /v1/projects/:projectId/agents/:agentName/config',
    ],
  },
  async (ctx) => {
    const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { project, world } = await governedWorld(ctx);
    const work = await mkdtemp(join(tmpdir(), 'ke2e-agp10-'));
    let server: import('node:http').Server | null = null;
    const base = { kortix_permissions: ['project.read', 'project.write', 'project.gitops.read', 'project.gitops.push', 'project.gitops.merge', 'project.agent.write', 'project.trigger.create'] };
    const pushOnly = { kortix_permissions: ['project.read', 'project.write', 'project.gitops.read', 'project.gitops.push'] };
    const mergeOnly = { kortix_permissions: ['project.read', 'project.write', 'project.gitops.read', 'project.gitops.push', 'project.gitops.merge', 'project.gitops.ref.any'] };
    // Every permission a default-branch push asks for, but not everything a grant can confer.
    const pushAll = { kortix_permissions: ['project.read', 'project.write', 'project.gitops.read', 'project.gitops.push', 'project.gitops.ref.any', 'project.agent.write', 'project.trigger.create', 'project.trigger.update', 'project.trigger.delete', 'project.customize.write'] };
    const agents = (courierSecrets: string[]) => ({
      builder: { kortix_permissions: [...base.kortix_permissions] },
      drafter: { kortix_permissions: [...pushOnly.kortix_permissions] },
      merger: { kortix_permissions: [...mergeOnly.kortix_permissions] },
      pusher: { kortix_permissions: [...pushAll.kortix_permissions] },
      keeper: { kortix_permissions: ['project.read', 'project.agent.write', 'project.secret.read'], secrets: ['AGP_KEEP'] },
      courier: { kortix_permissions: ['project.read'], secrets: courierSecrets },
    });
    try {
      await ctx.step('commit `builder`, which may push its branch and merge its own change requests', async () => {
        await world.localRepoPath();
        await world.writeManifest(manifest(agents([])));
      });
      const run = await world.mintAgentSession({ agent: 'builder', launcher: ctx.P.OWNER });
      const drafter = await world.mintAgentSession({ agent: 'drafter', launcher: ctx.P.OWNER });
      const merger = await world.mintAgentSession({ agent: 'merger', launcher: ctx.P.OWNER });
      const pusher = await world.mintAgentSession({ agent: 'pusher', launcher: ctx.P.OWNER });
      const keeper = await world.mintAgentSession({ agent: 'keeper', launcher: ctx.P.OWNER });
      // The secret-grant route commits the manifest itself, so it runs while the
      // project still points at its local repository (the HTTP fixture below has
      // no write credential for the API).
      const secretsPath = '/v1/projects/:projectId/secrets';
      const grantPath = '/v1/projects/:projectId/secrets/:identifier/grant';
      await ctx.step('the owner creates secrets AGP_KEEP and AGP_OTHER', async () => {
        for (const name of ['AGP_KEEP', 'AGP_OTHER']) {
          (await world.owner.post(secretsPath, { name, value: `${name.toLowerCase()}-value` }, { params: { projectId: project.id } }))
            .status(200).body().has('$.identifier', name);
        }
      });
      await ctx.step('`keeper` (secrets [AGP_KEEP]) granting itself AGP_OTHER → 403 agent_grant_escalation', async () => {
        const r = await keeper.client.post(grantPath, { agent: 'keeper' }, { params: { projectId: project.id, identifier: 'AGP_OTHER' } });
        r.status(403).body().has('$.code', 'agent_grant_escalation');
      });
      await ctx.step('`keeper` granting `courier` AGP_KEEP, which it holds → 200, written', async () => {
        const r = await keeper.client.post(grantPath, { agent: 'courier' }, { params: { projectId: project.id, identifier: 'AGP_KEEP' } });
        r.status(200).body().has('$.agent', 'courier').has('$.already_granted', false);
        const config = await world.owner.get('/v1/projects/:projectId/agents/:agentName/config', { params: { projectId: project.id, agentName: 'courier' } });
        config.status(200);
        if (!JSON.stringify(config.json<any>().block?.secrets ?? []).includes('AGP_KEEP')) {
          throw new Error(`courier's committed grant lacks AGP_KEEP: ${JSON.stringify(config.json<any>().block)}`);
        }
        // The route re-serialized kortix.yaml; restore the layout the edits below match.
        await world.writeManifest(manifest(agents(['AGP_KEEP'])));
      });
      server = await serveFixtureRepoLocally(ctx, world.db, project.id, 'AGP-10');
      const remote = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;
      const auth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${run.secret}` };
      const agentGit = (args: string[]) => git(args, { cwd: work, env: auth });
      const commitAndPush = async (message: string) => {
        await agentGit(['add', '-A']);
        await agentGit(['-c', 'user.name=builder', '-c', 'user.email=builder@example.test', 'commit', '-m', message]);
        await agentGit(['push', 'origin', `HEAD:refs/heads/${run.sessionId}`]);
      };
      const crPath = '/v1/projects/:projectId/change-requests';
      const openCr = async (title: string) => {
        const r = await run.client.post(crPath, { title, head_ref: run.sessionId }, { params: { projectId: project.id } });
        r.status(201);
        return String(r.json<any>().cr_id);
      };
      const mergeAs = (client: typeof run.client, crId: string) =>
        client.post(`${crPath}/:crId/merge`, { message: 'merge' }, { params: { projectId: project.id, crId } });
      const mainSha = async () => (await agentGit(['ls-remote', 'origin', 'refs/heads/main'])).split(/\s/)[0]!;

      await ctx.step('the agent clones through the Git proxy and pushes a README change to its own branch', async () => {
        await agentGit(['clone', remote, '.']);
        await writeFile(join(work, 'README.md'), '# example-org\n\nagent note\n');
        await commitAndPush('docs: agent note');
      });
      await ctx.step('control: a CR that does not touch agents or triggers is merged by the agent (200)', async () => {
        const crId = await openCr('Agent note');
        const r = await mergeAs(run.client, crId);
        r.status(200).body().has('$.change_request.status', 'merged');
        await agentGit(['pull', '--ff-only', 'origin', 'main']);
      });

      await ctx.step('a CR granting `merger` project.trigger.create, which builder holds: the agent merges it (200); main carries the change', async () => {
        const manifestPath = join(work, 'kortix.yaml');
        const current = await readFile(manifestPath, 'utf8');
        await writeFile(manifestPath, current.replace(/(merger:\n {4}kortix_permissions: \[[^\]]*)\]/, '$1,"project.trigger.create"]'));
        if ((await readFile(manifestPath, 'utf8')) === current) throw new Error('manifest edit did not apply');
        await commitAndPush('agents: let merger create triggers');
        const crId = await openCr('Merger creates triggers');
        const r = await mergeAs(run.client, crId);
        r.status(200).body().has('$.change_request.status', 'merged');
        await agentGit(['pull', '--ff-only', 'origin', 'main']);
        if (!/merger:\n {4}kortix_permissions: \[[^\]]*"project\.trigger\.create"\]/.test(await readFile(manifestPath, 'utf8'))) {
          throw new Error('main lacks the merged manifest change');
        }
      });
      await ctx.step('a CR that only adds a trigger: the agent merges it (200); main carries the trigger', async () => {
        const manifestPath = join(work, 'kortix.yaml');
        const current = await readFile(manifestPath, 'utf8');
        await writeFile(manifestPath, `${current.trimEnd()}\ntriggers:\n  - slug: agp-hourly\n    type: cron\n    cron: "0 * * * *"\n    prompt: tidy up\n    agent: builder\n`);
        await commitAndPush('triggers: add hourly');
        const crId = await openCr('Add hourly trigger');
        const r = await mergeAs(run.client, crId);
        r.status(200).body().has('$.change_request.status', 'merged');
        await agentGit(['pull', '--ff-only', 'origin', 'main']);
        if (!(await readFile(manifestPath, 'utf8')).includes('agp-hourly')) throw new Error('main lacks the merged trigger');
      });
      // From here on every CR from builder's branch is refused, so its commits stay unmerged.
      await ctx.step('an agent grants only what it holds: builder cannot merge a CR making itself `all` → 403 agent_grant_escalation; main unchanged', async () => {
        const manifestPath = join(work, 'kortix.yaml');
        const current = await readFile(manifestPath, 'utf8');
        const widened = current.replace(/builder:\n {4}kortix_permissions: \[[^\]]*\]/, 'builder:\n    kortix_permissions: "all"');
        if (widened === current) throw new Error('manifest edit did not apply');
        await writeFile(manifestPath, widened);
        await commitAndPush('agents: make builder all');
        const crId = await openCr('Make builder all');
        const before = await mainSha();
        const r = await mergeAs(run.client, crId);
        r.status(403).body().has('$.code', 'agent_grant_escalation');
        if ((await mainSha()) !== before) throw new Error('a refused merge moved main');
        (await world.owner.post(`${crPath}/:crId/close`, {}, { params: { projectId: project.id, crId } })).status(200);
      });
      await ctx.step('an agent without project.gitops.merge cannot merge a CR widening itself: 403 agent_scope_insufficient; main unchanged', async () => {
        const manifestPath = join(work, 'kortix.yaml');
        const current = await readFile(manifestPath, 'utf8');
        await writeFile(manifestPath, current.replace('"project.gitops.push"]', '"project.gitops.push","project.gitops.merge"]'));
        if ((await readFile(manifestPath, 'utf8')) === current) throw new Error('manifest edit did not apply');
        await commitAndPush('agents: widen drafter');
        const crId = await openCr('Widen drafter');
        const before = await mainSha();
        assertDenial(await mergeAs(drafter.client, crId), 'agent_scope_insufficient', 'project.gitops.merge');
        if ((await mainSha()) !== before) throw new Error('a refused merge moved main');
        (await world.owner.post(`${crPath}/:crId/close`, {}, { params: { projectId: project.id, crId } })).status(200);
      });
      await ctx.step('merge without project.agent.write: `merger` cannot merge a CR making itself `all` → 403 agent_scope_insufficient (project.agent.write); main unchanged', async () => {
        const manifestPath = join(work, 'kortix.yaml');
        const current = await readFile(manifestPath, 'utf8');
        const widened = current.replace(/merger:\n {4}kortix_permissions: \[[^\]]*\]/, 'merger:\n    kortix_permissions: "all"');
        if (widened === current) throw new Error('manifest edit did not apply');
        await writeFile(manifestPath, widened);
        await commitAndPush('agents: make merger all');
        const crId = await openCr('Make merger all');
        const before = await mainSha();
        assertDenial(await mergeAs(merger.client, crId), 'agent_scope_insufficient', 'project.agent.write');
        if ((await mainSha()) !== before) throw new Error('a refused merge moved main');
        (await world.owner.post(`${crPath}/:crId/close`, {}, { params: { projectId: project.id, crId } })).status(200);
      });
      await ctx.step('ref.any without the manifest-write permissions: `merger` pushing straight to main is refused; main unchanged', async () => {
        const mergerAuth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${merger.secret}` };
        const before = await mainSha();
        let pushed = false;
        try {
          await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work, env: mergerAuth });
          pushed = true;
        } catch (err) {
          if (!/skips change-request review/.test(String((err as Error).message))) throw err;
        }
        if (pushed) throw new Error('merger pushed straight to main without the manifest-write permissions');
        if ((await mainSha()) !== before) throw new Error('a refused push moved main');
      });
      await ctx.step('ref.any and every manifest-write permission, but not every grant: `pusher` pushing straight to main is refused; main unchanged', async () => {
        const pusherAuth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${pusher.secret}` };
        const before = await mainSha();
        let pushed = false;
        try {
          await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work, env: pusherAuth });
          pushed = true;
        } catch (err) {
          if (!/grants only what it holds/.test(String((err as Error).message))) throw err;
        }
        if (pushed) throw new Error('pusher landed a manifest on main without the grant review');
        if ((await mainSha()) !== before) throw new Error('a refused push moved main');
      });

    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(work, { recursive: true, force: true });
      await world.close();
    }
  },
);

// ── AGP-11 — audit names the agent, on_behalf_of, and the initiator ───────────
flow(
  'AGP-11',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'GET /v1/projects/:projectId/files',
      'GET /v1/accounts/:accountId/audit',
      'GET /v1/git/:project/info/refs',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
    ],
  },
  async (ctx) => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { team, project, world } = await governedWorld(ctx, { enterprise: true });
    const human = await projectMember(team, project.id);
    const work = await mkdtemp(join(tmpdir(), 'ke2e-agp11-'));
    let server: import('node:http').Server | null = null;
    try {
      await ctx.step('commit `reader` [project.file.read] and `shipper` [gitops read+push]; the human may run both', async () => {
        await world.localRepoPath();
        await world.writeManifest(manifest({
          reader: { kortix_permissions: ['project.file.read'] },
          shipper: { kortix_permissions: ['project.gitops.read', 'project.gitops.push'] },
        }));
        await world.grantRun('reader', human);
        await world.grantRun('shipper', human);
      });
      const auditedFiles = async (s: AgentSession, label: string) => {
        const correlationId = ctx.fixtures.name(`agp11-${label}`);
        const r = await s.client.get('/v1/projects/:projectId/files', {
          params: { projectId: project.id },
          headers: { 'x-correlation-id': correlationId },
        });
        r.status(200);
        let events: Array<Record<string, any>> = [];
        await eventually(`audit event for ${label}`, async () => {
          const page = await world.owner.get('/v1/accounts/:accountId/audit', {
            params: { accountId: team.id },
            query: { project_id: project.id, correlation_id: correlationId },
          });
          events = page.statusCode === 200 ? page.json<{ events: Array<Record<string, any>> }>().events : [];
          return { ok: events.length > 0, detail: `${page.statusCode} ${page.text().slice(0, 200)}` };
        });
        const event = events.find((e) => e.actor_type === 'agent');
        if (!event) throw new Error(`${label}: no agent-attributed event: ${JSON.stringify(events).slice(0, 800)}`);
        return event;
      };

      await ctx.step("a human's private run: actor agent `reader`, on_behalf_of the human, initiator human", async () => {
        const run = await world.mintAgentSession({ agent: 'reader', launcher: human });
        const e = await auditedFiles(run, 'human');
        const expected = { agent_name: 'reader', on_behalf_of_user_id: human.userId, initiator_actor_type: 'human', initiator_actor_id: human.userId };
        for (const [key, value] of Object.entries(expected)) {
          if (e[key] !== value) throw new Error(`human run: ${key} = ${JSON.stringify(e[key])}, expected ${value}: ${JSON.stringify(e).slice(0, 800)}`);
        }
      });

      await ctx.step('a trigger run: actor agent `reader`, initiator trigger, and no human anywhere on the event', async () => {
        const run = await world.mintAgentSession({ agent: 'reader', launcher: null });
        const e = await auditedFiles(run, 'trigger');
        if (e.agent_name !== 'reader' || e.initiator_actor_type !== 'trigger' || e.on_behalf_of_user_id !== null) {
          throw new Error(`trigger run envelope: ${JSON.stringify(e).slice(0, 800)}`);
        }
        const humans = [ctx.P.OWNER.userId, human.userId];
        for (const key of ['actor_user_id', 'initiator_actor_id', 'on_behalf_of_user_id']) {
          if (humans.includes(e[key])) throw new Error(`trigger run names a human in ${key}: ${e[key]}`);
        }
      });

      await ctx.step("the human's `shipper` run clones and pushes its branch through the Git proxy: git.clone + git.push name the agent, on_behalf_of, and the ref's old → new sha", async () => {
        const run = await world.mintAgentSession({ agent: 'shipper', launcher: human });
        server = await serveFixtureRepoLocally(ctx, world.db, project.id, 'AGP-11');
        const remote = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;
        const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${run.secret}` };
        const agentGit = (args: string[]) => git(args, { cwd: work, env });
        await agentGit(['clone', remote, '.']);
        await writeFile(join(work, 'NOTES.md'), 'agent audit note\n');
        await agentGit(['add', '-A']);
        await agentGit(['-c', 'user.name=shipper', '-c', 'user.email=shipper@example.test', 'commit', '-m', 'docs: audit note']);
        await agentGit(['push', 'origin', `HEAD:refs/heads/${run.sessionId}`]);
        const pushed = (await agentGit(['rev-parse', 'HEAD'])).trim();

        let events: Array<Record<string, any>> = [];
        await eventually('git audit rows for the shipper run', async () => {
          const page = await world.owner.get('/v1/accounts/:accountId/audit', {
            params: { accountId: team.id },
            query: { project_id: project.id, session_id: run.sessionId, action: 'git' },
          });
          events = page.statusCode === 200 ? page.json<{ events: Array<Record<string, any>> }>().events : [];
          const actions = new Set(events.map((e) => e.action));
          return { ok: actions.has('git.clone') && actions.has('git.push'), detail: `${page.statusCode} ${[...actions].join(',')}` };
        });
        for (const action of ['git.clone', 'git.push']) {
          const e = events.find((row) => row.action === action)!;
          const expected = {
            actor_type: 'agent', agent_name: 'shipper', on_behalf_of_user_id: human.userId,
            initiator_actor_type: 'human', initiator_actor_id: human.userId, outcome: 'success',
            resource_type: 'git_repository',
          };
          for (const [key, value] of Object.entries(expected)) {
            if (e[key] !== value) throw new Error(`${action}: ${key} = ${JSON.stringify(e[key])}, expected ${value}: ${JSON.stringify(e).slice(0, 800)}`);
          }
        }
        const push = events.find((row) => row.action === 'git.push')!;
        const ref = (push.metadata?.refs ?? []).find((r: any) => r.ref === `refs/heads/${run.sessionId}`);
        if (!ref || ref.kind !== 'create' || ref.new_sha !== pushed || !/^0+$/.test(ref.old_sha)) {
          throw new Error(`git.push refs do not record the branch create → ${pushed}: ${JSON.stringify(push.metadata).slice(0, 600)}`);
        }
      });
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(work, { recursive: true, force: true });
      await world.close();
    }
  },
);

// ── AGP-12 — every denial carries `code` and `action`; the CLI hint follows the code ──
flow(
  'AGP-12',
  {
    domain: 'agent-principals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [
      'POST /v1/projects/:projectId/resource-grants',
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/agent-identities',
      'GET /v1/connectors/projects/:projectId/catalog',
      'POST /v1/accounts/:accountId/iam/assignments',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const { team, project, world } = await governedWorld(ctx);
    const human = await projectMember(team, project.id);
    const admin = await team.addMember('admin');
    const sandbox = new CliSandbox('agp12');
    try {
      await world.fund();
      await ctx.step('commit `scoped` (files, sessions) and `capped` (files, secrets); the human may run `scoped` only', async () => {
        await world.writeManifest(manifest({
          scoped: { kortix_permissions: ['project.file.read', 'project.session.start', 'project.agent.read'] },
          capped: { kortix_permissions: ['project.file.read', 'project.secret.read'] },
        }));
        await world.grantRun('scoped', human);
      });
      const scoped = await world.mintAgentSession({ agent: 'scoped', launcher: human });
      const capped = await world.mintAgentSession({ agent: 'capped', launcher: ctx.P.OWNER });
      await bindCeiling(ctx, world, admin, 'capped', 'member');

      await ctx.step('project_role_insufficient: the human JWT reading files → 403 {code, action: project.file.read}', async () => {
        assertDenial(await ctx.client.as(human).get('/v1/projects/:projectId/files', { params: { projectId: project.id } }),
          'project_role_insufficient', 'project.file.read');
      });
      await ctx.step('agent_scope_insufficient: `scoped` reading secrets → 403 {code, action: project.secret.read}', async () => {
        assertDenial(await secretsOf(scoped, project.id), 'agent_scope_insufficient', 'project.secret.read');
      });
      await ctx.step('agent_ceiling_insufficient: `capped` reading files under a `member` ceiling → 403 {code, action}', async () => {
        await eventually('ceiling denial', async () => {
          const r = await filesOf(capped, project.id);
          return { ok: r.statusCode === 403, detail: `${r.statusCode} ${r.text().slice(0, 200)}` };
        });
        assertDenial(await filesOf(capped, project.id), 'agent_ceiling_insufficient', 'project.file.read');
      });
      await ctx.step('agent_not_accessible: `scoped` starting `capped` for a human who may not run it → 403 {code, action}', async () => {
        const r = await scoped.client.post('/v1/projects/:projectId/sessions', { agent_name: 'capped' },
          { params: { projectId: project.id } });
        assertDenial(r, 'agent_not_accessible');
        if (typeof r.json<any>().action !== 'string' || !r.json<any>().action) throw new Error(`no action: ${r.text()}`);
      });

      await ctx.step('real CLI, scope denial: `kortix secrets ls` fails and the hint names agents.scoped.kortix_permissions', async () => {
        const r = await sandbox.run(['secrets', 'ls'], { env: cliEnv(ctx, scoped, project.id) });
        if (r.exitCode === 0) throw new Error(`secrets ls succeeded: ${r.all.slice(0, 400)}`);
        if (!r.stderr.includes('agents.scoped.kortix_permissions') || !r.all.includes('project.secret.read')) {
          throw new Error(`scope hint missing: ${r.all.slice(0, 800)}`);
        }
      });
      await ctx.step('real CLI, ceiling denial: `kortix files ls` fails and the hint asks an admin, not the manifest', async () => {
        const r = await sandbox.run(['files', 'ls'], { env: cliEnv(ctx, capped, project.id) });
        if (r.exitCode === 0) throw new Error(`files ls succeeded: ${r.all.slice(0, 400)}`);
        if (!/ask an admin/i.test(r.stderr) || !r.stderr.includes('capped') || r.stderr.includes('kortix_permissions')) {
          throw new Error(`ceiling hint wrong: ${r.all.slice(0, 800)}`);
        }
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

