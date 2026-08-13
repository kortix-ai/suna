import { describe, expect, test } from 'bun:test';

import {
  brokerConsumerForSecret,
  buildBrokerPolicy,
  buildNetworkBoundaryPolicy,
  canSaveSecretDelivery,
  connectorBindingChanges,
  connectorBindingOptions,
  missingAgentGrantNotice,
  networkBoundaryAvailability,
  networkBoundaryBlockedReason,
  networkBoundaryEchoNotice,
  parseBoundaryHosts,
  readSecretDeliverySync,
  secretDeliveryBlockedReason,
  secretDeliveryOptions,
  secretDeliveryPresentation,
  secretDeliverySyncWarning,
  shouldWarnMissingAgentGrant,
} from './secret-delivery';

describe('brokerConsumerForSecret', () => {
  test('keeps canonical consumers unchanged', () => {
    expect(brokerConsumerForSecret('llm_gateway')).toBe('llm_gateway');
    expect(brokerConsumerForSecret('connector')).toBe('connector');
    expect(brokerConsumerForSecret('http_broker')).toBe('http_broker');
  });

  test('defaults unsupported consumers to the HTTPS broker', () => {
    expect(brokerConsumerForSecret(null)).toBe('http_broker');
    expect(brokerConsumerForSecret('sandbox')).toBe('http_broker');
  });
});

describe('secretDeliveryPresentation', () => {
  test('states that runtime secrets are readable inside the sandbox', () => {
    expect(secretDeliveryPresentation('runtime')).toEqual({
      label: 'Sandbox',
      description: 'Available to agent code and commands as an environment variable.',
      tone: 'warning',
    });
  });

  test('states that denied secrets are stored but unavailable', () => {
    expect(secretDeliveryPresentation('denied')).toEqual({
      label: 'Disabled',
      description: 'Stored securely, but unavailable to sessions and Kortix services.',
      tone: 'outline',
    });
  });

  test('describes broker and egress without claiming sandbox access', () => {
    expect(secretDeliveryPresentation('broker').description).toBe(
      'Used by an approved Kortix service without entering the sandbox.',
    );
    expect(secretDeliveryPresentation('egress').description).toBe(
      'Added to approved outbound requests at the network boundary.',
    );
  });

  test('labels each supported server consumer explicitly', () => {
    expect(secretDeliveryPresentation('broker', 'llm_gateway')).toMatchObject({
      label: 'LLM gateway',
      description: 'Used for model requests without entering the sandbox.',
    });
    expect(secretDeliveryPresentation('broker', 'http_broker')).toMatchObject({
      label: 'HTTPS broker',
      description: 'Added only to an approved HTTPS request outside the sandbox.',
    });
    expect(secretDeliveryPresentation('broker', 'connector')).toMatchObject({
      label: 'Connector',
      description: 'Used by an authorized connector without entering the sandbox.',
    });
    expect(secretDeliveryPresentation('broker', 'git_proxy')).toMatchObject({
      label: 'Git service',
      description: 'Used for repository access without entering the sandbox.',
    });
  });
});

/** The two fix sentences, pinned once. They are user-facing copy, so the exact
 *  wording is the assertion — a helper that stopped naming the flag would still
 *  return a non-empty string. */
const SHIM_FIX = 'Turn on "Network boundary without Platinum" in Feature flags → Experimental.';
const PIN_FIX =
  'This project does not run on Platinum — pin it in Feature flags → Runtime → Sandbox provider, or turn on "Network boundary without Platinum" in Feature flags → Experimental.';

