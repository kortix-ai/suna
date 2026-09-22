/**
 * Agent-session credentials for the AGP-* flows (spec
 * docs/specs/2026-09-22-agents-as-principals.md §6).
 *
 * WHY A FIXTURE. Production mints a session's one Kortix credential in
 * `mintSessionToken` (apps/api/src/platform/services/session-sandbox.ts). That
 * function runs only inside sandbox provisioning. The local profile has no
 * sandbox provider: `POST /v1/projects/:id/sessions` answers
 * `503 KORTIX_URL_UNREACHABLE` before provisioning starts (measured
 * 2026-09-22 on this branch). No local route reaches the mint.
 *
 * WHAT THE FIXTURE REPRODUCES, field by field, of the production token row:
 *   - `secret_key`   — minted by the API (`POST /v1/accounts/tokens`). The test
 *                      never needs the server's token-hash secret.
 *   - `account_id`, `project_id`, `session_id`, `user_id` — the same values the
 *                      mint writes (`user_id` = launching human, or the account
 *                      owner for a trigger run, as `resolveTriggerActor` does).
 *   - `service_account_id` — read from `GET /v1/accounts/:id/iam/agent-identities`.
 *                      That route calls the REAL `ensureAgentServiceAccount`
 *                      for every agent in every project of the account, so the
 *                      id is the one the mint would stamp.
 *   - `agent_grant`  — written by the SERVER, never by the test. The fixture
 *                      binds the credential and a second "resolver" token to
 *                      the session with a NULL grant, then calls the connector
 *                      gateway (`GET /v1/connectors/projects/:id/catalog`) with
 *                      the RESOLVER. The gateway runs
 *                      `reconcileStoredSessionAgentGrant`, which resolves the
 *                      grant from `kortix.yaml` on the default branch through
 *                      the same resolver as the mint and writes it onto every
 *                      live token of the session. The fixture waits until the
 *                      credential carries the provenance commit of the manifest
 *                      it wrote, then deletes the resolver. The credential is
 *                      never presented before its grant exists, so the API's
 *                      15 s token-binding memo never caches a grant-less row.
 *   - `on_behalf_of_user_id` — the column spec §2.3 implies on
 *                      `kortix.account_tokens`. The fixture writes the human for
 *                      a human-initiated session and NULL for a trigger run.
 *                      When the column does not exist yet, the fixture writes
 *                      nothing and reports `onBehalfOfColumn: false`; every flow
 *                      that depends on the value asserts it by DB read-back.
 *   - `project_sessions` / `session_sandboxes` rows — the rows session create
 *                      writes, with `visibility`, `agent_name`, `created_by`
 *                      and trigger metadata where the flow needs them.
 *
 * WHAT IT DOES NOT EXERCISE (production mint behaviour left unverified here):
 *   1. `mintSessionToken` itself: its call to `resolveAgentGrant` at birth, its
 *      parallel `ensureAgentServiceAccount`, and its fail-safe to a NULL
 *      `service_account_id`.
 *   2. The mint's choice of `on_behalf_of_user_id` (human vs NULL per initiator,
 *      and "private only"). The fixture sets it; the flows then prove how the
 *      API USES it. Deployed targets with a sandbox provider cover the mint.
 *   3. The mint's `user_id` for trigger and channel runs.
 *   4. The sandbox's own injection of `KORTIX_TOKEN` into the runtime.
 *
 * Generic fixtures only (`example-org`, `example.test`); no customer names.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from '../core/client';
import type { FlowContext, Principal } from '../core/types';
import { waitFor } from '../core/poll';

export interface Db {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export async function openDb(ctx: FlowContext): Promise<Db> {
  const databaseUrl = ctx.env.databaseUrl;
  if (!databaseUrl) throw new Error('AGP fixtures need KE2E_DATABASE_URL (requires: database)');
  const { Client: PgClient } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const db = new PgClient({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  await db.connect();
  return db as unknown as Db;
}

/** Response of a raw HTTP call made with a session credential. */
export interface RawResponse {
  status: number;
  body: any;
  text: string;
}

