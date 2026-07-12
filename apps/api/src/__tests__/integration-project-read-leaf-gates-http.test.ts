import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { PROJECT_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
// A second principal on the SAME project with the 'editor' role — the floor
// `member` role has most READ leaves but NOT file.read / secret.read / any write
// (those are editor+), so the "human/legacy token with no agent grant still
// passes" cases for those routes need an editor, not the floor member.
const EDITOR = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'leaf-gate-http-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'leaf-gate-http-test-project',
    repoUrl: 'https://example.com/leaf-gate-http-test.git',
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

async function mintToken(agentGrant: unknown): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: MEMBER,
    projectId: PROJECT,
    name: 'leaf-gate-http-test',
    agentGrant: agentGrant as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function mintEditorToken(agentGrant: unknown): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: EDITOR,
    projectId: PROJECT,
    name: 'leaf-gate-http-test-editor',
    agentGrant: agentGrant as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function getReq(path: string, secret: string) {
  return app.request(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

function postReq(path: string, secret: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Case {
  name: string;
  leaf: string;
  path: () => string;
}

const CASES: Case[] = [
  { name: 'gateway logs', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ, path: () => `/v1/projects/${PROJECT}/gateway/logs` },
  { name: 'gateway errors', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ, path: () => `/v1/projects/${PROJECT}/gateway/errors` },
  { name: 'gateway overview', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ, path: () => `/v1/projects/${PROJECT}/gateway/overview` },
  { name: 'gateway series', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ, path: () => `/v1/projects/${PROJECT}/gateway/series` },
  { name: 'gateway sessions (per-session spend)', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ, path: () => `/v1/projects/${PROJECT}/gateway/sessions` },
  { name: 'gateway breakdown', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ, path: () => `/v1/projects/${PROJECT}/gateway/breakdown` },
  { name: 'gateway budgets', leaf: PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ, path: () => `/v1/projects/${PROJECT}/gateway/budgets` },
  { name: 'project sessions list', leaf: PROJECT_ACTIONS.PROJECT_SESSION_READ, path: () => `/v1/projects/${PROJECT}/sessions` },
  { name: 'project session detail', leaf: PROJECT_ACTIONS.PROJECT_SESSION_READ, path: () => `/v1/projects/${PROJECT}/sessions/${crypto.randomUUID()}` },
  { name: 'project session transcript', leaf: PROJECT_ACTIONS.PROJECT_SESSION_READ, path: () => `/v1/projects/${PROJECT}/sessions/${crypto.randomUUID()}/transcript` },
  { name: 'project session audit', leaf: PROJECT_ACTIONS.PROJECT_SESSION_READ, path: () => `/v1/projects/${PROJECT}/sessions/${crypto.randomUUID()}/audit` },
  { name: 'project access list', leaf: PROJECT_ACTIONS.PROJECT_MEMBERS_READ, path: () => `/v1/projects/${PROJECT}/access` },
  { name: 'oauth credentials list', leaf: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ, path: () => `/v1/projects/${PROJECT}/oauth` },
  { name: 'review items inbox', leaf: PROJECT_ACTIONS.PROJECT_REVIEW_READ, path: () => `/v1/projects/${PROJECT}/review/items` },
  { name: 'branches', leaf: PROJECT_ACTIONS.PROJECT_GITOPS_READ, path: () => `/v1/projects/${PROJECT}/branches` },
  { name: 'commits', leaf: PROJECT_ACTIONS.PROJECT_GITOPS_READ, path: () => `/v1/projects/${PROJECT}/commits` },
  { name: 'commit detail', leaf: PROJECT_ACTIONS.PROJECT_GITOPS_READ, path: () => `/v1/projects/${PROJECT}/commits/deadbeef` },
  { name: 'commit diff', leaf: PROJECT_ACTIONS.PROJECT_GITOPS_READ, path: () => `/v1/projects/${PROJECT}/commits/deadbeef/diff` },
  { name: 'version diff', leaf: PROJECT_ACTIONS.PROJECT_GITOPS_READ, path: () => `/v1/projects/${PROJECT}/version-diff?from=a&into=b` },
  { name: 'triggers list', leaf: PROJECT_ACTIONS.PROJECT_TRIGGER_READ, path: () => `/v1/projects/${PROJECT}/triggers` },
];

// EDITOR-TIER reads: project.file.read + project.secret.read were moved OUT of
// the floor `member` role into editor, so a bare member is 403 here (they can
// run the agent/chat but not browse the file tree or view secret values); an
// editor passes. Same agent-grant fold as the member-tier CASES above.
const EDITOR_TIER_READ_CASES: Case[] = [
  { name: 'files list', leaf: PROJECT_ACTIONS.PROJECT_FILE_READ, path: () => `/v1/projects/${PROJECT}/files` },
  { name: 'files archive', leaf: PROJECT_ACTIONS.PROJECT_FILE_READ, path: () => `/v1/projects/${PROJECT}/files/archive` },
  { name: 'files search', leaf: PROJECT_ACTIONS.PROJECT_FILE_READ, path: () => `/v1/projects/${PROJECT}/files/search?q=x` },
  { name: 'files content', leaf: PROJECT_ACTIONS.PROJECT_FILE_READ, path: () => `/v1/projects/${PROJECT}/files/content?path=README.md` },
  { name: 'files history', leaf: PROJECT_ACTIONS.PROJECT_FILE_READ, path: () => `/v1/projects/${PROJECT}/files/history?path=README.md` },
  { name: 'secrets list', leaf: PROJECT_ACTIONS.PROJECT_SECRET_READ, path: () => `/v1/projects/${PROJECT}/secrets` },
];

describe('HTTP enforcement — project read-leaf gates (agent-grant fold now reachable)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test('agent granted an UNRELATED capability → 403 (leaf missing from kortix_cli)', async () => {
        const secret = await mintToken({ agent: 'scoped-bot', kortixCli: ['project.trigger.fire'], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('agent granted the exact leaf → passes the gate (not 403)', async () => {
        const secret = await mintToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });

      test('full-role member token with NO grant (human/legacy) → passes the gate (not 403)', async () => {
        const secret = await mintToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });
    });
  }
});

describe('HTTP enforcement — gateway playground spend gate', () => {
  test('agent granted an UNRELATED capability → 403 before upstream dispatch', async () => {
    const secret = await mintToken({ agent: 'scoped-bot', kortixCli: ['project.trigger.fire'], connectors: [] });
    const res = await postReq(`/v1/projects/${PROJECT}/gateway/playground`, secret, {
      prompt: 'hello',
      models: ['not-a-real-model'],
    });
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toContain(PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);
  });
});

describe('HTTP enforcement — editor-tier read gates (file.read / secret.read moved off member)', () => {
  for (const c of EDITOR_TIER_READ_CASES) {
    describe(c.name, () => {
      test('floor MEMBER (no file/secret read) → 403', async () => {
        const secret = await mintToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('EDITOR (has the read leaf) → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });

      test('agent (editor) granted the exact leaf → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });
    });
  }
});

// TIER-1 SECURITY — these two are SEND primitives (post an arbitrary file to
// Slack / make the meeting bot speak) that used to be gated by nothing but
// loadProjectForUser(..,'read') — any project-read caller could invoke them.
// Fixed by asserting project.connector.write (the same leaf that already
// gates Slack connect/disconnect and the channel-bindings route) instead of
// wiring the dead/unwired channel.send catalog leaf.
const SEND_PRIMITIVE_CASES: Case[] = [
  {
    name: 'slack file upload proxy',
    leaf: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    path: () => `/v1/projects/${PROJECT}/channels/slack/file/upload`,
  },
  {
    name: 'meet speak proxy',
    leaf: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    path: () => `/v1/projects/${PROJECT}/channels/meet/speak`,
  },
];

describe('HTTP enforcement — send-primitive gates (Slack upload / meet speak)', () => {
  for (const c of SEND_PRIMITIVE_CASES) {
    describe(c.name, () => {
      test('floor MEMBER (project-read, no connector.write) → 403 — the exact vulnerability the audit found', async () => {
        // Before this fix, a bare loadProjectForUser(..,'read') gate let ANY
        // project-read caller — including the floor `member` role — hit this
        // send primitive. Deliberately empty body: the IAM gate must fire
        // before body validation.
        const secret = await mintToken(null);
        const res = await postReq(c.path(), secret, {});
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('EDITOR (has connector.write) → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken(null);
        const res = await postReq(c.path(), secret, {});
        expect(res.status).not.toBe(403);
      });

      test('scoped agent launched by an editor but missing connector.write in kortix_cli → 403', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: ['project.trigger.fire'], connectors: [] });
        const res = await postReq(c.path(), secret, {});
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('scoped agent launched by an editor AND granted connector.write → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await postReq(c.path(), secret, {});
        expect(res.status).not.toBe(403);
      });
    });
  }
});