describe('networkBoundaryAvailability', () => {
  test('requires the project itself to run on Platinum', () => {
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'platinum',
      }),
    ).toBe('available');
  });

  test('reports a platform-capable but unpinned project separately', () => {
    // The live dev state: Platinum is offered, the project runs on Daytona, so
    // no header is injected.
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: null,
      }),
    ).toBe('project_not_pinned');
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'daytona',
      }),
    ).toBe('project_not_pinned');
  });

  test('reports a deployment without Platinum as unsupported', () => {
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona'],
        default_sandbox_provider: 'daytona',
      }),
    ).toBe('unsupported');
    expect(networkBoundaryAvailability(undefined)).toBe('unsupported');
    expect(networkBoundaryAvailability(null)).toBe('unsupported');
  });

  test('the shim flag makes it available on a project with no Platinum at all', () => {
    // The second mechanism does not run at a provider edge, so the provider the
    // project is pinned to stops mattering.
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona'],
        default_sandbox_provider: 'daytona',
        experimental: { network_boundary_shim: true },
      }),
    ).toBe('available');
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'daytona',
        experimental: { network_boundary_shim: true },
      }),
    ).toBe('available');
  });

  test('an off or absent flag leaves the provider verdict untouched', () => {
    // The flag is opt-in only: it can grant availability, never remove it.
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona'],
        default_sandbox_provider: 'daytona',
        experimental: { network_boundary_shim: false },
      }),
    ).toBe('unsupported');
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'platinum',
        experimental: { network_boundary_shim: false },
      }),
    ).toBe('available');
  });
});

describe('networkBoundaryBlockedReason', () => {
  test('names both fixes for an unpinned project', () => {
    expect(networkBoundaryBlockedReason('project_not_pinned')).toBe(PIN_FIX);
  });

  test('a deployment without Platinum is now fixable, so it says how', () => {
    // It used to read "Not available in this deployment.", which is no longer
    // true — the shim needs no Platinum, so the state is an opt-in away.
    expect(networkBoundaryBlockedReason('unsupported')).toBe(SHIM_FIX);
    expect(networkBoundaryBlockedReason('unsupported')).not.toContain('Not available');
    expect(networkBoundaryBlockedReason('available')).toBeNull();
  });
});

describe('secretDeliveryOptions', () => {
  test('offers the HTTPS broker and enables network delivery when the project runs on Platinum', () => {
    const options = secretDeliveryOptions('runtime', 'available', 'available');
    expect(options.map(({ strategy, disabled }) => ({ strategy, disabled }))).toEqual([
      { strategy: 'runtime', disabled: false },
      { strategy: 'broker', disabled: false },
      { strategy: 'egress', disabled: false },
      { strategy: 'denied', disabled: false },
    ]);
    expect(options[2]?.disabledReason).toBeNull();
  });

  test('keeps network delivery disabled when Platinum is unavailable', () => {
    expect(secretDeliveryOptions('broker', 'available', 'unsupported')[1]?.disabled).toBe(false);
    expect(secretDeliveryOptions('egress', 'available', 'unsupported')[2]).toMatchObject({
      disabled: true,
      disabledReason: SHIM_FIX,
    });
  });

  test('disables network delivery on an unpinned project and states the fix', () => {
    expect(secretDeliveryOptions('runtime', 'available', 'project_not_pinned')[2]).toMatchObject({
      disabled: true,
      disabledReason: PIN_FIX,
    });
  });

  test('disables a selected non-runtime policy when the server marks it unavailable', () => {
    expect(secretDeliveryOptions('broker', 'unavailable', 'available')[1]).toMatchObject({
      disabled: true,
      disabledReason: 'Not available in this deployment.',
    });
  });
});

describe('secretDeliveryBlockedReason', () => {
  test('reports the blocked verdict only on the exact reason', () => {
    expect(
      secretDeliveryBlockedReason({
        identifier: 'BOUNDARY_TEST',
        delivery_blocked_reason: 'no_agent_grant',
      }),
    ).toBe('no_agent_grant');
  });

  test('stays silent on null, absent, and unrecognized values', () => {
    // Tri-state: null covers "granted", "not applicable" AND "we could not
    // tell" — warning on uncertainty is worse than not warning.
    expect(
      secretDeliveryBlockedReason({ identifier: 'BOUNDARY_TEST', delivery_blocked_reason: null }),
    ).toBeNull();
    expect(secretDeliveryBlockedReason({ identifier: 'BOUNDARY_TEST' })).toBeNull();
    expect(
      secretDeliveryBlockedReason({
        identifier: 'BOUNDARY_TEST',
        delivery_blocked_reason: 'manifest_unreadable',
      }),
    ).toBeNull();
  });
});

describe('shouldWarnMissingAgentGrant', () => {
  test('warns for the delivery modes that need a named agent grant', () => {
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'egress')).toBe(true);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'broker')).toBe(true);
  });

  test('stays silent for runtime, disabled, and an unblocked secret', () => {
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'runtime')).toBe(false);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'denied')).toBe(false);
    expect(shouldWarnMissingAgentGrant(null, 'egress')).toBe(false);
  });
});

