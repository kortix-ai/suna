import { describe, expect, test } from 'bun:test';
import {
  ProjectSchema,
  ProjectSessionSandboxSchema,
  ProjectSessionSchema,
  SecretSchema,
  SessionStartResultSchema,
} from '@kortix/api-contract';
import type { projectSecrets, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { buildSecretView, serializeProject, serializeSession } from '../projects/lib/serializers';
import { serializeSandboxRow } from '../projects/routes/shared';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_ID = '99999999-8888-4777-8666-555555555555';
const USER_ID = '77777777-6666-4555-8444-333333333333';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function projectRow(
  overrides: Partial<typeof projects.$inferSelect> = {},
): typeof projects.$inferSelect {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Demo Project',
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    manifestPath: 'kortix.toml',
    status: 'active',
    metadata: {},
    lastOpenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sessionRow(
  overrides: Partial<typeof projectSessions.$inferSelect> = {},
): typeof projectSessions.$inferSelect {
  return {
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'kortix/session-1',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: null,
    sandboxUrl: null,
    opencodeSessionId: 'ses_abc',
    agentName: 'default',
    status: 'running',
    error: null,
    createdBy: USER_ID,
    visibility: 'private',
    metadata: { name: 'Fix the login bug' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sandboxRow(
  overrides: Partial<typeof sessionSandboxes.$inferSelect> = {},
): typeof sessionSandboxes.$inferSelect {
  return {
    sandboxId: SESSION_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    provider: 'platinum',
    externalId: 'sbx-123',
    baseUrl: 'https://sbx-123.proxy.kortix.com',
    status: 'active',
    config: { serviceKey: 'sensitive', region: 'eu' },
    metadata: {},
    lastUsedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function secretRow(
  overrides: Partial<typeof projectSecrets.$inferSelect> = {},
): typeof projectSecrets.$inferSelect {
  return {
    secretId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    projectId: PROJECT_ID,
    identifier: overrides.name ?? 'OPENAI_API_KEY',
    name: 'OPENAI_API_KEY',
    valueEnc: 'enc:v1:abc',
    scope: 'runtime',
    ownerUserId: null,
    active: true,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('serializeProject ⇄ ProjectSchema', () => {
  test('output parses strictly and round-trips unchanged', () => {
    const out = serializeProject(projectRow(), {
      projectRole: 'editor',
      effectiveRole: 'editor',
    });
    expect(ProjectSchema.strict().parse(out)).toEqual(out);
  });

  test('output without access context parses with null roles', () => {
    const out = serializeProject(projectRow({ lastOpenedAt: null }));
    const parsed = ProjectSchema.strict().parse(out);
    expect(parsed.project_role).toBeNull();
    expect(parsed.effective_project_role).toBeNull();
    expect(parsed.last_opened_at).toBeNull();
  });

  test('experimental map carries every registered feature key', () => {
    const out = serializeProject(projectRow());
    expect(Object.keys(out.experimental).sort()).toEqual(
      Object.keys(ProjectSchema.shape.experimental.shape).sort(),
    );
  });
});

describe('serializeSession ⇄ ProjectSessionSchema', () => {
  test('owner view parses strictly and round-trips unchanged', () => {
    const out = serializeSession(sessionRow(), {
      viewerId: USER_ID,
      canManageProject: false,
    });
    expect(ProjectSessionSchema.strict().parse(out)).toEqual(out);
  });

  test('restricted shared view with grants parses', () => {
    const out = serializeSession(sessionRow({ visibility: 'restricted' }), {
      grants: [{ principalType: 'member', principalId: USER_ID }],
      viewerId: 'someone-else',
      canManageProject: true,
      ownerEmail: 'owner@acme.dev',
    });
    const parsed = ProjectSessionSchema.strict().parse(out);
    expect(parsed.sharing).toEqual({ mode: 'members', memberIds: [USER_ID], groupIds: [] });
    expect(parsed.owner_email).toBe('owner@acme.dev');
    expect(parsed.is_owner).toBe(false);
  });

  test('custom_name override wins over the auto title', () => {
    const out = serializeSession(sessionRow({ metadata: { name: 'auto', custom_name: 'Mine' } }));
    const parsed = ProjectSessionSchema.strict().parse(out);
    expect(parsed.name).toBe('Mine');
    expect(parsed.custom_name).toBe('Mine');
  });
});

describe('serializeSandboxRow ⇄ ProjectSessionSandboxSchema', () => {
  test('output parses strictly and scrubs serviceKey from config', () => {
    const out = serializeSandboxRow(sandboxRow());
    const parsed = ProjectSessionSandboxSchema.strict().parse(out);
    expect(parsed).toEqual(out);
    expect(parsed.config).toEqual({ region: 'eu' });
  });

  test('start payload embedding the serialized row parses', () => {
    const payload = {
      stage: 'ready' as const,
      agent_name: 'default',
      retriable: false,
      sandbox: serializeSandboxRow(sandboxRow()),
      opencode_session_id: 'ses_abc',
      runtime_url: '/p/sbx-123/8000',
      reason: 'pinned',
    };
    expect(SessionStartResultSchema.strict().parse(payload)).toEqual(payload);
  });
});

describe('buildSecretView ⇄ SecretSchema', () => {
  test('shared project secret parses strictly and round-trips unchanged', () => {
    const out = buildSecretView({
      identifier: 'OPENAI_API_KEY',
      name: 'OPENAI_API_KEY',
      shared: secretRow(),
      canManageShared: true,
    });
    expect(SecretSchema.strict().parse(out)).toEqual(out);
    expect(out.effective_source).toBe('shared');
  });

  test('two identifiers sharing the same key parse as independent secrets', () => {
    const primary = buildSecretView({
      identifier: 'GMAPS-primary',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: secretRow({ identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY' }),
      canManageShared: true,
    });
    const backup = buildSecretView({
      identifier: 'GMAPS-backup',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: secretRow({ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' }),
      canManageShared: true,
    });
    expect(SecretSchema.strict().parse(primary)).toEqual(primary);
    expect(SecretSchema.strict().parse(backup)).toEqual(backup);
    expect(primary.name).toBe(backup.name);
    expect(primary.identifier).not.toBe(backup.identifier);
  });

  test('personal override view parses', () => {
    const out = buildSecretView({
      identifier: 'OPENAI_API_KEY',
      name: 'OPENAI_API_KEY',
      personal: secretRow({ ownerUserId: USER_ID }),
      canManageShared: false,
    });
    const parsed = SecretSchema.strict().parse(out);
    expect(parsed.configured).toBe(false);
    expect(parsed.effective_source).toBe('mine');
    expect(parsed.mine).toEqual({ active: true, updated_at: NOW.toISOString() });
  });

  test('system git-auth secret parses and cannot be managed even by an editor', () => {
    const out = buildSecretView({
      identifier: 'KORTIX_GIT_AUTH_TOKEN',
      name: 'KORTIX_GIT_AUTH_TOKEN',
      shared: secretRow({ identifier: 'KORTIX_GIT_AUTH_TOKEN', name: 'KORTIX_GIT_AUTH_TOKEN' }),
      canManageShared: true,
    });
    const parsed = SecretSchema.strict().parse(out);
    expect(parsed.system).toBe(true);
    expect(parsed.purpose).toBe('git_auth');
    expect(parsed.can_manage_shared).toBe(false);
  });
});
