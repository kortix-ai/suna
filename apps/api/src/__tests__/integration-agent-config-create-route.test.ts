import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { accountMembers, accounts, changeRequests, projectMembers, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../iam';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

const run = promisify(execFile);

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const PROJECTS: string[] = [];
const TOKENS: string[] = [];

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-agent-create-route-'));
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-create-route-test' });
  await db.insert(accountMembers).values({
    userId: OWNER,
    accountId: ACCOUNT,
    accountRole: 'member',
    isSuperAdmin: false,
  });
});

afterAll(async () => {
  for (const tokenId of TOKENS) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  for (const projectId of PROJECTS) {
    await db.delete(changeRequests).where(eq(changeRequests.projectId, projectId));
    await db.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  await db.delete(accountMembers).where(
    and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, OWNER)),
  );
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await rm(root, { recursive: true, force: true });
});

async function seedRepo(
  name: string,
  files: Record<string, string>,
): Promise<{ repo: string; projectId: string; token: string }> {
  const repo = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  await run('git', ['init', '--bare', '--initial-branch=main', repo]);
  await run('git', ['init', '-b', 'main', work]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Kortix',
    GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix',
    GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
  };
  await run('git', ['add', '-A'], { cwd: work, env });
  await run('git', ['commit', '-m', 'chore: seed project'], { cwd: work, env });
  await run('git', ['push', repo, 'main:refs/heads/main'], { cwd: work, env });

  const projectId = crypto.randomUUID();
  PROJECTS.push(projectId);
  await db.insert(projects).values({
    projectId,
    accountId: ACCOUNT,
    name,
    repoUrl: repo,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
  });
  await db.insert(projectMembers).values({
    accountId: ACCOUNT,
    projectId,
    userId: OWNER,
    projectRole: 'editor',
  });
  const token = await createAccountToken({
    accountId: ACCOUNT,
    userId: OWNER,
    projectId,
    name: `${name}-token`,
  });
  TOKENS.push(token.tokenId);
  return { repo, projectId, token: token.secretKey };
}