describe('missingAgentGrantNotice', () => {
  test('names the identifier, the manifest fix, and rejects the "all" shorthand', () => {
    const notice = missingAgentGrantNotice('BOUNDARY_TEST');
    expect(notice.title).toBe('No agent can receive this secret');
    expect(notice.body).toContain('BOUNDARY_TEST');
    expect(notice.body).toContain('kortix.yaml');
    expect(notice.body).toContain('"secrets: all" does not grant this delivery mode');
    expect(notice.manifest).toBe(
      'kortix_version: 2\nagents:\n  my-agent:\n    secrets: [BOUNDARY_TEST]',
    );
  });
});

describe('secret delivery sync', () => {
  const sync = (overrides: Record<string, unknown> = {}) => ({
    delivery_sync: {
      ok: false,
      targeted: 2,
      synced: 1,
      failed: 1,
      failures: [{ session_id: 'ses_1', sandbox_id: 'sbx_1', reason: 'sandbox unreachable: 502' }],
      ...overrides,
    },
  });

  test('reads the block a secret write returns', () => {
    expect(readSecretDeliverySync(sync())).toEqual({
      ok: false,
      targeted: 2,
      synced: 1,
      failed: 1,
      failures: [{ session_id: 'ses_1', sandbox_id: 'sbx_1', reason: 'sandbox unreachable: 502' }],
    });
  });

  test('reports nothing for an absent, null, or unrecognized block', () => {
    expect(readSecretDeliverySync({ identifier: 'BOUNDARY_TEST' })).toBeNull();
    expect(readSecretDeliverySync({ delivery_sync: null })).toBeNull();
    expect(readSecretDeliverySync({ delivery_sync: { targeted: 2 } })).toBeNull();
    expect(readSecretDeliverySync(null)).toBeNull();
  });

  test('warns with the session count and the first failure reason verbatim', () => {
    expect(secretDeliverySyncWarning('BOUNDARY_TEST', sync())).toEqual({
      message: 'Saved BOUNDARY_TEST, but it is not applied to 1 running session',
      description: 'sandbox unreachable: 502',
    });
    expect(
      secretDeliverySyncWarning(
        'BOUNDARY_TEST',
        sync({
          failed: 2,
          failures: [
            { session_id: 'ses_1', sandbox_id: null, reason: 'first reason' },
            { session_id: 'ses_2', sandbox_id: 'sbx_2', reason: 'second reason' },
          ],
        }),
      ),
    ).toEqual({
      message: 'Saved BOUNDARY_TEST, but it is not applied to 2 running sessions',
      description: 'first reason',
    });
  });

  test('falls back to the targeted count and a plain reason when the block is thin', () => {
    expect(secretDeliverySyncWarning('BOUNDARY_TEST', sync({ failed: 0, failures: [] }))).toEqual({
      message: 'Saved BOUNDARY_TEST, but it is not applied to 2 running sessions',
      description: 'No failure reason was reported.',
    });
    expect(
      secretDeliverySyncWarning('BOUNDARY_TEST', sync({ targeted: 0, failed: 0, failures: [] })),
    ).toEqual({
      message: 'Saved BOUNDARY_TEST, but it is not applied to the running sessions',
      description: 'No failure reason was reported.',
    });
  });

  test('stays silent on a successful sync and on a response without the block', () => {
    expect(secretDeliverySyncWarning('BOUNDARY_TEST', sync({ ok: true, failed: 0 }))).toBeNull();
    expect(secretDeliverySyncWarning('BOUNDARY_TEST', { delivery_sync: null })).toBeNull();
    expect(secretDeliverySyncWarning('BOUNDARY_TEST', { identifier: 'BOUNDARY_TEST' })).toBeNull();
  });
});

