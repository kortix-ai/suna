import { describe, expect, test } from 'bun:test';

import {
  SIGNING_CREDENTIAL_NOTE,
  buildEnforcedPolicy,
  canSaveSecretDelivery,
  classifyNewSecret,
  connectorBindingChanges,
  connectorBindingOptions,
  defaultSecretExposure,
  enforcedEchoNotice,
  legacyInjectionDetail,
  missingAgentGrantNotice,
  parseEnforcedHosts,
  readSecretDeliverySync,
  secretDeliveryBlockedReason,
  secretDeliveryLegend,
  secretDeliveryPresentation,
  secretDeliverySyncWarning,
  secretDeliveryTarget,
  secretExposure,
  secretExposureOptions,
  secretExposureTarget,
  secretUsage,
  secretUsageIsAssigned,
  shouldWarnMissingAgentGrant,
} from './secret-delivery';

describe('secretExposure / secretExposureTarget', () => {
  test('round-trips every pickable exposure through its stored strategy+consumer pair', () => {
    for (const exposure of ['enforced', 'environment', 'disabled'] as const) {
      const target = secretExposureTarget(exposure);
      expect(secretExposure(target.strategy, target.consumer)).toBe(exposure);
    }
  });

  test('the picker writes exactly the three pairs the model names', () => {
    // docs/specs/2026-08-19-secrets-exposure-usage-model.md §3. A fourth pair
    // here would be a delivery mode the read side cannot name back.
    expect(secretExposureTarget('enforced')).toEqual({ strategy: 'egress', consumer: 'network' });
    expect(secretExposureTarget('environment')).toEqual({
      strategy: 'runtime',
      consumer: 'sandbox',
    });
    expect(secretExposureTarget('disabled')).toEqual({ strategy: 'denied', consumer: null });
  });

  test('a legacy HTTPS-broker row reads back as enforced, not as something else', () => {
    // Same guarantee: the sandbox holds a handle and the value is added
    // outside it. Presenting it as a fourth mode is what the model deletes.
    expect(secretExposure('broker', 'http_broker')).toBe('enforced');
  });

  test('a row with no sandbox presence and no agent usage reads as disabled', () => {
    expect(secretExposure('broker', 'llm_gateway')).toBe('disabled');
    expect(secretExposure('broker', 'connector')).toBe('disabled');
    expect(secretExposure('broker', 'git_proxy')).toBe('disabled');
  });
});

describe('secretUsage', () => {
  test('every exposure other than disabled implies agent code', () => {
    expect(secretUsage('runtime', 'sandbox')).toBe('agent');
    expect(secretUsage('egress', 'network')).toBe('agent');
    expect(secretUsage('broker', 'http_broker')).toBe('agent');
  });

  test('the three assigned usages are named by their consumer', () => {
    expect(secretUsage('broker', 'llm_gateway')).toBe('llm_gateway');
    expect(secretUsage('broker', 'connector')).toBe('connector');
    expect(secretUsage('broker', 'git_proxy')).toBe('git');
  });

  test('a disabled secret has no spender', () => {
    expect(secretUsage('denied', null)).toBeNull();
  });
});

describe('secretUsageIsAssigned', () => {
  test('covers every usage another flow writes, not just git', () => {
    // This generalizes the old git-only lock. The picker writes three pairs
    // and none of them is these, so opening it on such a row would move the
    // secret off the consumer its owning flow reads.
    expect(secretUsageIsAssigned('llm_gateway')).toBe(true);
    expect(secretUsageIsAssigned('connector')).toBe(true);
    expect(secretUsageIsAssigned('git_proxy')).toBe(true);
  });

  test('leaves the pickable consumers alone', () => {
    expect(secretUsageIsAssigned('sandbox')).toBe(false);
    expect(secretUsageIsAssigned('network')).toBe(false);
    expect(secretUsageIsAssigned('http_broker')).toBe(false);
    expect(secretUsageIsAssigned(null)).toBe(false);
    expect(secretUsageIsAssigned(undefined)).toBe(false);
  });
});

