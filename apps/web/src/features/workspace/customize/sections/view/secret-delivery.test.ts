import { describe, expect, test } from 'bun:test';

import {
  buildBrokerPolicy,
  buildNetworkBoundaryPolicy,
  canSaveSecretDelivery,
  connectorBindingChanges,
  connectorBindingOptions,
  defaultSecretAccess,
  missingAgentGrantNotice,
  networkBoundaryAvailability,
  networkBoundaryBlockedReason,
  networkBoundaryEchoNotice,
  networkBoundaryMode,
  parseBoundaryHosts,
  readSecretDeliverySync,
  secretAccessChoice,
  secretAccessIsSystemManaged,
  secretAccessTarget,
  secretDeliveryBlockedReason,
  secretDeliveryLegend,
  secretDeliveryOptionGroups,
  secretDeliveryOptions,
  secretDeliveryPresentation,
  secretDeliverySyncWarning,
  shouldWarnMissingAgentGrant,
} from './secret-delivery';

describe('secretAccessChoice / secretAccessTarget', () => {
  test('round-trips every choice through its stored strategy+consumer pair', () => {
    const choices = [
      'sandbox',
      'network_boundary',
      'http_broker',
      'llm_gateway',
      'connector',
      'disabled',
    ] as const;
    for (const choice of choices) {
      const target = secretAccessTarget(choice);
      expect(secretAccessChoice(target.strategy, target.consumer)).toBe(choice);
    }
  });

  test('a git_proxy row resolves to http_broker as a fallback, never to a real choice', () => {
    expect(secretAccessChoice('broker', 'git_proxy')).toBe('http_broker');
  });
});

describe('secretAccessIsSystemManaged', () => {
  test('is true only for a git-connection-assigned row', () => {
    expect(secretAccessIsSystemManaged('git_proxy')).toBe(true);
    expect(secretAccessIsSystemManaged('sandbox')).toBe(false);
    expect(secretAccessIsSystemManaged(null)).toBe(false);
    expect(secretAccessIsSystemManaged(undefined)).toBe(false);
  });
});

describe('defaultSecretAccess', () => {
  test('an existing row opens on the value it has, including one the picker does not offer', () => {
    expect(defaultSecretAccess({ strategy: 'broker', consumer: 'git_proxy' }, 'available')).toBe(
      'http_broker',
    );
    expect(defaultSecretAccess({ strategy: 'runtime', consumer: 'sandbox' }, 'unsupported')).toBe(
      'sandbox',
    );
  });

  test('a new secret defaults to Network boundary where the project can deliver it', () => {
    expect(defaultSecretAccess(null, 'available')).toBe('network_boundary');
  });

  test('a new secret defaults to Sandbox everywhere else', () => {
    expect(defaultSecretAccess(null, 'unsupported')).toBe('sandbox');
    expect(defaultSecretAccess(null, 'project_not_pinned')).toBe('sandbox');
    expect(defaultSecretAccess(undefined, 'unsupported')).toBe('sandbox');
  });
});