describe('canSaveSecretDelivery', () => {
  test('requires a replacement value before restoring sandbox access', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'LOCAL_TEST_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: true,
        currentStrategy: 'denied',
        nextStrategy: 'runtime',
        nextConsumer: 'sandbox',
        brokerPolicyValid: false,
      }),
    ).toBe(false);
  });

  test('allows sandbox access after a replacement value is entered', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'LOCAL_TEST_KEY',
        value: 'replacement',
        requiresValue: false,
        requiresRotation: true,
        currentStrategy: 'denied',
        nextStrategy: 'runtime',
        nextConsumer: 'sandbox',
        brokerPolicyValid: false,
      }),
    ).toBe(true);
  });

  test('requires a changed value or delivery strategy for an existing secret', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'LOCAL_TEST_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: false,
        currentStrategy: 'runtime',
        nextStrategy: 'runtime',
        nextConsumer: 'sandbox',
        brokerPolicyValid: false,
      }),
    ).toBe(false);
  });

  test('requires a complete broker policy', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'LOCAL_TEST_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: false,
        currentStrategy: 'runtime',
        nextStrategy: 'broker',
        nextConsumer: 'http_broker',
        brokerPolicyValid: false,
      }),
    ).toBe(false);
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'LOCAL_TEST_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: false,
        currentStrategy: 'runtime',
        nextStrategy: 'broker',
        nextConsumer: 'http_broker',
        brokerPolicyValid: true,
      }),
    ).toBe(true);
  });

  test('allows the LLM gateway consumer without an HTTP policy', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'OPENAI_API_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: false,
        currentStrategy: 'runtime',
        nextStrategy: 'broker',
        nextConsumer: 'llm_gateway',
        brokerPolicyValid: false,
      }),
    ).toBe(true);
  });

  test('requires at least one connector for connector delivery', () => {
    expect(
      canSaveSecretDelivery({
        isEdit: true,
        key: 'API_KEY',
        value: '',
        requiresValue: false,
        requiresRotation: false,
        currentStrategy: 'runtime',
        nextStrategy: 'broker',
        nextConsumer: 'connector',
        brokerPolicyValid: false,
        selectedConnectorCount: 0,
      }),
    ).toBe(false);
  });

  test('requires a valid network-boundary policy for egress delivery', () => {
    const input = {
      isEdit: true,
      key: 'API_KEY',
      value: '',
      requiresValue: false,
      requiresRotation: false,
      currentStrategy: 'runtime' as const,
      nextStrategy: 'egress' as const,
      nextConsumer: 'network' as const,
      brokerPolicyValid: false,
    };
    expect(canSaveSecretDelivery(input)).toBe(false);
    expect(canSaveSecretDelivery({ ...input, networkBoundaryPolicyValid: true })).toBe(true);
  });
});

describe('connector secret bindings', () => {
  const connectors = [
    {
      slug: 'available',
      name: 'Available API',
      provider: 'openapi' as const,
      status: 'needs_auth' as const,
      credentialMode: 'shared' as const,
      authorizationStrategy: 'project' as const,
      requestAuthType: 'bearer' as const,
      sensitive: false,
      actions: [],
      authSecret: 'credential',
      secretIdentifier: null,
      credentialSource: 'none' as const,
      secretSet: false,
    },
    {
      slug: 'stored',
      name: 'Stored API',
      provider: 'openapi' as const,
      status: 'active' as const,
      credentialMode: 'shared' as const,
      authorizationStrategy: 'project' as const,
      requestAuthType: 'bearer' as const,
      sensitive: false,
      actions: [],
      authSecret: 'credential',
      secretIdentifier: null,
      credentialSource: 'stored' as const,
      secretSet: true,
    },
    {
      slug: 'bound',
      name: 'Bound API',
      provider: 'http' as const,
      status: 'active' as const,
      credentialMode: 'shared' as const,
      authorizationStrategy: 'project' as const,
      requestAuthType: 'api_key' as const,
      sensitive: false,
      actions: [],
      authSecret: 'credential',
      secretIdentifier: 'API_KEY',
      credentialSource: 'project_secret' as const,
      secretSet: true,
    },
  ];

  test('marks stored credentials unavailable and preserves the current binding', () => {
    expect(
      connectorBindingOptions(connectors, 'API_KEY').map(({ slug, disabled, selected }) => ({
        slug,
        disabled,
        selected,
      })),
    ).toEqual([
      { slug: 'available', disabled: false, selected: false },
      { slug: 'stored', disabled: true, selected: false },
      { slug: 'bound', disabled: false, selected: true },
    ]);
  });

  test('computes only the changed connector bindings', () => {
    expect(connectorBindingChanges(connectors, 'API_KEY', ['available'])).toEqual({
      bind: ['available'],
      unbind: ['bound'],
    });
  });
});