function request(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const MANIFEST = `
kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [github]
`;

const CREATE_BODY = {
  agentName: 'reliance-cto',
  block: {
    enabled: true,
    connectors: ['github'],
    connectors_required: ['github'],
    kortix_cli: ['project.cr.open'],
    workspace: 'branch',
    opencode: {
      description: 'Reliance CTO',
      mode: 'primary',
      model: 'openai/gpt-4o',
      prompt: 'You are the Reliance CTO. Review technical work.',
    },
  },
};

describe('agent config create HTTP route', () => {
  test('previews, creates a branch-backed CR, and leaves default branch inactive', async () => {
    const { projectId, token } = await seedRepo('agent-create-success', {
      'kortix.yaml': MANIFEST,
      '.kortix/opencode/agents/support.md': 'Support prompt.',
    });

    const preview = await request(
      'POST',
      `/v1/projects/${projectId}/agents/preview`,
      token,
      CREATE_BODY,
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.behavior_path).toBe('.kortix/opencode/agents/reliance-cto.md');
    expect(previewBody.behavior_markdown).toContain('Reliance CTO');
    expect(previewBody.preview_revision).toMatch(/^[a-f0-9]{64}$/);

    const create = await request('POST', `/v1/projects/${projectId}/agents`, token, {
      ...CREATE_BODY,
      preview_revision: previewBody.preview_revision,
    });
    expect(create.status).toBe(201);
    const createBody = await create.json();
    expect(createBody.branch).toMatch(
      /^kortix\/agents\/create\/reliance-cto-\d{14}-[a-f0-9]{8}$/,
    );
    expect(createBody.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(createBody.change_request.head_ref).toBe(createBody.branch);
    expect(createBody.behavior_path).toBe('.kortix/opencode/agents/reliance-cto.md');

    const diff = await request(
      'GET',
      `/v1/projects/${projectId}/change-requests/${createBody.change_request.cr_id}/diff`,
      token,
    );
    expect(diff.status).toBe(200);
    const diffBody = await diff.json();
    expect(diffBody.files.map((file: { path: string }) => file.path).sort()).toEqual([
      '.kortix/opencode/agents/reliance-cto.md',
      'kortix.yaml',
    ]);

    const readDefault = await request(
      'GET',
      `/v1/projects/${projectId}/agents/reliance-cto/config`,
      token,
    );
    expect(readDefault.status).toBe(200);
    const readBody = await readDefault.json();
    expect(readBody.block).toBeNull();
    expect(readBody.behavior_file_state).toBe('missing');
  });

  test('rejects stale preview revisions before git writes', async () => {
    const { projectId, token } = await seedRepo('agent-create-stale-preview', {
      'kortix.yaml': MANIFEST,
      '.kortix/opencode/agents/support.md': 'Support prompt.',
    });

    const create = await request('POST', `/v1/projects/${projectId}/agents`, token, {
      ...CREATE_BODY,
      preview_revision: '0'.repeat(64),
    });
    expect(create.status).toBe(409);
    const body = await create.json();
    expect(body.code).toBe('stale_preview_revision');
  });

  test('rejects a second create while an open CR reserves the same agentName', async () => {
    const { projectId, token } = await seedRepo('agent-create-pending-duplicate', {
      'kortix.yaml': MANIFEST,
      '.kortix/opencode/agents/support.md': 'Support prompt.',
    });
    const preview = await request(
      'POST',
      `/v1/projects/${projectId}/agents/preview`,
      token,
      CREATE_BODY,
    );
    const previewBody = await preview.json();
    const create = await request('POST', `/v1/projects/${projectId}/agents`, token, {
      ...CREATE_BODY,
      preview_revision: previewBody.preview_revision,
    });
    expect(create.status).toBe(201);
    const first = await create.json();

    const duplicate = await request('POST', `/v1/projects/${projectId}/agents`, token, {
      ...CREATE_BODY,
      preview_revision: previewBody.preview_revision,
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.code).toBe('pending_duplicate_agent_create');
    expect(duplicateBody.change_request.cr_id).toBe(first.change_request.cr_id);
  });
});

describe('agent behavior repair HTTP route', () => {
  test('reports missing behavior state and creates a repair CR from reviewed markdown', async () => {
    const { projectId, token } = await seedRepo('agent-repair-success', {
      'kortix.yaml': MANIFEST,
    });

    const readMissing = await request('GET', `/v1/projects/${projectId}/agents/support/config`, token);
    expect(readMissing.status).toBe(200);
    const missingBody = await readMissing.json();
    expect(missingBody.behavior_path).toBe('.kortix/opencode/agents/support.md');
    expect(missingBody.behavior_file_state).toBe('missing');

    const repair = await request(
      'POST',
      `/v1/projects/${projectId}/agents/support/behavior-repair`,
      token,
      {
        behavior_markdown:
          '---\ndescription: Support specialist\nmode: subagent\n---\n\nYou repair support tickets.',
      },
    );
    expect(repair.status).toBe(201);
    const repairBody = await repair.json();
    expect(repairBody.branch).toMatch(/^kortix\/agents\/repair\/support-\d{14}-[a-f0-9]{8}$/);
    expect(repairBody.behavior_path).toBe('.kortix/opencode/agents/support.md');

    const diff = await request(
      'GET',
      `/v1/projects/${projectId}/change-requests/${repairBody.change_request.cr_id}/diff`,
      token,
    );
    expect(diff.status).toBe(200);
    const diffBody = await diff.json();
    expect(diffBody.files.map((file: { path: string }) => file.path)).toEqual([
      '.kortix/opencode/agents/support.md',
    ]);
  });

  test('reports empty behavior files as exists, not missing', async () => {
    const { projectId, token } = await seedRepo('agent-repair-empty-exists', {
      'kortix.yaml': MANIFEST,
      '.kortix/opencode/agents/support.md': '',
    });

    const read = await request('GET', `/v1/projects/${projectId}/agents/support/config`, token);
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.behavior_file_state).toBe('exists');
  });

  test('rejects repair without reviewed behavior markdown', async () => {
    const { projectId, token } = await seedRepo('agent-repair-empty-request', {
      'kortix.yaml': MANIFEST,
    });

    const repair = await request(
      'POST',
      `/v1/projects/${projectId}/agents/support/behavior-repair`,
      token,
      { behavior_markdown: '   ' },
    );
    expect(repair.status).toBe(400);
    const body = await repair.json();
    expect(body.code).toBe('missing_behavior_markdown');
  });
});

describe('agent create leaf gates', () => {
  test('scoped callers need agent write and CR open grants', async () => {
    const { projectId } = await seedRepo('agent-create-leaf-gates', {
      'kortix.yaml': MANIFEST,
      '.kortix/opencode/agents/support.md': 'Support prompt.',
    });
    const denied = await createAccountToken({
      accountId: ACCOUNT,
      userId: OWNER,
      projectId,
      name: 'agent-create-denied',
      agentGrant: {
        agent: 'scoped-bot',
        connectors: [],
        kortixCli: [PROJECT_ACTIONS.PROJECT_AGENT_WRITE],
      } as any,
    });
    TOKENS.push(denied.tokenId);

    const res = await request('POST', `/v1/projects/${projectId}/agents`, denied.secretKey, {
      ...CREATE_BODY,
      preview_revision: '0'.repeat(64),
    });
    expect(res.status).toBe(403);
    const text = JSON.stringify(await res.json().catch(() => ({})));
    expect(text).toMatch(/project\.gitops\.push|project\.cr\.open|permission/i);
  });
});