describe('secretDeliveryLegend', () => {
  test('lists exactly the five pickable values, in picker order', () => {
    expect(secretDeliveryLegend().map((entry) => entry.choice)).toEqual([
      'sandbox',
      'network_boundary',
      'http_broker',
      'llm_gateway',
      'connector',
      'disabled',
    ]);
  });

  test('the wording matches secretDeliveryPresentation exactly — one source of truth', () => {
    for (const entry of secretDeliveryLegend()) {
      const target = secretAccessTarget(entry.choice);
      expect(secretDeliveryPresentation(target.strategy, target.consumer)).toEqual({
        label: entry.label,
        description: entry.description,
        tone: entry.tone,
      });
    }
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
    // A 'broker' strategy with no recognized consumer falls back to the
    // HTTPS broker presentation — see secretAccessChoice's default case.
    expect(secretDeliveryPresentation('broker').description).toBe(
      'Added only to an approved HTTPS request outside the sandbox.',
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
 *  return a non-empty string. The flag name has to match the
 *  `network_boundary_shim` entry in the API's feature-flag registry, which is
 *  the label the Experimental screen renders. */
const SHIM_FIX = 'Turn on "Network boundary in-guest shim" in Feature flags → Experimental.';
const PIN_FIX =
  'Turn on "Network boundary in-guest shim" in Feature flags → Experimental, or pin this project to Platinum in Feature flags → Runtime → Sandbox provider.';

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
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'e2b', 'platinum'],
        default_sandbox_provider: 'e2b',
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
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona', 'e2b'],
        default_sandbox_provider: 'e2b',
      }),
    ).toBe('unsupported');
    expect(networkBoundaryAvailability(undefined)).toBe('unsupported');
    expect(networkBoundaryAvailability(null)).toBe('unsupported');
  });

  test('the shim flag makes it available on a project with no Platinum at all', () => {
    // The second mechanism does not run at a provider edge, so the provider the
    // project is pinned to stops mattering — the shim is guest-side code and is
    // the same code on every provider that runs it.
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['daytona'],
        default_sandbox_provider: 'daytona',
        experimental: { network_boundary_shim: true },
      }),
    ).toBe('available');
    expect(
      networkBoundaryAvailability({
        available_sandbox_providers: ['e2b'],
        default_sandbox_provider: 'e2b',
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

describe('networkBoundaryMode', () => {
  test('a project pinned to Platinum is served by the provider edge', () => {
    expect(
      networkBoundaryMode({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'platinum',
      }),
    ).toBe('provider-edge');
  });

  test('the edge wins over the flag when both would serve', () => {
    // Mirrors the API's precedence: the edge needs nothing in the guest and
    // injects for every client, so it is what the session actually gets.
    expect(
      networkBoundaryMode({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'platinum',
        experimental: { network_boundary_shim: true },
      }),
    ).toBe('provider-edge');
  });

  test('every non-Platinum provider is served by the same in-guest shim', () => {
    for (const provider of ['daytona', 'e2b']) {
      expect(
        networkBoundaryMode({
          available_sandbox_providers: [provider, 'platinum'],
          default_sandbox_provider: provider,
          experimental: { network_boundary_shim: true },
        }),
      ).toBe('in-guest-shim');
    }
  });

  test('reports no mechanism when neither half is in place', () => {
    expect(
      networkBoundaryMode({
        available_sandbox_providers: ['e2b'],
        default_sandbox_provider: 'e2b',
      }),
    ).toBeNull();
    // Platinum offered but not pinned is the state that used to read as
    // "available": nothing injects until a session actually runs there.
    expect(
      networkBoundaryMode({
        available_sandbox_providers: ['daytona', 'platinum'],
        default_sandbox_provider: 'daytona',
      }),
    ).toBeNull();
    expect(networkBoundaryMode(undefined)).toBeNull();
    expect(networkBoundaryMode(null)).toBeNull();
  });
});

describe('networkBoundaryBlockedReason', () => {
  test('leads with the flag on an unpinned project and keeps the pin as the alternative', () => {
    const reason = networkBoundaryBlockedReason('project_not_pinned') ?? '';
    expect(reason).toBe(PIN_FIX);
    // The order is the assertion. Turning the flag on fixes this project;
    // re-pinning moves every session in it onto another provider.
    expect(reason.indexOf('Experimental')).toBeLessThan(reason.indexOf('Sandbox provider'));
  });

  test('a deployment without Platinum is now fixable, so it says how', () => {
    // It used to read "Not available in this deployment.", which is no longer
    // true — the shim needs no Platinum, so the state is an opt-in away.
    expect(networkBoundaryBlockedReason('unsupported')).toBe(SHIM_FIX);
    expect(networkBoundaryBlockedReason('unsupported')).not.toContain('Not available');
    expect(networkBoundaryBlockedReason('available')).toBeNull();
  });

  test('names the flag by its mechanism, not by the provider it does without', () => {
    expect(networkBoundaryBlockedReason('unsupported')).toContain('in-guest shim');
    expect(networkBoundaryBlockedReason('project_not_pinned')).not.toContain('without Platinum');
  });
});

describe('secretDeliveryOptions', () => {
  test('offers all five values, network boundary enabled when the project runs on Platinum', () => {
    const options = secretDeliveryOptions('sandbox', 'available', 'available');
    expect(options.map(({ choice, disabled }) => ({ choice, disabled }))).toEqual([
      { choice: 'sandbox', disabled: false },
      { choice: 'network_boundary', disabled: false },
      { choice: 'http_broker', disabled: false },
      { choice: 'llm_gateway', disabled: false },
      { choice: 'connector', disabled: false },
      { choice: 'disabled', disabled: false },
    ]);
    expect(options[1]?.disabledReason).toBeNull();
  });

  test('keeps network boundary disabled when Platinum is unavailable', () => {
    expect(secretDeliveryOptions('http_broker', 'available', 'unsupported')[2]?.disabled).toBe(
      false,
    );
    expect(secretDeliveryOptions('sandbox', 'available', 'unsupported')[1]).toMatchObject({
      disabled: true,
      disabledReason: SHIM_FIX,
    });
  });

  test('disables network boundary on an unpinned project and states the fix', () => {
    expect(secretDeliveryOptions('sandbox', 'available', 'project_not_pinned')[1]).toMatchObject({
      disabled: true,
      disabledReason: PIN_FIX,
    });
  });

  test('disables a selected broker value when the server marks it unavailable', () => {
    expect(secretDeliveryOptions('http_broker', 'unavailable', 'available')[2]).toMatchObject({
      disabled: true,
      disabledReason: 'Not available in this deployment.',
    });
  });

  test('leaves an unselected broker value enabled even when the server marks it unavailable', () => {
    // `status` describes the SELECTED strategy's own deployment; it must not
    // leak into a sibling broker value the dialog is not currently showing.
    expect(secretDeliveryOptions('llm_gateway', 'unavailable', 'available')[2]).toMatchObject({
      disabled: false,
      disabledReason: null,
    });
  });
});

describe('secretDeliveryOptionGroups', () => {
  test('buckets the flat list into "for your agent" then "for a Kortix service", in order', () => {
    const groups = secretDeliveryOptionGroups(secretDeliveryOptions('sandbox', 'available', 'available'));
    expect(groups.map((g) => ({ group: g.group, label: g.label, choices: g.options.map((o) => o.choice) }))).toEqual([
      {
        group: 'agent',
        label: "For your agent's own code",
        choices: ['sandbox', 'network_boundary', 'http_broker'],
      },
      { group: 'service', label: 'For a Kortix service', choices: ['llm_gateway', 'connector'] },
      { group: 'none', label: null, choices: ['disabled'] },
    ]);
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
 *
 * The mode argument exists for the mirror-image failure. The shim never cuts a
 * response, so telling a shim-backed project to expect an empty reply describes
 * a working boundary as a broken one — and a genuinely dead host as success.
 */
describe('networkBoundaryEchoNotice', () => {
  test('names the provider edge symptom and denies the wrong conclusion', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com', 'provider-edge');
    expect(notice.body).toContain('curl: (52) Empty reply from server');
    expect(notice.body).toContain('the boundary working, not the host being down');
  });

  test('the shim returns a redacted 200, so its notice says that instead', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com', 'in-guest-shim');
    expect(notice.title).toContain('[REDACTED]');
    expect(notice.body).toContain('[REDACTED]');
    // The exact symptom the edge calls success is a real failure here, so the
    // shim copy must not carry it.
    expect(notice.body).not.toContain('curl: (52) Empty reply from server');
    expect(notice.body).toContain('a real failure here');
  });

  test('probes the first declared host with a credential-consuming request', () => {
    const notice = networkBoundaryEchoNotice('API.Stripe.com\nuploads.stripe.com', 'provider-edge');
    expect(notice.probe).toContain('https://api.stripe.com/');
    expect(notice.probe).toContain('never one that echoes headers');
    expect(notice.probe).toContain('200 = the header arrived. 401 = it did not.');
  });

  test('probes the same way under both mechanisms', () => {
    // An endpoint that spends the credential answers 200 or 401 either way,
    // which is why it is the probe worth pasting.
    expect(networkBoundaryEchoNotice('api.stripe.com', 'in-guest-shim').probe).toBe(
      networkBoundaryEchoNotice('api.stripe.com', 'provider-edge').probe,
    );
  });

  test('falls back to a placeholder host before anything is typed', () => {
    expect(networkBoundaryEchoNotice('', 'in-guest-shim').probe).toContain(
      'https://api.example.com/',
    );
  });

  test('points at the two-probe procedure in the docs', () => {
    const notice = networkBoundaryEchoNotice('api.stripe.com', 'provider-edge');
    expect(notice.docsHref).toBe('/docs/project/secrets#verify-it-with-two-probes');
    expect(notice.docsLabel).toBe('Verify it with two probes');
  });

  test('never suggests looking for the value in the sandbox', () => {
    for (const mode of ['provider-edge', 'in-guest-shim'] as const) {
      const notice = networkBoundaryEchoNotice('api.stripe.com', mode);
      const text = `${notice.title} ${notice.body} ${notice.probe}`;
      expect(text).not.toContain('env ');
      expect(text).not.toContain('{{secret}}');
      expect(text.toLowerCase()).not.toContain('authorization:');
    }
  });
});