describe('secretDeliveryTarget', () => {
  test('a new secret writes the pair its exposure names', () => {
    expect(secretDeliveryTarget('enforced', null)).toEqual({
      strategy: 'egress',
      consumer: 'network',
    });
    expect(secretDeliveryTarget('environment', null)).toEqual({
      strategy: 'runtime',
      consumer: 'sandbox',
    });
  });

  test('an assigned row keeps its stored pair whatever the exposure argument says', () => {
    for (const consumer of ['llm_gateway', 'connector', 'git_proxy'] as const) {
      expect(secretDeliveryTarget('environment', { strategy: 'broker', consumer })).toEqual({
        strategy: 'broker',
        consumer,
      });
    }
  });

  test('a legacy HTTPS-broker row that stays enforced keeps its pair', () => {
    // `kortix secrets call` addresses it by that pair, and its stored policy
    // carries a `kortix_fetch` backend the egress validator rejects — so
    // rewriting the pair would 400 the save, not migrate the secret.
    expect(secretDeliveryTarget('enforced', { strategy: 'broker', consumer: 'http_broker' })).toEqual(
      { strategy: 'broker', consumer: 'http_broker' },
    );
  });

  test('the same legacy row moved off enforced writes the new pair', () => {
    expect(
      secretDeliveryTarget('environment', { strategy: 'broker', consumer: 'http_broker' }),
    ).toEqual({ strategy: 'runtime', consumer: 'sandbox' });
    expect(
      secretDeliveryTarget('disabled', { strategy: 'broker', consumer: 'http_broker' }),
    ).toEqual({ strategy: 'denied', consumer: null });
  });
});