export interface AgentSession {
  sessionId: string;
  tokenId: string;
  secret: string;
  agent: string;
  /** A ke2e client that sends this session credential as the bearer. */
  client: Client;
  /** The launching human, or null for an unattended (trigger) run. */
  launcherUserId: string | null;
  /** The stored grant after the server reconciled it from kortix.yaml. */
  grant: Record<string, unknown> | null;
  /** False when `account_tokens.on_behalf_of_user_id` does not exist yet. */
  onBehalfOfColumn: boolean;
}

export interface MintOptions {
  agent: string;
  /** The human who starts the session. `null` = a trigger run with no human. */
  launcher: Principal | null;
  visibility?: 'private' | 'project';
  /** Extra `project_sessions.metadata` (trigger runs get trigger_* keys). */
  metadata?: Record<string, unknown>;
  /** Skip the grant reconciliation (the flow asserts an ungoverned case). */
  skipGrantSync?: boolean;
  /** Use this session id (a manifest written earlier may already pin it). */
  sessionId?: string;
}

/**
 * One governed project, its repository, and the agent-session credentials a
 * flow mints inside it. Close it in `finally`.
 */
export class AgentPrincipalsWorld {
  readonly sessions: string[] = [];
  readonly tokens: string[] = [];
  private repoPath: string | null = null;
  private lastManifestCommit: string | null = null;
  private onBehalfOfColumn: boolean | null = null;
  private serviceAccounts = new Map<string, string>();

  constructor(
    readonly ctx: FlowContext,
    readonly db: Db,
    readonly accountId: string,
    readonly projectId: string,
    readonly ownerUserId: string,
  ) {}

  static async open(
    ctx: FlowContext,
    input: { accountId: string; projectId: string },
  ): Promise<AgentPrincipalsWorld> {
    const ownerUserId = ctx.P.OWNER.userId;
    if (!ownerUserId) throw new Error('OWNER principal has no userId');
    const db = await openDb(ctx);
    return new AgentPrincipalsWorld(ctx, db, input.accountId, input.projectId, ownerUserId);
  }

  get owner(): Client {
    return this.ctx.client.as(this.ctx.P.OWNER);
  }

  /** The repository path of a local bare repository, captured before any HTTP rewrite. */
  async localRepoPath(): Promise<string | null> {
    if (this.repoPath) return this.repoPath;
    const { rows } = await this.db.query<{ repo_url: string }>(
      'SELECT repo_url FROM kortix.projects WHERE project_id = $1',
      [this.projectId],
    );
    const url = rows[0]?.repo_url ?? '';
    this.repoPath = url.startsWith('/') ? url : null;
    return this.repoPath;
  }

