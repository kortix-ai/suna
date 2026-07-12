import { describe, expect, test } from 'bun:test';
import {
  ConnectionProfileMetadataSchema,
  EXPERIMENTAL_FEATURE_KEYS,
  ErrorEnvelopeSchema,
  OkResponseSchema,
  ProjectSchema,
  ProjectSessionSandboxSchema,
  ProjectSessionSchema,
  ReconcileConnectionProfileInputSchema,
  SecretSchema,
  SessionConnectorBindingsSchema,
  SessionCreateAcceptedSchema,
  SessionCreateInputSchema,
  SessionRuntimeContextSchema,
  SessionStartResultSchema,
  SharingIntentSchema,
  TriggerListSchema,
  TriggerSchema,
  UpdateConnectionProfileCredentialInputSchema,
} from '../index';

const NOW = '2026-07-01T12:00:00.000Z';

function projectFixture(overrides: Record<string, unknown> = {}) {
  return {
    project_id: '11111111-2222-4333-8444-555555555555',
    account_id: '99999999-8888-4777-8666-555555555555',
    name: 'Demo Project',
    repo_url: 'https://github.com/acme/demo',
    git_origin_url: 'https://github.com/acme/demo',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: { onboarding_completed_at: NOW },
    last_opened_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    project_role: 'manager',
    effective_project_role: 'manager',
    dashboard_url: 'https://kortix.com/projects/11111111-2222-4333-8444-555555555555',
    experimental: {
      apps: false,
      agent_tunnel: false,
      marketplace: false,
      agentmail_email: false,
      meet: false,
      llm_gateway: true,
      review_center: false,
    },
    experimental_features: [
      {
        key: 'apps',
        name: 'Apps',
        description: 'Deploy apps.',
        stability: 'experimental',
        available: true,
        enabled: false,
        overridden: false,
      },
    ],
    apps_enabled: false,
    default_sandbox_provider: null,
    available_sandbox_providers: ['daytona', 'platinum'],
    ...overrides,
  };
}

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    account_id: '99999999-8888-4777-8666-555555555555',
    project_id: '11111111-2222-4333-8444-555555555555',
    branch_name: 'kortix/session-1',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: null,
    sandbox_url: null,
    opencode_session_id: 'ses_abc',
    runtime_session_id: 'ses_abc',
    name: 'Fix the login bug',
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: { name: 'Fix the login bug' },
    opencode_sessions: [],
    created_by: '99999999-8888-4777-8666-555555555555',
    owner_email: null,
    visibility: 'private',
    sharing: { mode: 'private', ownerId: '' },
    is_owner: true,
    can_manage_sharing: true,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function sandboxFixture(overrides: Record<string, unknown> = {}) {
  return {
    sandbox_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    project_id: '11111111-2222-4333-8444-555555555555',
    account_id: '99999999-8888-4777-8666-555555555555',
    provider: 'platinum',
    external_id: 'sbx-123',
    base_url: 'https://sbx-123.proxy.kortix.com',
    status: 'active',
    config: {},
    metadata: {},
    last_used_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function triggerFixture(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'nightly-report',
    path: 'kortix.yaml#triggers.nightly-report',
    name: 'Nightly report',
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    cron: '0 0 3 * * *',
    run_at: null,
    timezone: 'UTC',
    secret_env: null,
    prompt_template: 'Summarize yesterday.',
    session_mode: 'fresh',
    last_fired_at: NOW,
    last_status: 'queued',
    last_error: null,
    last_attempt_at: NOW,
    webhook_url: null,
    ...overrides,
  };
}

function secretFixture(overrides: Record<string, unknown> = {}) {
  return {
    // Unique per project — the handle an agent's `secrets` grant references.
    // Authorization moved to the agent grant (by identifier); the old
    // share_scope/sharing/usable_by_me per-member sharing model was retired.
    identifier: 'openai-api-key-primary',
    name: 'OPENAI_API_KEY',
    project_id: '11111111-2222-4333-8444-555555555555',
    secret_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    created_by: '99999999-8888-4777-8666-555555555555',
    created_at: NOW,
    updated_at: NOW,
    system: false,
    readonly: false,
    purpose: null,
    can_rotate: false,
    managed_by: null,
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
    ...overrides,
  };
}

describe('ProjectSchema', () => {
  test('accepts a full serialized project', () => {
    expect(() => ProjectSchema.strict().parse(projectFixture())).not.toThrow();
  });

  test('accepts null roles for inherited access', () => {
    const parsed = ProjectSchema.parse(
      projectFixture({ project_role: null, effective_project_role: 'member' }),
    );
    expect(parsed.project_role).toBeNull();
  });

  test('rejects an unknown status', () => {
    expect(() => ProjectSchema.parse(projectFixture({ status: 'deleted' }))).toThrow();
  });

  test('rejects an experimental map missing a registered key', () => {
    const { llm_gateway: _dropped, ...partial } = projectFixture().experimental as Record<
      string,
      boolean
    >;
    expect(() => ProjectSchema.parse(projectFixture({ experimental: partial }))).toThrow();
  });
});

describe('ProjectSessionSchema', () => {
  test('accepts a full serialized session', () => {
    expect(() => ProjectSessionSchema.strict().parse(sessionFixture())).not.toThrow();
  });

  test.each([
    { mode: 'project' },
    { mode: 'private', ownerId: 'u1' },
    { mode: 'members', memberIds: ['u1'], groupIds: [] },
  ])('accepts sharing intent %#', (sharing) => {
    expect(() => ProjectSessionSchema.parse(sessionFixture({ sharing }))).not.toThrow();
  });

  test('rejects a sharing intent with an unknown mode', () => {
    expect(() =>
      ProjectSessionSchema.parse(sessionFixture({ sharing: { mode: 'everyone' } })),
    ).toThrow();
  });

  test('rejects a Date where an ISO string is expected', () => {
    expect(() =>
      ProjectSessionSchema.parse(sessionFixture({ created_at: new Date(NOW) })),
    ).toThrow();
  });
});

describe('SessionStartResultSchema', () => {
  test('accepts the provisioning payload without sandbox or runtime_url', () => {
    const parsed = SessionStartResultSchema.strict().parse({
      stage: 'provisioning',
      agent_name: 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
    });
    expect(parsed.runtime_url).toBeUndefined();
  });

  test('accepts the ready payload with a serialized sandbox', () => {
    const parsed = SessionStartResultSchema.parse({
      stage: 'ready',
      agent_name: 'default',
      retriable: false,
      sandbox: sandboxFixture(),
      opencode_session_id: 'ses_abc',
      runtime_url: '/p/sbx-123/8000',
      reason: 'pinned',
    });
    expect(parsed.sandbox?.provider).toBe('platinum');
  });

  test('rejects an unknown stage', () => {
    expect(() =>
      SessionStartResultSchema.parse({
        stage: 'booting',
        agent_name: 'default',
        retriable: true,
        sandbox: null,
        opencode_session_id: null,
      }),
    ).toThrow();
  });
});

describe('ProjectSessionSandboxSchema', () => {
  test('accepts every provider the platform can emit', () => {
    for (const provider of ['daytona', 'local_docker', 'justavps', 'platinum']) {
      expect(() =>
        ProjectSessionSandboxSchema.strict().parse(sandboxFixture({ provider })),
      ).not.toThrow();
    }
  });
});

describe('TriggerSchema', () => {
  test('accepts a cron trigger and a webhook trigger', () => {
    expect(() => TriggerSchema.strict().parse(triggerFixture())).not.toThrow();
    expect(() =>
      TriggerSchema.strict().parse(
        triggerFixture({
          type: 'webhook',
          cron: null,
          secret_env: 'HOOK_SECRET',
          webhook_url: 'https://api.kortix.com/v1/webhooks/projects/p/hook',
        }),
      ),
    ).not.toThrow();
  });

  test('list response is an envelope, not a bare array', () => {
    expect(() =>
      TriggerListSchema.strict().parse({
        triggers: [triggerFixture()],
        triggers_paused: false,
        errors: [{ slug: 'bad', path: 'kortix.yaml#triggers.bad', error: 'invalid cron' }],
      }),
    ).not.toThrow();
    expect(TriggerListSchema.safeParse([triggerFixture()]).success).toBe(false);
  });
});

describe('SecretSchema', () => {
  test('accepts the shared view and the personal-override view', () => {
    expect(() => SecretSchema.strict().parse(secretFixture())).not.toThrow();
    expect(() =>
      SecretSchema.strict().parse(
        secretFixture({
          configured: false,
          secret_id: null,
          created_by: null,
          mine: { active: true, updated_at: NOW },
          effective_source: 'mine',
        }),
      ),
    ).not.toThrow();
  });

  test('accepts the system git-auth secret shape', () => {
    expect(() =>
      SecretSchema.parse(
        secretFixture({
          name: 'KORTIX_GIT_AUTH_TOKEN',
          system: true,
          readonly: true,
          purpose: 'git_auth',
          can_rotate: true,
          managed_by: 'project_secret',
        }),
      ),
    ).not.toThrow();
  });
});

describe('envelopes', () => {
  test('error envelope tolerates both string and boolean error fields', () => {
    expect(() => ErrorEnvelopeSchema.parse({ error: 'Not found' })).not.toThrow();
    expect(() =>
      ErrorEnvelopeSchema.parse({ error: true, message: 'Validation failed', status: 400 }),
    ).not.toThrow();
  });

  test('ok response requires literal true', () => {
    expect(() => OkResponseSchema.parse({ ok: true })).not.toThrow();
    expect(OkResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });

  test('session-create 202 envelope parses', () => {
    expect(() =>
      SessionCreateAcceptedSchema.strict().parse({
        status: 'queued',
        command_id: 'cmd_1',
        session_id: null,
        reason: null,
      }),
    ).not.toThrow();
  });

  test('experimental keys stay in sync with the map schema', () => {
    expect(EXPERIMENTAL_FEATURE_KEYS).toEqual([
      'apps',
      'agent_tunnel',
      'marketplace',
      'agentmail_email',
      'meet',
      'llm_gateway',
      'review_center',
    ]);
  });

  test('sharing intent normalizes readonly member lists', () => {
    const parsed = SharingIntentSchema.parse({ mode: 'members', memberIds: ['u1'] });
    expect(parsed).toEqual({ mode: 'members', memberIds: ['u1'] });
  });
});

describe('SessionCreateInputSchema runtime_context', () => {
  test('accepts a bounded scalar map and the complete public create shape', () => {
    const parsed = SessionCreateInputSchema.parse({
      session_id: '11111111-1111-4111-a111-111111111111',
      agent_name: 'veyris',
      provider: 'daytona',
      branch_already_created: true,
      runtime_context: {
        workspace_id: 'org_123',
        'wrapper.locale': 'de',
        licensed: true,
        risk_score: 0.25,
        optional: null,
      },
    });
    expect(parsed.runtime_context?.workspace_id).toBe('org_123');
  });

  test('rejects nested values, arrays and non-finite numbers', () => {
    for (const value of [
      { nested: { nope: true } },
      { list: ['nope'] },
      { score: Number.POSITIVE_INFINITY },
    ]) {
      expect(SessionRuntimeContextSchema.safeParse(value).success).toBe(false);
    }
  });

  test('makes reserved environment names impossible as context keys', () => {
    for (const key of ['PATH', 'NODE_OPTIONS', 'KORTIX_TOKEN', 'OPENCODE_CONFIG_CONTENT']) {
      expect(SessionRuntimeContextSchema.safeParse({ [key]: 'shadow' }).success).toBe(false);
    }
  });

  test('rejects credential-like keys from the non-secret context envelope', () => {
    for (const key of [
      'access_token',
      'wrapper.secret',
      'api_key',
      'db-password',
      'authorization',
      'session.cookie',
    ]) {
      expect(SessionRuntimeContextSchema.safeParse({ [key]: 'must-not-land-here' }).success).toBe(
        false,
      );
    }
  });

  test('enforces key-count and UTF-8 byte bounds', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key_${index}`, index]),
    );
    expect(SessionRuntimeContextSchema.safeParse(tooMany).success).toBe(false);
    expect(SessionRuntimeContextSchema.safeParse({ payload: 'é'.repeat(9_000) }).success).toBe(
      false,
    );
  });

  test('rejects unknown create fields instead of accepting raw env or MCP config', () => {
    expect(
      SessionCreateInputSchema.safeParse({ runtime_env: { VEYRIS_TOKEN: 'secret' } }).success,
    ).toBe(false);
    expect(
      SessionCreateInputSchema.safeParse({ mcp: { url: 'https://attacker.test' } }).success,
    ).toBe(false);
  });

  test('retains deprecated camelCase inputs already accepted by the route', () => {
    expect(
      SessionCreateInputSchema.safeParse({
      baseRef: 'main',
      agentName: 'veyris',
      sandboxSlug: 'default',
      initialPrompt: 'hello',
      opencodeModel: 'kortix/auto',
      sessionId: '11111111-1111-4111-a111-111111111111',
      branchAlreadyCreated: true,
      }).success,
    ).toBe(true);
  });
});

describe('session connector profile contracts', () => {
  const profileId = '11111111-1111-4111-a111-111111111111';

  test('accepts typed connector bindings and rejects escape hatches', () => {
    expect(
      SessionCreateInputSchema.safeParse({
        connector_bindings: { veyris: { profile_id: profileId } },
      }).success,
    ).toBe(true);
    expect(
      SessionConnectorBindingsSchema.safeParse({
        veyris: { profile_id: profileId, credential: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      SessionConnectorBindingsSchema.safeParse({
        VEYRIS: { profile_id: profileId },
      }).success,
    ).toBe(false);
  });

  test('bounds binding count and non-secret profile metadata', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`connector_${index}`, { profile_id: profileId }]),
    );
    expect(SessionConnectorBindingsSchema.safeParse(tooMany).success).toBe(false);
    expect(ConnectionProfileMetadataSchema.safeParse({ access_token: 'nope' }).success).toBe(false);
    expect(ConnectionProfileMetadataSchema.safeParse({ payload: 'é'.repeat(9_000) }).success).toBe(
      false,
    );
  });

  test('profile reconcile and credential mutation reject unknown or oversized input', () => {
    const valid = {
      connector_alias: 'veyris',
      owner_type: 'external' as const,
      owner_id: 'thread-123',
      label: 'VEYRIS thread',
      metadata: { workspace_id: 'workspace-1' },
    };
    expect(ReconcileConnectionProfileInputSchema.safeParse(valid).success).toBe(true);
    expect(
      ReconcileConnectionProfileInputSchema.safeParse({ ...valid, credential: 'secret' }).success,
    ).toBe(false);
    expect(
      UpdateConnectionProfileCredentialInputSchema.safeParse({ value: 'x'.repeat(65537) }).success,
    ).toBe(false);
  });
});