describe('classifyNewSecret', () => {
  test('an ordinary key defaults to enforced with an empty host list', () => {
    const classification = classifyNewSecret({ key: 'STRIPE_API_KEY', value: 'sk_live_abc' });
    expect(classification).toEqual({
      exposure: 'enforced',
      hosts: [],
      modelProvider: null,
      signingNote: null,
    });
  });

  test('a known model key is recognized and prefills the vendor host from the catalog', () => {
    const classification = classifyNewSecret({ key: 'DEEPSEEK_API_KEY', value: 'sk-abc' });
    expect(classification.exposure).toBe('enforced');
    expect(classification.modelProvider).toEqual({ id: 'deepseek', label: 'DeepSeek' });
    expect(classification.hosts).toEqual(['api.deepseek.com']);
  });

  test('a recognized provider whose SDK hardcodes the host prefills the curated fallback', () => {
    // models.dev declares no `api` for Anthropic — the SDK hardcodes it, so the
    // catalog `apiHost` is null. Without the curated `WELL_KNOWN_API_HOSTS`
    // fallback the hosts field stays empty and Save is disabled until the user
    // types the host by hand (spec §7). The fallback is a stable documented
    // constant, not a value guessed from a catalog URL.
    const classification = classifyNewSecret({ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-abc' });
    expect(classification.modelProvider?.id).toBe('anthropic');
    expect(classification.hosts).toEqual(['api.anthropic.com']);
    expect(classification.exposure).toBe('enforced');
  });

  test('OpenAI, whose SDK also hardcodes its host, prefills the curated fallback', () => {
    const classification = classifyNewSecret({ key: 'OPENAI_API_KEY', value: 'sk-abc' });
    expect(classification.modelProvider?.id).toBe('openai');
    expect(classification.hosts).toEqual(['api.openai.com']);
  });

  test('an alias auth key is recognized too, not just the primary one', () => {
    // `LLM_PROVIDER_BY_ENV_VAR` covers only the primary method, which would
    // miss the key most Gemini users actually hold.
    expect(classifyNewSecret({ key: 'GEMINI_API_KEY', value: 'abc' }).modelProvider?.id).toBe(
      'google',
    );
  });

  test('the key is matched case-insensitively, as typed', () => {
    expect(classifyNewSecret({ key: 'deepseek_api_key', value: 'x' }).modelProvider?.id).toBe(
      'deepseek',
    );
  });

  test('an AWS access-key id defaults to the environment and says why', () => {
    const classification = classifyNewSecret({
      key: 'AWS_ACCESS_KEY_ID',
      value: 'AKIAIOSFODNN7EXAMPLE',
    });
    expect(classification.exposure).toBe('environment');
    expect(classification.signingNote).toBe(SIGNING_CREDENTIAL_NOTE);
    expect(classification.hosts).toEqual([]);
  });

  test('an STS access-key id is signing material too', () => {
    expect(
      classifyNewSecret({ key: 'AWS_ACCESS_KEY_ID', value: 'ASIAIOSFODNN7EXAMPLE' }).exposure,
    ).toBe('environment');
  });

  test('PEM and SSH private-key material defaults to the environment', () => {
    // Build the PEM armor by interpolation so the literal marker never appears
    // contiguously in source — otherwise gitleaks' `private-key` rule flags this
    // fixture. The runtime value the classifier sees is identical.
    const pem = (label: string, b64: string) =>
      `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
    for (const value of [
      pem('RSA PRIVATE KEY', 'MIIE…'),
      pem('OPENSSH PRIVATE KEY', 'b3Bl…'),
      pem('PRIVATE KEY', 'MIIE…'),
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 user@host',
      'PuTTY-User-Key-File-3: ssh-ed25519',
    ]) {
      const classification = classifyNewSecret({ key: 'DEPLOY_KEY', value });
      expect(classification.exposure).toBe('environment');
      expect(classification.signingNote).toBe(SIGNING_CREDENTIAL_NOTE);
    }
  });

  test('signing material outranks the key name, and the recognition still shows', () => {
    // A property of the CREDENTIAL, not of the name: no boundary can enforce
    // a value that is an ingredient in a local computation.
    const classification = classifyNewSecret({
      key: 'DEEPSEEK_API_KEY',
      value: 'AKIAIOSFODNN7EXAMPLE',
    });
    expect(classification.exposure).toBe('environment');
    expect(classification.hosts).toEqual([]);
    expect(classification.modelProvider?.id).toBe('deepseek');
  });

  test('an ordinary key that merely starts with AKIA-ish text is not signing material', () => {
    // The prefix alone is not the shape: AWS ids are exactly 16 more
    // uppercase alphanumerics, and a looser test would push ordinary API keys
    // into the environment.
    expect(classifyNewSecret({ key: 'API_KEY', value: 'AKIAshort' }).exposure).toBe('enforced');
    expect(classifyNewSecret({ key: 'API_KEY', value: '' }).exposure).toBe('enforced');
  });
});

describe('defaultSecretExposure', () => {
  const enforced = classifyNewSecret({ key: 'API_KEY', value: 'plain' });
  const signing = classifyNewSecret({ key: 'DEPLOY_KEY', value: 'AKIAIOSFODNN7EXAMPLE' });

  test('an existing row opens on the exposure it has, including one the picker cannot write', () => {
    expect(defaultSecretExposure({ strategy: 'broker', consumer: 'git_proxy' }, enforced)).toBe(
      'disabled',
    );
    expect(defaultSecretExposure({ strategy: 'runtime', consumer: 'sandbox' }, enforced)).toBe(
      'environment',
    );
    expect(defaultSecretExposure({ strategy: 'broker', consumer: 'http_broker' }, enforced)).toBe(
      'enforced',
    );
  });

  test('a new secret opens on whatever the classification decided', () => {
    expect(defaultSecretExposure(null, enforced)).toBe('enforced');
    expect(defaultSecretExposure(undefined, signing)).toBe('environment');
  });
});

describe('secretDeliveryLegend', () => {
  test('lists the three exposures first, then the three assigned usages', () => {
    expect(secretDeliveryLegend().map((entry) => [entry.kind, entry.key])).toEqual([
      ['exposure', 'enforced'],
      ['exposure', 'environment'],
      ['exposure', 'disabled'],
      ['usage', 'llm_gateway'],
      ['usage', 'connector'],
      ['usage', 'git'],
    ]);
  });

  test('never names a mechanism as a user-facing value', () => {
    // The release bar in §8: a reader must never meet "network boundary" and
    // "HTTPS broker" as two choices anywhere.
    const text = secretDeliveryLegend()
      .map((entry) => `${entry.label} ${entry.description}`)
      .join(' ')
      .toLowerCase();
    expect(text).not.toContain('network boundary');
    expect(text).not.toContain('https broker');
    expect(text).not.toContain('sandbox handle');
  });

  test('the exposure wording matches secretDeliveryPresentation exactly — one source of truth', () => {
    for (const entry of secretDeliveryLegend()) {
      if (entry.kind !== 'exposure') continue;
      const target = secretExposureTarget(entry.key as 'enforced' | 'environment' | 'disabled');
      expect(secretDeliveryPresentation(target.strategy, target.consumer)).toEqual({
        label: entry.label,
        description: entry.description,
        tone: entry.tone,
      });
    }
  });
});

describe('secretDeliveryPresentation', () => {
  test('an environment secret is warning-toned and says agent code can read it', () => {
    expect(secretDeliveryPresentation('runtime')).toEqual({
      label: 'Environment variable',
      description: 'The real value is an environment variable agent code and commands can read.',
      tone: 'warning',
    });
  });

  test('an enforced secret names the handle and the approved hosts', () => {
    expect(secretDeliveryPresentation('egress', 'network')).toEqual({
      label: 'Enforce at the network',
      description:
        'The sandbox holds a handle. Kortix substitutes the real value only on requests to the approved hosts.',
      tone: 'secondary',
    });
    // A legacy HTTPS-broker row shows the same badge: same guarantee.
    expect(secretDeliveryPresentation('broker', 'http_broker').label).toBe(
      'Enforce at the network',
    );
  });

  test('a disabled secret is stored and delivered nowhere', () => {
    expect(secretDeliveryPresentation('denied')).toEqual({
      label: 'Disabled',
      description: 'Stored securely, but delivered to no session and no Kortix service.',
      // `info` is the design system's neutral filled pill, not the near-invisible
      // `outline` (bg-accent sits one hairline off the page surface).
      tone: 'info',
    });
  });

  test('an assigned usage wins over the exposure', () => {
    // `broker`/`llm_gateway` is exposure `disabled`; rendering "Disabled"
    // beside a working provider key would be a lie.
    expect(secretDeliveryPresentation('broker', 'llm_gateway')).toMatchObject({
      label: 'LLM gateway',
      description: 'Spent by the Kortix model gateway. It never enters the sandbox.',
    });
    expect(secretDeliveryPresentation('broker', 'connector')).toMatchObject({
      label: 'Connector',
    });
    expect(secretDeliveryPresentation('broker', 'git_proxy')).toMatchObject({ label: 'Git' });
  });
});

describe('secretExposureOptions', () => {
  test('offers exactly three values, always enabled, in picker order', () => {
    // Nothing gates them any more: one mechanism serves every sandbox
    // provider (§4), so there is no deployment where enforcement is missing.
    expect(secretExposureOptions().map((option) => option.exposure)).toEqual([
      'enforced',
      'environment',
      'disabled',
    ]);
    for (const option of secretExposureOptions()) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});

describe('secretDeliveryBlockedReason', () => {
  test('reports the blocked verdict only on the exact reason', () => {
    expect(
      secretDeliveryBlockedReason({
        identifier: 'ENFORCED_TEST',
        delivery_blocked_reason: 'no_agent_grant',
      }),
    ).toBe('no_agent_grant');
  });

  test('stays silent on null, absent, and unrecognized values', () => {
    // Tri-state: null covers "granted", "not applicable" AND "we could not
    // tell" — warning on uncertainty is worse than not warning.
    expect(
      secretDeliveryBlockedReason({ identifier: 'ENFORCED_TEST', delivery_blocked_reason: null }),
    ).toBeNull();
    expect(secretDeliveryBlockedReason({ identifier: 'ENFORCED_TEST' })).toBeNull();
    expect(
      secretDeliveryBlockedReason({
        identifier: 'ENFORCED_TEST',
        delivery_blocked_reason: 'manifest_unreadable',
      }),
    ).toBeNull();
  });
});

describe('shouldWarnMissingAgentGrant', () => {
  test('warns only for enforced rows, which hold a sandbox handle a grant delivers', () => {
    // `egress`/`network` and the legacy `broker`/`http_broker` both read as
    // `enforced` — the two delivery modes that reach a session only via a grant.
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'egress', 'network')).toBe(true);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'broker', 'http_broker')).toBe(true);
  });

  test('stays silent for a none-exposure broker row (llm_gateway / connector / git)', () => {
    // The defect: an `llm_gateway` row is `strategy: broker` too, but its
    // exposure is `none` — no sandbox presence, so agent-grant guidance never
    // applies. The consumer disambiguates it from a legacy http_broker row.
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'broker', 'llm_gateway')).toBe(false);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'broker', 'connector')).toBe(false);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'broker', 'git_proxy')).toBe(false);
  });

  test('stays silent for runtime, disabled, and an unblocked secret', () => {
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'runtime', 'sandbox')).toBe(false);
    expect(shouldWarnMissingAgentGrant('no_agent_grant', 'denied', null)).toBe(false);
    expect(shouldWarnMissingAgentGrant(null, 'egress', 'network')).toBe(false);
  });
});

describe('missingAgentGrantNotice', () => {
  test('names the identifier, the manifest fix, and rejects the "all" shorthand', () => {
    const notice = missingAgentGrantNotice('ENFORCED_TEST');
    expect(notice.title).toBe('No agent can receive this secret');
    expect(notice.body).toContain('ENFORCED_TEST');
    expect(notice.body).toContain('kortix.yaml');
    expect(notice.body).toContain('"secrets: all" does not grant this delivery mode');
    expect(notice.manifest).toBe(
      'kortix_version: 2\nagents:\n  my-agent:\n    secrets: [ENFORCED_TEST]',
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
    expect(readSecretDeliverySync({ identifier: 'ENFORCED_TEST' })).toBeNull();
    expect(readSecretDeliverySync({ delivery_sync: null })).toBeNull();
    expect(readSecretDeliverySync({ delivery_sync: { targeted: 2 } })).toBeNull();
    expect(readSecretDeliverySync(null)).toBeNull();
  });

  test('warns with the session count and the first failure reason verbatim', () => {
    expect(secretDeliverySyncWarning('ENFORCED_TEST', sync())).toEqual({
      message: 'Saved ENFORCED_TEST, but it is not applied to 1 running session',
      description: 'sandbox unreachable: 502',
    });
    expect(
      secretDeliverySyncWarning(
        'ENFORCED_TEST',
        sync({
          failed: 2,
          failures: [
            { session_id: 'ses_1', sandbox_id: null, reason: 'first reason' },
            { session_id: 'ses_2', sandbox_id: 'sbx_2', reason: 'second reason' },
          ],
        }),
      ),
    ).toEqual({
      message: 'Saved ENFORCED_TEST, but it is not applied to 2 running sessions',
      description: 'first reason',
    });
  });

  test('falls back to the targeted count and a plain reason when the block is thin', () => {
    expect(secretDeliverySyncWarning('ENFORCED_TEST', sync({ failed: 0, failures: [] }))).toEqual({
      message: 'Saved ENFORCED_TEST, but it is not applied to 2 running sessions',
      description: 'No failure reason was reported.',
    });
    expect(
      secretDeliverySyncWarning('ENFORCED_TEST', sync({ targeted: 0, failed: 0, failures: [] })),
    ).toEqual({
      message: 'Saved ENFORCED_TEST, but it is not applied to the running sessions',
      description: 'No failure reason was reported.',
    });
  });

  test('stays silent on a successful sync and on a response without the block', () => {
    expect(secretDeliverySyncWarning('ENFORCED_TEST', sync({ ok: true, failed: 0 }))).toBeNull();
    expect(secretDeliverySyncWarning('ENFORCED_TEST', { delivery_sync: null })).toBeNull();
    expect(secretDeliverySyncWarning('ENFORCED_TEST', { identifier: 'ENFORCED_TEST' })).toBeNull();
  });
});

describe('canSaveSecretDelivery', () => {
  const base = {
    isEdit: true,
    key: 'LOCAL_TEST_KEY',
    value: '',
    requiresValue: false,
    requiresRotation: false,
    currentStrategy: 'runtime' as const,
    nextStrategy: 'runtime' as const,
    nextConsumer: 'sandbox' as const,
    enforcedPolicyValid: false,
  };

  test('requires a replacement value before restoring environment exposure', () => {
    expect(
      canSaveSecretDelivery({
        ...base,
        requiresRotation: true,
        currentStrategy: 'denied',
      }),
    ).toBe(false);
  });

  test('allows environment exposure after a replacement value is entered', () => {
    expect(
      canSaveSecretDelivery({
        ...base,
        value: 'replacement',
        requiresRotation: true,
        currentStrategy: 'denied',
      }),
    ).toBe(true);
  });

  test('requires a changed value or exposure for an existing secret', () => {
    expect(canSaveSecretDelivery(base)).toBe(false);
  });

  test('requires a valid host list for an enforced secret', () => {
    const enforced = {
      ...base,
      nextStrategy: 'egress' as const,
      nextConsumer: 'network' as const,
    };
    expect(canSaveSecretDelivery(enforced)).toBe(false);
    expect(canSaveSecretDelivery({ ...enforced, enforcedPolicyValid: true })).toBe(true);
  });

  test('a legacy HTTPS-broker row needs the same host list', () => {
    const legacy = {
      ...base,
      nextStrategy: 'broker' as const,
      nextConsumer: 'http_broker' as const,
    };
    expect(canSaveSecretDelivery(legacy)).toBe(false);
    expect(canSaveSecretDelivery({ ...legacy, enforcedPolicyValid: true })).toBe(true);
  });

  test('an assigned LLM-gateway row needs no host list', () => {
    expect(
      canSaveSecretDelivery({
        ...base,
        key: 'OPENAI_API_KEY',
        nextStrategy: 'broker',
        nextConsumer: 'llm_gateway',
      }),
    ).toBe(true);
  });

  test('requires at least one connector for a connector-bound secret', () => {
    expect(
      canSaveSecretDelivery({
        ...base,
        key: 'API_KEY',
        nextStrategy: 'broker',
        nextConsumer: 'connector',
        selectedConnectorCount: 0,
      }),
    ).toBe(false);
    expect(
      canSaveSecretDelivery({
        ...base,
        key: 'API_KEY',
        nextStrategy: 'broker',
        nextConsumer: 'connector',
        selectedConnectorCount: 1,
      }),
    ).toBe(true);
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

describe('buildEnforcedPolicy', () => {
  test('builds a host allow-list and nothing else', () => {
    // §6: the policy collapses to hosts. No header, no template, no method,
    // no path — the agent's own client already carries the handle in place.
    expect(
      buildEnforcedPolicy({ hosts: 'api.anthropic.com\napi.openai.com' }),
    ).toEqual({
      rules: [{ host: 'api.anthropic.com' }, { host: 'api.openai.com' }],
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('rejects wildcard hosts, URLs, and an empty list', () => {
    expect(buildEnforcedPolicy({ hosts: '*.example.com' })).toBeNull();
    expect(buildEnforcedPolicy({ hosts: 'https://api.example.com' })).toBeNull();
    expect(buildEnforcedPolicy({ hosts: 'api.example.com:443' })).toBeNull();
    expect(buildEnforcedPolicy({ hosts: '  \n , ' })).toBeNull();
  });

  test('a legacy slot rides through untouched', () => {
    // Dropping it on an unrelated save — a value rotation, a host added —
    // would silently stop a working injection.
    expect(
      buildEnforcedPolicy({
        hosts: 'api.example.com',
        legacyInject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
      }),
    ).toEqual({
      rules: [{ host: 'api.example.com' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('a legacy HTTPS-broker row keeps the backend its consumer requires', () => {
    expect(
      buildEnforcedPolicy({ hosts: 'api.example.com', backend: 'kortix_fetch' })?.backend,
    ).toBe('kortix_fetch');
    // And an ordinary enforced row states none: the egress validator rejects
    // any backend at all.
    expect(buildEnforcedPolicy({ hosts: 'api.example.com' })).not.toHaveProperty('backend');
  });
});

describe('parseEnforcedHosts', () => {
  test('lowercases, splits on commas and newlines, and drops duplicates', () => {
    expect(parseEnforcedHosts('API.Example.com, api.example.com\nuploads.example.com  ')).toEqual([
      'api.example.com',
      'uploads.example.com',
    ]);
  });

  test('reads an empty field as no hosts', () => {
    expect(parseEnforcedHosts('   \n , ')).toEqual([]);
  });
});

describe('legacyInjectionDetail', () => {
  test('reports nothing for a substitution-only policy', () => {
    expect(legacyInjectionDetail({ rules: [{ host: 'api.example.com' }] })).toBeNull();
    expect(legacyInjectionDetail(null)).toBeNull();
    expect(legacyInjectionDetail(undefined)).toBeNull();
  });

  test('spells out a stored header slot, template included', () => {
    const detail = legacyInjectionDetail({
      rules: [{ host: 'api.example.com' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    });
    expect(detail?.lines).toEqual(['Header: authorization', 'Value: Bearer {{secret}}']);
    expect(detail?.body).toContain('Remove it');
  });

  test('an absent template is shown as the implicit bare value', () => {
    // The stored default is `{{secret}}`; showing nothing would read as "no
    // value", which is the opposite of what the broker does.
    expect(
      legacyInjectionDetail({
        rules: [{ host: 'api.example.com' }],
        inject: { kind: 'header', name: 'x-api-key' },
      })?.lines,
    ).toEqual(['Header: x-api-key', 'Value: {{secret}}']);
  });

  test('query and JSON-body slots, plus the method and path filters, are all reported', () => {
    expect(
      legacyInjectionDetail({
        backend: 'kortix_fetch',
        rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
        inject: { kind: 'query', name: 'api_key' },
      })?.lines,
    ).toEqual(['Query parameter: api_key', 'Methods: POST', 'Path: /v1/*']);
    expect(
      legacyInjectionDetail({
        rules: [{ host: 'api.example.com' }],
        inject: { kind: 'json_body_field', path: 'auth.api_key' },
      })?.lines,
    ).toEqual(['JSON body field: auth.api_key']);
  });
});

/**
 * The incident this text exists for: an agent probed an echo endpoint, read the
 * cut connection as a dead host, and invented a TLS explanation. Nothing in the
 * product said the boundary was there.
 *
 * There is ONE symptom now. The provider edge is gone (spec §4), so the
 * empty-reply story it produced must not appear anywhere — telling a user to
 * expect it makes a working request look broken.
 */
describe('enforcedEchoNotice', () => {
  test('names the redacted echo and denies the wrong conclusion', () => {
    const notice = enforcedEchoNotice('api.stripe.com');
    expect(notice.title).toContain('[REDACTED]');
    expect(notice.body).toContain('[REDACTED]');
    expect(notice.body).toContain('a real failure');
  });

  test('the retired provider-edge symptom appears nowhere', () => {
    const notice = enforcedEchoNotice('api.stripe.com');
    const text = `${notice.title} ${notice.body} ${notice.probe}`;
    expect(text).not.toContain('curl: (52) Empty reply from server');
    expect(text.toLowerCase()).not.toContain('network boundary');
  });

  test('probes the first declared host with a credential-consuming request', () => {
    const notice = enforcedEchoNotice('API.Stripe.com\nuploads.stripe.com');
    expect(notice.probe).toContain('https://api.stripe.com/');
    expect(notice.probe).toContain('never one that echoes headers');
    expect(notice.probe).toContain('200 = the real value was substituted. 401 = it was not.');
  });

  test('falls back to a placeholder host before anything is typed', () => {
    expect(enforcedEchoNotice('').probe).toContain('https://api.example.com/');
  });

  test('points at the two-probe procedure in the docs', () => {
    const notice = enforcedEchoNotice('api.stripe.com');
    expect(notice.docsHref).toBe('/docs/project/secrets#verify-it-with-two-probes');
    expect(notice.docsLabel).toBe('Verify it with two probes');
  });

  test('never suggests looking for the value in the sandbox', () => {
    const notice = enforcedEchoNotice('api.stripe.com');
    const text = `${notice.title} ${notice.body} ${notice.probe}`;
    expect(text).not.toContain('env ');
    expect(text).not.toContain('{{secret}}');
    expect(text.toLowerCase()).not.toContain('authorization:');
  });
});
