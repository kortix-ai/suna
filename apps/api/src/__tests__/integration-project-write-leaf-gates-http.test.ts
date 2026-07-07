import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { PROJECT_ACTIONS } from '../iam';

// Every capability checkbox must be authoritative: unchecking a leaf must DENY
// its endpoint. These endpoints previously gated on a coarse floor only (or an
// agent-scope check that is a no-op for humans), so unchecking the leaf did
// nothing. This suite proves each newly-added leaf gate fires, using the
// agent-grant fold: a scoped agent token restricts the launching user to the
// leaves in its kortix_cli grant (project.read/project.write are exempt — see
// AGENT_GRANT_EXEMPT_ACTIONS — so the coarse floor always passes and only the
// specific leaf gate is under test).
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const EDITOR = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'write-leaf-gate-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'write-leaf-gate-test-project',
    repoUrl: 'https://example.com/write-leaf-gate-test.git',
  });
  await db.insert(accountMembers).values([
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: EDITOR, projectRole: 'editor' },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function mint(userId: string, kortixCli: string[] | null): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'write-leaf-gate-test',
    agentGrant: (kortixCli ? { agent: 'scoped-bot', kortixCli, connectors: [] } : null) as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// An IAM denial (403) from either loadProjectForUser (floor) or
// assertProjectCapability (leaf). Both phrase it distinctively; a non-IAM 403
// (e.g. the "email is experimental" gate) matches none of these, so the ALLOW
// cases can still 403 for an unrelated reason without being counted as a leaf
// denial.
async function iamDenied(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = JSON.stringify(await res.json().catch(() => ({})));
  return /permission|do not have access|doesn't let you/i.test(text);
}

interface WCase {
  name: string;
  leaf: string;
  method: string;
  path: () => string;
  body?: unknown;
  // 'member' = the floor role holds this leaf (so a plain member passes);
  // 'editor' = editor-tier (a plain member is denied, an editor passes).
  tier: 'member' | 'editor';
  // kortix_cli grants for the agent-grant fold. deny = a grant that should be
  // rejected by the leaf gate; allow = the exact grant that should pass it.
  denyGrant: string[];
  allowGrant: string[];
}

const A = PROJECT_ACTIONS;
const sid = () => crypto.randomUUID();

const CASES: WCase[] = [
  // ── Session lifecycle ────────────────────────────────────────────────────
  {
    name: 'session start (floor session.start)',
    leaf: A.PROJECT_SESSION_START, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/sessions/${sid()}/start`,
    tier: 'member', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_SESSION_START],
  },
  {
    name: 'session stop (leaf session.stop)',
    leaf: A.PROJECT_SESSION_STOP, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/sessions/${sid()}/stop`,
    tier: 'member',
    // floor is session.start, so the deny grant must hold start (to reach the
    // stop assert) but not stop.
    denyGrant: [A.PROJECT_SESSION_START], allowGrant: [A.PROJECT_SESSION_START, A.PROJECT_SESSION_STOP],
  },
  // ── Review ───────────────────────────────────────────────────────────────
  {
    name: 'CR request-changes (review.act, not gitops.push)',
    leaf: A.PROJECT_REVIEW_ACT, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/change-requests/${sid()}/request-changes`, body: {},
    tier: 'editor',
    // deny with gitops.push (the OLD leaf) to prove the gate is now review.act.
    denyGrant: [A.PROJECT_GITOPS_PUSH], allowGrant: [A.PROJECT_REVIEW_ACT],
  },
  {
    name: 'review item submit (review.submit)',
    leaf: A.PROJECT_REVIEW_SUBMIT, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/review/items`, body: {},
    tier: 'member', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_REVIEW_SUBMIT],
  },
  // ── Connectors (write) ───────────────────────────────────────────────────
  {
    name: 'email connect (connector.write)',
    leaf: A.PROJECT_CONNECTOR_WRITE, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/channels/email/connect`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_WRITE],
  },
  {
    name: 'email installation PATCH (connector.write)',
    leaf: A.PROJECT_CONNECTOR_WRITE, method: 'PATCH',
    path: () => `/v1/projects/${PROJECT}/channels/email/installation`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_WRITE],
  },
  {
    name: 'email installation DELETE (connector.write)',
    leaf: A.PROJECT_CONNECTOR_WRITE, method: 'DELETE',
    path: () => `/v1/projects/${PROJECT}/channels/email/installation`,
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_WRITE],
  },
  {
    name: 'channel binding PATCH (connector.write)',
    leaf: A.PROJECT_CONNECTOR_WRITE, method: 'PATCH',
    path: () => `/v1/projects/${PROJECT}/channels/bindings/${sid()}`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_WRITE],
  },
  {
    name: 'connect-requests (connector.write)',
    leaf: A.PROJECT_CONNECTOR_WRITE, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/connect-requests`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_WRITE],
  },
  // ── Connectors (read) ────────────────────────────────────────────────────
  {
    name: 'channel bindings list (connector.read)',
    leaf: A.PROJECT_CONNECTOR_READ, method: 'GET',
    path: () => `/v1/projects/${PROJECT}/channels/bindings`,
    tier: 'member', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CONNECTOR_READ],
  },
  // ── Customize (write) ────────────────────────────────────────────────────
  {
    name: 'meet bot name (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'PUT',
    path: () => `/v1/projects/${PROJECT}/channels/meet/name`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  {
    name: 'meet voice (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'PUT',
    path: () => `/v1/projects/${PROJECT}/channels/meet/voice`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  {
    // Strict body (ModelDefaultBody) is validated at the OpenAPI layer BEFORE the
    // handler, so send a schema-valid body — otherwise a 400 pre-empts the gate.
    name: 'model-defaults PUT (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'PUT',
    path: () => `/v1/projects/${PROJECT}/model-defaults`, body: { scope: 'project', model: 'openai/gpt-4o' },
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  {
    name: 'model-defaults DELETE (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'DELETE',
    path: () => `/v1/projects/${PROJECT}/model-defaults?scope=project`,
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  {
    name: 'experimental toggle (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'PATCH',
    path: () => `/v1/projects/${PROJECT}/experimental`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  {
    name: 'sandbox-provider (customize.write)',
    leaf: A.PROJECT_CUSTOMIZE_WRITE, method: 'PATCH',
    path: () => `/v1/projects/${PROJECT}/sandbox-provider`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_CUSTOMIZE_WRITE],
  },
  // ── Agent scope (agent.write) ────────────────────────────────────────────
  {
    name: 'agent scope PUT (agent.write)',
    leaf: A.PROJECT_AGENT_WRITE, method: 'PUT',
    path: () => `/v1/projects/${PROJECT}/agents/scoped-bot/scope`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_AGENT_WRITE],
  },
  // ── Secrets (write) ──────────────────────────────────────────────────────
  {
    name: 'secret-requests (secret.write)',
    leaf: A.PROJECT_SECRET_WRITE, method: 'POST',
    path: () => `/v1/projects/${PROJECT}/secret-requests`, body: {},
    tier: 'editor', denyGrant: [A.PROJECT_TRIGGER_FIRE], allowGrant: [A.PROJECT_SECRET_WRITE],
  },
];

describe('HTTP enforcement — project write/lifecycle leaf gates (every checkbox authoritative)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test('scoped agent with an UNRELATED grant → denied by the leaf gate', async () => {
        const secret = await mint(EDITOR, c.denyGrant);
        const res = await req(c.method, c.path(), secret, c.body);
        expect(await iamDenied(res)).toBe(true);
      });

      test('scoped agent granted the exact leaf → NOT denied by the leaf gate', async () => {
        const secret = await mint(EDITOR, c.allowGrant);
        const res = await req(c.method, c.path(), secret, c.body);
        expect(await iamDenied(res)).toBe(false);
      });

      if (c.tier === 'editor') {
        test('plain MEMBER (lacks the editor-tier leaf) → denied', async () => {
          const secret = await mint(MEMBER, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(true);
        });
        test('plain EDITOR (holds the leaf) → NOT denied', async () => {
          const secret = await mint(EDITOR, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(false);
        });
      } else {
        test('plain MEMBER (floor role holds the leaf) → NOT denied', async () => {
          const secret = await mint(MEMBER, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(false);
        });
      }
    });
  }
});