  /**
   * Commit `files` (path → content) to the default branch and return the commit
   * SHA. Local target: a real `git` commit into the fixture's bare repository.
   * Deployed target: a real `git push` through the Kortix Git proxy with an
   * OWNER PAT.
   */
  async commitToMain(files: Record<string, string>, message: string): Promise<string> {
    const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const work = await mkdtemp(join(tmpdir(), 'ke2e-agp-'));
    const local = await this.localRepoPath();
    let remote: string;
    let extraEnv: Record<string, string> = {};
    if (local) {
      remote = local;
    } else {
      const minted = await this.owner.post('/v1/accounts/tokens', { name: this.ctx.fixtures.name('agp-manifest-writer') });
      minted.status(201);
      const { token_id: tokenId, secret_key: secret } = minted.json<{ token_id: string; secret_key: string }>();
      this.tokens.push(tokenId);
      remote = `${this.ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${this.projectId}`;
      extraEnv = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`,
      };
    }
    try {
      await git(['clone', '--branch', 'main', remote, work], { env: extraEnv });
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), content);
      }
      await git(['-C', work, 'add', '-A'], { env: extraEnv });
      await git(['-C', work, '-c', 'user.name=Example Org Admin', '-c', 'user.email=admin@example.test',
        'commit', '--allow-empty', '-m', message], { env: extraEnv });
      await git(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main'], { env: extraEnv });
      const sha = (await git(['-C', work, 'rev-parse', 'HEAD'], { env: extraEnv })).trim();
      this.lastManifestCommit = sha;
      return sha;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Write `kortix.yaml` on the default branch. */
  async writeManifest(yaml: string, message = 'agp: governed agents'): Promise<string> {
    return this.commitToMain({ 'kortix.yaml': yaml }, message);
  }

  /** Enable (or clear) one project feature flag through the product route. */
  async setFeature(feature: string, enabled: boolean | null): Promise<void> {
    const r = await this.owner.patch(
      '/v1/projects/:projectId/features',
      { feature, enabled },
      { params: { projectId: this.projectId } },
    );
    r.status(200);
  }

  /** Fund the account so prompts and trigger fires pass billing admission. */
  async fund(): Promise<void> {
    await this.db.query(
      `INSERT INTO kortix.credit_accounts
         (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
       VALUES ($1, 1000, 1000, 1000, 1000, 'tier_2_20')
       ON CONFLICT (account_id) DO UPDATE SET
         balance = 1000, balance_precise = 1000,
         non_expiring_credits = 1000, non_expiring_credits_precise = 1000, tier = 'tier_2_20'`,
      [this.accountId],
    );
  }

  /**
   * The agent's standing service account, provisioned by the real
   * `ensureAgentServiceAccount` behind `GET /iam/agent-identities`.
   */
  async serviceAccountId(agent: string): Promise<string> {
    const cached = this.serviceAccounts.get(agent);
    if (cached) return cached;
    // `/iam/agent-identities` lists agents from the project's git mirror, which
    // refreshes on a timer. On a deployed stack an agent committed seconds ago
    // can be missing for up to one refresh interval, so wait for it.
    let lastBody = '';
    const found = await waitFor(
      async () => {
        const r = await this.owner.get('/v1/accounts/:accountId/iam/agent-identities', {
          params: { accountId: this.accountId },
        });
        r.status(200);
        lastBody = r.text();
        const rows = r.json<{ agents: Array<{ service_account_id: string; project_id: string | null; agent_name: string | null }> }>().agents;
        for (const row of rows) {
          if (row.project_id === this.projectId && row.agent_name) {
            this.serviceAccounts.set(row.agent_name, row.service_account_id);
          }
        }
        return this.serviceAccounts.get(agent) ?? null;
      },
      {
        until: (id) => id !== null,
        timeoutMs: 120_000,
        intervalMs: 2_000,
        description: `service account for agent '${agent}'`,
      },
    ).catch(() => null);
    if (!found) {
      throw new Error(`agent-identities did not provision a service account for agent '${agent}' in ${this.projectId}: ${lastBody.slice(0, 400)}`);
    }
    return found;
  }

  /** Grant `run(human, agent)` — the agent object grant, closed by default. */
  async grantRun(agent: string, human: Principal): Promise<string> {
    const r = await this.owner.post(
      '/v1/projects/:projectId/resource-grants',
      { resource_type: 'agent', resource_id: agent, principal_type: 'member', principal_id: human.userId },
      { params: { projectId: this.projectId } },
    );
    r.status([200, 201]);
    const body = r.json<any>();
    return String(body.grant_id ?? body.id ?? body.grant?.grant_id ?? '');
  }

  private async hasOnBehalfOfColumn(): Promise<boolean> {
    if (this.onBehalfOfColumn !== null) return this.onBehalfOfColumn;
    const { rows } = await this.db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'kortix' AND table_name = 'account_tokens' AND column_name = 'on_behalf_of_user_id'`,
    );
    this.onBehalfOfColumn = rows.length > 0;
    return this.onBehalfOfColumn;
  }

  /** Read `on_behalf_of_user_id` of a session's live token; throws when the column is missing. */
  async readOnBehalfOf(sessionId: string): Promise<string | null> {
    if (!(await this.hasOnBehalfOfColumn())) {
      throw new Error('kortix.account_tokens.on_behalf_of_user_id does not exist (spec §2.3 not implemented)');
    }
    const { rows } = await this.db.query<{ on_behalf_of_user_id: string | null }>(
      `SELECT on_behalf_of_user_id FROM kortix.account_tokens
       WHERE session_id = $1 AND status = 'active' AND revoked_at IS NULL`,
      [sessionId],
    );
    if (rows.length === 0) throw new Error(`no live token for session ${sessionId}`);
    return rows[0]!.on_behalf_of_user_id;
  }

  async readGrant(sessionId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query<{ agent_grant: Record<string, unknown> | null }>(
      `SELECT agent_grant FROM kortix.account_tokens
       WHERE session_id = $1 AND status = 'active' AND revoked_at IS NULL`,
      [sessionId],
    );
    return rows[0]?.agent_grant ?? null;
  }

  /**
   * Mint one agent-session credential that matches the production token row.
   * See the file header for the exact reproduction and its limits.
   */
  async mintAgentSession(opts: MintOptions): Promise<AgentSession> {
    const sessionId = opts.sessionId ?? randomUUID();
    const userId = opts.launcher?.userId ?? this.ownerUserId;
    const serviceAccountId = await this.serviceAccountId(opts.agent);
    const mint = async (label: string) => {
      const minted = await this.owner.post('/v1/accounts/tokens', {
        name: `AGP ${label} ${sessionId.slice(0, 8)}`,
      });
      minted.status(201);
      const credential = minted.json<{ token_id: string; secret_key: string }>();
      this.tokens.push(credential.token_id);
      return credential;
    };
    // Two API-minted secrets bound to the same session: `resolver` asks the
    // gateway to reconcile the grant (the server rewrites EVERY live token of
    // the session); `credential` is the one the flow uses. The credential is
    // never presented before its grant is written, so the API's 15 s
    // token-binding memo can never hold a pre-grant row for it — exactly like a
    // production token, which carries its grant from birth.
    const credential = await mint('session');
    const resolver = opts.skipGrantSync ? null : await mint('grant-resolver');
    this.sessions.push(sessionId);
    const trigger = opts.launcher === null;
    const metadata = {
      workspace_mode: 'branch',
      ...(trigger ? { trigger_kind: 'git', trigger_source: 'manual', trigger_slug: 'agp-fixture' } : {}),
      ...(opts.metadata ?? {}),
    };
    await this.db.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
       VALUES ($1, $2, $3, $1, $4, 'running', $5, $6::kortix.project_session_visibility, $7::jsonb)`,
      [sessionId, this.accountId, this.projectId, opts.agent,
        // A trigger run is re-owned to the agent's service account
        // (trigger-session-access.ts applyTriggerSessionAccess).
        trigger ? serviceAccountId : userId,
        opts.visibility ?? 'private', JSON.stringify(metadata)],
    );
    await this.db.query(
      `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
       VALUES ($1::uuid, $1, $2, $3, 'active')`,
      [sessionId, this.accountId, this.projectId],
    );
    const onBehalfOfColumn = await this.hasOnBehalfOfColumn();
    for (const tokenId of [credential.token_id, resolver?.token_id].filter(Boolean) as string[]) {
      await this.db.query(
        `UPDATE kortix.account_tokens
           SET account_id = $2, user_id = $3, project_id = $4, session_id = $5,
               service_account_id = $6, agent_grant = NULL
         WHERE token_id = $1`,
        [tokenId, this.accountId, userId, this.projectId, sessionId, serviceAccountId],
      );
      if (onBehalfOfColumn) {
        await this.db.query(
          'UPDATE kortix.account_tokens SET on_behalf_of_user_id = $2 WHERE token_id = $1',
          [tokenId, trigger ? null : userId],
        );
      }
    }
    let grant: Record<string, unknown> | null = null;
    if (resolver) {
      grant = await this.syncGrant(credential.token_id, resolver.secret_key, opts.agent);
      await this.db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [resolver.token_id]);
    }
    return {
      sessionId,
      tokenId: credential.token_id,
      secret: credential.secret_key,
      agent: opts.agent,
      client: this.ctx.client.withBearer(credential.secret_key, `AGENT_${opts.agent}`),
      launcherUserId: opts.launcher?.userId ?? null,
      grant,
      onBehalfOfColumn,
    };
  }

  /**
   * Let the server write the agent grant onto the session's tokens (connector
   * gateway reconciliation) and wait for the grant of the latest manifest
   * commit on `tokenId`.
   */
  async syncGrant(tokenId: string, resolverSecret: string, agent: string): Promise<Record<string, unknown>> {
    const expectedCommit = this.lastManifestCommit;
    const resolver = this.ctx.client.withBearer(resolverSecret, 'AGENT_GRANT_RESOLVER');
    const deadline = Date.now() + 20_000;
    let last: Record<string, unknown> | null = null;
    let lastCatalog = '';
    while (Date.now() < deadline) {
      const catalog = await resolver.get('/v1/connectors/projects/:projectId/catalog', {
        params: { projectId: this.projectId },
      });
      lastCatalog = `${catalog.statusCode} ${catalog.text().slice(0, 300)}`;
      const { rows } = await this.db.query<{ agent_grant: Record<string, unknown> | null }>(
        'SELECT agent_grant FROM kortix.account_tokens WHERE token_id = $1',
        [tokenId],
      );
      last = rows[0]?.agent_grant ?? null;
      if (last && last.agent === agent && (!expectedCommit || last.manifestCommit === expectedCommit)) return last;
      // The gateway forces a mirror refresh at most once per 3 s per project.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    throw new Error(
      `the server did not resolve agent '${agent}' from kortix.yaml at ${expectedCommit ?? '(no commit)'} ` +
        `onto the session token within 20 s. Last stored grant: ${JSON.stringify(last)}. ` +
        `Last catalog response: ${lastCatalog}`,
    );
  }

  /** Remove every row this world created. Best effort; never throws. */
  async close(): Promise<void> {
    for (const sessionId of this.sessions) {
      for (const sql of [
        'DELETE FROM kortix.session_lifecycle_commands WHERE session_id = $1',
        'DELETE FROM kortix.account_tokens WHERE session_id = $1',
        'DELETE FROM kortix.session_sandboxes WHERE session_id = $1',
        'DELETE FROM kortix.project_sessions WHERE session_id = $1',
      ]) {
        await this.db.query(sql, [sessionId]).catch(() => {});
      }
    }
    for (const tokenId of this.tokens) {
      await this.db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]).catch(() => {});
    }
    await this.db.end().catch(() => {});
  }
}

/** Raw HTTP with an arbitrary bearer and headers (for paths outside /v1 or custom headers). */
export async function rawRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

/**
 * Assert a spec §4 denial body: status 403, `code`, and `action`.
 */
export function assertDenial(
  r: { statusCode: number; json<T>(): T; text(): string },
  code: string | RegExp,
  action?: string,
): void {
  let body: any = null;
  try {
    body = r.json<any>();
  } catch {
    body = null;
  }
  const codeOk = typeof code === 'string' ? body?.code === code : typeof body?.code === 'string' && code.test(body.code);
  if (r.statusCode !== 403 || !codeOk || (action !== undefined && body?.action !== action)) {
    throw new Error(
      `expected 403 {code: ${String(code)}${action ? `, action: ${action}` : ''}}, got ${r.statusCode} ${r.text().slice(0, 400)}`,
    );
  }
}

export async function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; expectFailure?: boolean } = {},
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    const result = await exec('git', args, {
      cwd: opts.cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
    });
    if (opts.expectFailure) throw new Error(`git ${args[0]}: expected a rejection, got success`);
    return result.stdout + result.stderr;
  } catch (error: any) {
    if (opts.expectFailure && typeof error?.code === 'number') {
      return String(error.stdout ?? '') + String(error.stderr ?? '');
    }
    if (error instanceof Error && error.message.startsWith('git ')) throw error;
    const output = String(error?.stdout ?? '') + String(error?.stderr ?? '');
    throw new Error(`git ${args.join(' ')} failed (${error?.code}): ${output.replace(/Bearer \S+/g, 'Bearer [redacted]')}`);
  }
}