describe('buildBrokerPolicy', () => {
  test('normalizes hosts and methods into strict broker rules', () => {
    expect(
      buildBrokerPolicy({
        hosts: ' api.example.com, *.example.com ',
        methods: 'post, GET',
        path: '/v1/*',
        injectionKind: 'header',
        injectionTarget: 'Authorization',
        template: 'Bearer {{secret}}',
      }),
    ).toEqual({
      backend: 'kortix_fetch',
      rules: [
        { host: 'api.example.com', methods: ['POST', 'GET'], path: '/v1/*' },
        { host: '*.example.com', methods: ['POST', 'GET'], path: '/v1/*' },
      ],
      inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('rejects missing hosts, invalid methods, and an empty injection target', () => {
    const base = {
      hosts: 'api.example.com',
      methods: 'POST',
      path: '/v1/*',
      injectionKind: 'header' as const,
      injectionTarget: 'authorization',
      template: '',
    };
    expect(buildBrokerPolicy({ ...base, hosts: '' })).toBeNull();
    expect(buildBrokerPolicy({ ...base, methods: 'TRACE' })).toBeNull();
    expect(buildBrokerPolicy({ ...base, injectionTarget: '' })).toBeNull();
  });
});

describe('buildNetworkBoundaryPolicy', () => {
  test('builds an exact-host header transform without a sandbox handle', () => {
    expect(
      buildNetworkBoundaryPolicy({
        hosts: 'api.anthropic.com\napi.openai.com',
        injectionTarget: 'Authorization',
        template: 'Bearer {{secret}}',
      }),
    ).toEqual({
      rules: [{ host: 'api.anthropic.com' }, { host: 'api.openai.com' }],
      inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('rejects wildcard hosts, URLs, invalid headers, and templates without the secret slot', () => {
    const base = {
      hosts: 'api.example.com',
      injectionTarget: 'x-api-key',
      template: '{{secret}}',
    };
    expect(buildNetworkBoundaryPolicy({ ...base, hosts: '*.example.com' })).toBeNull();
    expect(buildNetworkBoundaryPolicy({ ...base, hosts: 'https://api.example.com' })).toBeNull();
    expect(buildNetworkBoundaryPolicy({ ...base, injectionTarget: 'bad header' })).toBeNull();
    expect(buildNetworkBoundaryPolicy({ ...base, template: 'Bearer token' })).toBeNull();
  });
});

describe('parseBoundaryHosts', () => {
  test('lowercases, splits on commas and newlines, and drops duplicates', () => {
    expect(parseBoundaryHosts('API.Example.com, api.example.com\nuploads.example.com  ')).toEqual([
      'api.example.com',
      'uploads.example.com',
    ]);
  });

  test('reads an empty field as no hosts', () => {
    expect(parseBoundaryHosts('   \n , ')).toEqual([]);
  });
});

/**
 * The incident this text exists for: an agent probed an echo endpoint, read the
 * cut connection as a dead host, and invented a TLS explanation. Nothing in the
 * product said the boundary was there.
 */
describe('networkBoundaryEchoNotice', () => {
  test('names the symptom and denies the wrong conclusion', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com');
    expect(notice.body).toContain('curl: (52) Empty reply from server');
    expect(notice.body).toContain('the boundary working, not the host being down');
  });

  test('probes the first declared host with a credential-consuming request', () => {
    const notice = networkBoundaryEchoNotice('API.Stripe.com\nuploads.stripe.com');
    expect(notice.probe).toContain('https://api.stripe.com/');
    expect(notice.probe).toContain('never one that echoes headers');
    expect(notice.probe).toContain('200 = the header arrived. 401 = it did not.');
  });

  test('falls back to a placeholder host before anything is typed', () => {
    expect(networkBoundaryEchoNotice('').probe).toContain('https://api.example.com/');
  });

  test('points at the two-probe procedure in the docs', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com');
    expect(notice.docsHref).toBe('/docs/project/secrets#verify-it-with-two-probes');
    expect(notice.docsLabel).toBe('Verify it with two probes');
  });

  test('never suggests looking for the value in the sandbox', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com');
    const text = `${notice.title} ${notice.body} ${notice.probe}`;
    expect(text).not.toContain('env ');
    expect(text).not.toContain('{{secret}}');
    expect(text.toLowerCase()).not.toContain('authorization:');
  });
});
