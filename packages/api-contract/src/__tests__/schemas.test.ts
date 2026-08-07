import { describe, expect, test } from 'bun:test';
import {
  ConnectorAuthorizationStrategySchema,
  ConnectionSchema,
  ConnectionMetadataSchema,
  EXPERIMENTAL_FEATURE_KEYS,
  ErrorEnvelopeSchema,
  OkResponseSchema,
  OAuth2ApplicationInputSchema,
  OAuth2AuthorizationStartInputSchema,
  OAuth2DeviceAuthorizationStartInputSchema,
  ProjectSchema,
  ProjectSessionSandboxSchema,
  ProjectSessionSchema,
  SecretBrokerRequestSchema,
  SecretBrokerResponseSchema,
  ReconcileConnectionInputSchema,
  SecretSchema,
  SecretDeliveryStrategySchema,
  SecretConsumerSchema,
  UpdateSecretStrategyInputSchema,
  ConnectorConnectionRequiredErrorSchema,
  RequiredConnectorConnectionSchema,
  SessionConnectorBindingInputSchema,
  SessionConnectorBindingSchema,
  SessionConnectorBindingsInputSchema,
  SessionConnectorBindingsSchema,
  SessionCreateAcceptedSchema,
  SessionCreateInputSchema,
  SessionScopeInputSchema,
  SessionScopeSchema,
  SessionRuntimeContextSchema,
  SessionStartResultSchema,
  SharingIntentSchema,
  TriggerListSchema,
  TriggerSchema,
  UpdateConnectionCredentialInputSchema,
  WarmProjectSessionResultSchema,
  ClaimWarmProjectSessionInputSchema,
} from '../index';

const NOW = '2026-07-01T12:00:00.000Z';

describe('connector authorization strategy', () => {
  test('accepts exactly project or user', () => {
    expect(ConnectorAuthorizationStrategySchema.parse('project')).toBe('project');
    expect(ConnectorAuthorizationStrategySchema.parse('user')).toBe('user');
    expect(ConnectorAuthorizationStrategySchema.safeParse('both').success).toBe(false);
    expect(ConnectorAuthorizationStrategySchema.safeParse('').success).toBe(false);
    expect(ConnectorAuthorizationStrategySchema.safeParse(undefined).success).toBe(false);
  });
});

describe('connection terminology', () => {
  test('canonical connection schemas expose the connection wire shape', () => {
    expect(
      ConnectionSchema.parse({
        connection_id: '11111111-2222-4333-8444-555555555555',
        connector_alias: 'gmail',
        owner_type: 'project',
        owner_id: null,
        label: 'Project Gmail',
        status: 'active',
        is_default: true,
        metadata: {},
      }),
    ).toMatchObject({ connector_alias: 'gmail', status: 'active' });
    expect(
      ReconcileConnectionInputSchema.parse({
        connector_alias: 'gmail',
        owner_type: 'project',
        label: 'Project Gmail',
      }),
    ).toMatchObject({ connector_alias: 'gmail', owner_type: 'project' });
    expect(
      UpdateConnectionCredentialInputSchema.parse({ value: 'secret-value' }),
    ).toEqual({ value: 'secret-value' });
  });

  test('secret consumers accept connector and reject removed product nouns', () => {
    expect(SecretConsumerSchema.parse('connector')).toBe('connector');
    expect(SecretConsumerSchema.safeParse('executor').success).toBe(false);
  });
});

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
    icon: '🚀',
    icon_glyph: null,
    last_opened_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    project_role: 'manager',
    effective_project_role: 'manager',
    dashboard_url: 'https://kortix.com/projects/11111111-2222-4333-8444-555555555555',
    experimental: {
      agent_tunnel: false,
      marketplace: false,
      connectors_api_discover: false,
      agentmail_email: false,
      teams: false,
      voice: false,
      llm_gateway: true,
      review_center: false,
      meta_agent: false,
      apps: false,
    },
    experimental_features: [],
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
    origin: 'user',
    secrets_allowlist: null,
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
    session_id: null,
    session_key: null,
    filter: null,
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
    strategy: 'runtime',
    consumer: 'sandbox',
    delivery_status: 'available',
    egress_policy: null,
    strategy_locked: false,
    last_rotated_at: null,
    requires_rotation: false,
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

  test('accepts E2B and rejects retired sandbox providers in project pin fields', () => {
    expect(() =>
      ProjectSchema.parse(
        projectFixture({
          default_sandbox_provider: 'e2b',
          available_sandbox_providers: ['daytona', 'platinum', 'e2b'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      ProjectSchema.parse(
        projectFixture({
          default_sandbox_provider: 'managed',
        }),
      ),
    ).toThrow();
    const retiredProviders = [
      ['local', 'docker'].join('_'),
      ['local', 'docker'].join('-'),
    ];
    for (const retiredProvider of retiredProviders) {
      expect(() =>
        ProjectSchema.parse(
          projectFixture({
            default_sandbox_provider: retiredProvider,
            available_sandbox_providers: [retiredProvider],
          }),
        ),
      ).toThrow();
    }
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

  test('accepts a null icon', () => {
    const parsed = ProjectSchema.parse(projectFixture({ icon: null }));
    expect(parsed.icon).toBeNull();
  });

  test('rejects a project with no icon field (icon is always emitted, never omitted)', () => {
    const { icon: _dropped, ...withoutIcon } = projectFixture();
    expect(() => ProjectSchema.strict().parse(withoutIcon)).toThrow();
  });
});

describe('ProjectSchema.icon_glyph', () => {
  test('accepts a glyph object and null, rejects undefined', () => {
    const base = projectFixture();
    expect(
      ProjectSchema.safeParse({ ...base, icon_glyph: { name: 'Rocket', color: 'blue' } }).success,
    ).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, icon_glyph: null }).success).toBe(true);
    // nullable, NOT optional — a missing key is a contract violation.
    const { icon_glyph: _omitted, ...withoutKey } = { ...base, icon_glyph: null };
    expect(ProjectSchema.safeParse(withoutKey).success).toBe(false);
  });

  test('rejects a bare string', () => {
    const base = projectFixture();
    expect(ProjectSchema.safeParse({ ...base, icon_glyph: 'Rocket' }).success).toBe(false);
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

describe('warm project session schemas', () => {
  test('accepts the ensure response with workspace refresh state', () => {
    expect(
      WarmProjectSessionResultSchema.parse({
        session: sessionFixture(),
        reused: true,
        workspace_refresh: {
          status: 'updated',
          before_sha: 'abc123',
          after_sha: 'def456',
        },
      }),
    ).toMatchObject({
      reused: true,
      workspace_refresh: { status: 'updated' },
    });
  });

  test('requires an RFC 4122 v4 session_id for claims', () => {
    expect(
      ClaimWarmProjectSessionInputSchema.safeParse({
        session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        agent_name: 'default',
        sandbox_slug: 'default',
      }).success,
    ).toBe(true);
    expect(ClaimWarmProjectSessionInputSchema.safeParse({ session_id: 'not-a-uuid' }).success).toBe(
      false,
    );
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

  test('accepts a typed provider-neutral terminal capacity failure', () => {
    const parsed = SessionStartResultSchema.strict().parse({
      stage: 'failed',
      agent_name: 'default',
      retriable: false,
      sandbox: sandboxFixture({ status: 'error' }),
      opencode_session_id: null,
      failure: {
        category: 'provider-capacity',
        message: 'The sandbox provider is at capacity right now. Try again in a minute.',
        retryable: true,
      },
    });
    expect(parsed.failure?.category).toBe('provider-capacity');
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

describe('pending session prompt contract', () => {
  test('accepts a durable prompt draft on normal create and warm claim', () => {
    const pendingPrompt = {
      text: 'Map the flood risk for this parcel.',
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'auto' },
      variant: null,
      attachment_names: ['parcel.geojson'],
    };

    expect(
      SessionCreateInputSchema.strict().parse({ pending_prompt: pendingPrompt }).pending_prompt,
    ).toEqual(pendingPrompt);
    expect(
      ClaimWarmProjectSessionInputSchema.strict().parse({
        session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        pending_prompt: pendingPrompt,
      }).pending_prompt,
    ).toEqual(pendingPrompt);
  });

  test('accepts a file-only draft with an empty text field', () => {
    const pendingPrompt = {
      text: '',
      attachment_names: ['parcel.geojson'],
    };

    expect(
      SessionCreateInputSchema.strict().parse({ pending_prompt: pendingPrompt }).pending_prompt,
    ).toEqual(pendingPrompt);

    expect(() =>
      SessionCreateInputSchema.strict().parse({ pending_prompt: { text: '' } }),
    ).toThrow();
  });
});

describe('ProjectSessionSandboxSchema', () => {
  test('accepts every provider the platform can emit', () => {
    for (const provider of ['daytona', 'platinum', 'e2b']) {
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

  test('accepts every delivery strategy and rejects unknown values', () => {
    for (const strategy of ['runtime', 'egress', 'broker', 'denied'] as const) {
      expect(SecretDeliveryStrategySchema.parse(strategy)).toBe(strategy);
    }
    expect(SecretDeliveryStrategySchema.safeParse('env').success).toBe(false);
  });

  test('accepts a broker policy and handle prefix in the update input', () => {
    expect(UpdateSecretStrategyInputSchema.parse({ strategy: 'denied' })).toEqual({
      strategy: 'denied',
    });
    expect(
      UpdateSecretStrategyInputSchema.parse({
        strategy: 'broker',
        consumer: 'http_broker',
        egress_policy: {
          backend: 'kortix_fetch',
          rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
          inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
        },
        handle_prefix: 'example_',
      }),
    ).toEqual({
      strategy: 'broker',
      consumer: 'http_broker',
      egress_policy: {
        backend: 'kortix_fetch',
        rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
        inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
      },
      handle_prefix: 'example_',
    });
    expect(
      UpdateSecretStrategyInputSchema.safeParse({ strategy: 'runtime', value: 'secret' }).success,
    ).toBe(false);
    expect(
      UpdateSecretStrategyInputSchema.parse({ strategy: 'broker', consumer: 'llm_gateway' }),
    ).toEqual({ strategy: 'broker', consumer: 'llm_gateway' });
  });

  test('validates the generic HTTPS broker request and response envelopes', () => {
    expect(
      SecretBrokerRequestSchema.parse({
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body_base64: 'e30=',
      }),
    ).toEqual({
      url: 'https://api.example.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body_base64: 'e30=',
    });
    expect(SecretBrokerRequestSchema.parse({ url: 'https://api.example.com' }).method).toBe('GET');
    expect(
      SecretBrokerRequestSchema.safeParse({
        url: 'https://api.example.com',
        headers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-${index}`, 'x'])),
      }).success,
    ).toBe(false);
    expect(
      SecretBrokerResponseSchema.parse({ status: 200, headers: {}, body_base64: 'b2s=' }),
    ).toEqual({ status: 200, headers: {}, body_base64: 'b2s=' });
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
      'agent_tunnel',
      'marketplace',
      'connectors_api_discover',
      'agentmail_email',
      'teams',
      'voice',
      'llm_gateway',
      'review_center',
      'meta_agent',
      'apps',
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
      initial_prompt: 'Do the task.\n\n--- session contract ---\n…',
      title_source: 'Do the task.',
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
        opencodeModel: 'kortix/glm-5.2',
        sessionId: '11111111-1111-4111-a111-111111111111',
        branchAlreadyCreated: true,
      }).success,
    ).toBe(true);
  });
});

describe('session connection contracts', () => {
  const connectionId = '11111111-1111-4111-a111-111111111111';

  test('accepts only canonical connection binding input', () => {
    expect(SessionConnectorBindingInputSchema.parse({ connection_id: connectionId })).toEqual({
      connection_id: connectionId,
    });
  });

  test('rejects missing, conflicting, and unknown binding input', () => {
    expect(SessionConnectorBindingInputSchema.safeParse({}).success).toBe(false);
    expect(
      SessionConnectorBindingInputSchema.safeParse({
        authorization_id: connectionId,
      }).success,
    ).toBe(false);
    expect(
      SessionConnectorBindingInputSchema.safeParse({
        connection_id: connectionId,
        credential: 'secret',
      }).success,
    ).toBe(false);
  });

  test('emits only canonical connector binding output', () => {
    expect(SessionConnectorBindingSchema.parse({ connection_id: connectionId })).toEqual({
      connection_id: connectionId,
    });
    expect(SessionConnectorBindingSchema.safeParse({ authorization_id: connectionId }).success).toBe(false);
    expect(
      SessionConnectorBindingsSchema.safeParse({
        veyris: { authorization_id: connectionId, connection_id: connectionId },
      }).success,
    ).toBe(false);
  });

  test('normalizes connector binding maps before session creation', () => {
    expect(
      SessionCreateInputSchema.parse({
        connector_bindings: { veyris: { connection_id: connectionId } },
      }).connector_bindings,
    ).toEqual({ veyris: { connection_id: connectionId } });
    expect(
      SessionConnectorBindingsInputSchema.safeParse({
        veyris: { connection_id: connectionId, credential: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      SessionConnectorBindingsInputSchema.safeParse({
        VEYRIS: { connection_id: connectionId },
      }).success,
    ).toBe(false);
  });

  test('bounds binding count and non-secret connection metadata', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`connector_${index}`, { connection_id: connectionId }]),
    );
    expect(SessionConnectorBindingsInputSchema.safeParse(tooMany).success).toBe(false);
    expect(ConnectionMetadataSchema.safeParse({ access_token: 'nope' }).success).toBe(false);
    expect(ConnectionMetadataSchema.safeParse({ payload: 'é'.repeat(9_000) }).success).toBe(
      false,
    );
  });

  test('connection reconcile and credential mutation reject unknown or oversized input', () => {
    const valid = {
      connector_alias: 'veyris',
      owner_type: 'external' as const,
      owner_id: 'thread-123',
      label: 'VEYRIS thread',
      metadata: { workspace_id: 'workspace-1' },
    };
    expect(ReconcileConnectionInputSchema.safeParse(valid).success).toBe(true);
    expect(
      ReconcileConnectionInputSchema.safeParse({ ...valid, credential: 'secret' }).success,
    ).toBe(false);
    expect(
      UpdateConnectionCredentialInputSchema.safeParse({ value: 'x'.repeat(65537) }).success,
    ).toBe(false);
    expect(
      UpdateConnectionCredentialInputSchema.safeParse({
        oauth2: {
          type: 'oauth2_client_credentials',
          token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
          client_id: 'client-id',
          token_endpoint_auth_method: 'client_secret_post',
          client_secret: 'client-secret',
          scopes: ['https://graph.microsoft.com/.default'],
        },
      }).success,
    ).toBe(true);
    expect(
      UpdateConnectionCredentialInputSchema.safeParse({
        oauth2: {
          type: 'oauth2_client_credentials',
          token_url: 'http://localhost/token',
          client_id: 'client-id',
          token_endpoint_auth_method: 'client_secret_post',
          client_secret: 'client-secret',
        },
      }).success,
    ).toBe(false);
  });
});

describe('session scope contracts', () => {
  const connectionId = '11111111-1111-4111-a111-111111111111';

  test('accepts canonical binding input and rejects an empty replacement', () => {
    expect(
      SessionScopeInputSchema.parse({
        connector_bindings: { gmail: { connection_id: connectionId } },
      }),
    ).toEqual({
      connector_bindings: { gmail: { connection_id: connectionId } },
    });
    expect(SessionScopeInputSchema.safeParse({}).success).toBe(false);
    expect(SessionScopeInputSchema.safeParse({ secret_values: [] }).success).toBe(false);
  });

  test('emits only connection_id in authoritative scope output', () => {
    const value = {
      secrets_allowlist: ['GMAIL_TOKEN'],
      // The alias a session REQUIRES, whether or not anything is connected —
      // the one axis a binding cannot express, since a binding carries an id.
      required_connectors: ['gmail'],
      connector_bindings: { gmail: { connection_id: connectionId } },
      dropped_secrets: [],
      added_secrets: ['GMAIL_TOKEN'],
      dropped_bindings: [],
      retroactive: true,
      detail: 'Applies from the next prompt.',
    };
    expect(SessionScopeSchema.parse(value)).toEqual(value);
    expect(
      SessionScopeSchema.safeParse({
        ...value,
        connector_bindings: { gmail: { authorization_id: connectionId } },
      }).success,
    ).toBe(false);
  });

  test('reports applied_live when the scope was pushed to the running sandbox', () => {
    // Mirrors the model route's applied_live: the caller can tell "in effect
    // now" from "stored, applies at next boot". The field is optional so a
    // response that omits it (e.g. a secrets-untouched re-scope) still parses.
    const value = {
      secrets_allowlist: null,
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: ['STRIPE_KEY'],
      dropped_bindings: [],
      retroactive: true,
      applied_live: true,
      detail: 'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.',
    };
    expect(SessionScopeSchema.parse(value)).toEqual(value);
  });

  test('reports push_failed when a required live push failed (half-applied change)', () => {
    // The row is written but the running harness still answers from the OLD
    // scope. `applied_live: false` alone cannot express this (it is also the
    // benign no-active-sandbox answer), so a client must read push_failed to
    // tell a half-applied change from a stored one. Mirrors the model route's
    // push_failed.
    const value = {
      secrets_allowlist: null,
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: ['STRIPE_KEY'],
      dropped_bindings: [],
      retroactive: true,
      applied_live: false,
      push_failed: true as const,
      push_reason: 'daemon unreachable',
      detail: 'Applies from the next prompt.',
    };
    expect(SessionScopeSchema.parse(value)).toEqual(value);
  });

  test('rejects an unknown extra field even with the new optional ones', () => {
    // .strict() is preserved: adding a field the schema does not name fails,
    // so the contract stays exhaustive.
    const value = {
      secrets_allowlist: null,
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
      applied_live: false,
      detail: 'No change to the secrets scope.',
      surprise: true,
    };
    expect(SessionScopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('required connection contracts', () => {
  const connection = {
    id: '11111111-1111-4111-a111-111111111111',
    slug: 'gmail-read',
    name: 'Gmail read only',
    authorization_strategy: 'user' as const,
  };

  test('accepts the public missing-connection shape', () => {
    expect(RequiredConnectorConnectionSchema.parse(connection)).toEqual(connection);
  });

  test('accepts the structured session-create conflict and rejects extra fields', () => {
    const value = {
      code: 'CONNECTOR_CONNECTION_REQUIRED' as const,
      message: 'Create the required connections before starting this session.',
      connector_connections: [connection],
    };
    expect(ConnectorConnectionRequiredErrorSchema.parse(value)).toEqual(value);
    expect(
      ConnectorConnectionRequiredErrorSchema.safeParse({
        ...value,
        connector_connections: [{ ...connection, authorization_id: connection.id }],
      }).success,
    ).toBe(false);
  });
});

describe('native OAuth2 lifecycle schemas', () => {
  test('accepts a provider-independent Authorization Code application with PKCE', () => {
    expect(
      OAuth2ApplicationInputSchema.parse({
        authorization_url: 'https://identity.example.com/oauth2/authorize',
        token_url: 'https://identity.example.com/oauth2/token',
        revocation_url: 'https://identity.example.com/oauth2/revoke',
        client_id: 'client-123',
        token_endpoint_auth_method: 'client_secret_basic',
        client_secret: 'secret-123',
        scopes: ['files.read', 'files.write'],
      }),
    ).toMatchObject({ client_id: 'client-123' });
  });

  test('accepts public clients and rejects non-HTTPS provider endpoints', () => {
    expect(
      OAuth2ApplicationInputSchema.safeParse({
        authorization_url: 'https://identity.example.com/authorize',
        token_url: 'https://identity.example.com/token',
        client_id: 'public-client',
        token_endpoint_auth_method: 'none',
      }).success,
    ).toBe(true);
    expect(
      OAuth2ApplicationInputSchema.safeParse({
        authorization_url: 'http://127.0.0.1/authorize',
        token_url: 'https://identity.example.com/token',
        client_id: 'public-client',
        token_endpoint_auth_method: 'none',
      }).success,
    ).toBe(false);
  });

  test('requires the selected client credential', () => {
    expect(
      OAuth2ApplicationInputSchema.safeParse({
        token_url: 'https://identity.example.com/token',
        client_id: 'confidential-client',
        token_endpoint_auth_method: 'client_secret_jwt',
      }).success,
    ).toBe(false);
    expect(
      OAuth2ApplicationInputSchema.safeParse({
        token_url: 'https://identity.example.com/token',
        client_id: 'confidential-client',
        token_endpoint_auth_method: 'private_key_jwt',
        private_key: 'private-key',
      }).success,
    ).toBe(true);
  });

  test('validates authorization and device start inputs', () => {
    expect(
      OAuth2AuthorizationStartInputSchema.parse({
        success_redirect_uri: 'https://dev.kortix.com/projects/p1',
      }),
    ).toEqual({ success_redirect_uri: 'https://dev.kortix.com/projects/p1' });
    expect(
      OAuth2AuthorizationStartInputSchema.safeParse({
        success_redirect_uri: 'http://localhost:15300/projects/p1',
      }).success,
    ).toBe(true);
    expect(
      OAuth2AuthorizationStartInputSchema.safeParse({
        success_redirect_uri: 'http://example.com/projects/p1',
      }).success,
    ).toBe(false);
    expect(OAuth2DeviceAuthorizationStartInputSchema.parse({ scopes: ['read'] })).toEqual({
      scopes: ['read'],
    });
  });
});

describe('removed usage-attribution fields', () => {
  test('rejects usage-attribution fields in session-create input', () => {
    expect(SessionCreateInputSchema.safeParse({ end_user_ref: 'customer-1' }).success).toBe(false);
    expect(SessionCreateInputSchema.safeParse({ origin_ref: 'customer-1' }).success).toBe(false);
  });

  test('rejects usage-attribution fields in serialized sessions', () => {
    expect(ProjectSessionSchema.strict().safeParse(sessionFixture()).success).toBe(true);
    expect(
      ProjectSessionSchema.strict().safeParse(sessionFixture({ end_user_ref: 'customer-1' }))
        .success,
    ).toBe(false);
    expect(
      ProjectSessionSchema.strict().safeParse(sessionFixture({ origin_ref: 'customer-1' })).success,
    ).toBe(false);
  });
});

describe('SessionCreateInputSchema backend secret bounds', () => {
  test('secrets: accepts an identifier list and [] (narrow to zero), rejects an over-long list', () => {
    expect(
      SessionCreateInputSchema.safeParse({ secrets: ['GMAIL_TOKEN', 'STRIPE_KEY'] }).success,
    ).toBe(true);
    expect(SessionCreateInputSchema.safeParse({ secrets: [] }).success).toBe(true);
    expect(
      SessionCreateInputSchema.safeParse({
        secrets: Array.from({ length: 129 }, (_, i) => `S${i}`),
      }).success,
    ).toBe(false);
  });
});
