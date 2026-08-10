import type {
  SecretConsumer,
  SecretDeliveryStatus,
  SecretDeliveryStrategy,
  SecretEgressPolicy,
  WorkspaceAdminConnector,
} from '@kortix/sdk';

export type ConnectorBindingOption = {
  slug: string;
  name: string;
  selected: boolean;
  disabled: boolean;
  description: string;
};

export type BrokerConsumer = 'llm_gateway' | 'connector' | 'http_broker';

export function brokerConsumerForSecret(consumer?: SecretConsumer | null): BrokerConsumer {
  if (consumer === 'llm_gateway') return 'llm_gateway';
  if (consumer === 'connector') return 'connector';
  return 'http_broker';
}

export function connectorBindingOptions(
  connectors: readonly WorkspaceAdminConnector[],
  secretIdentifier: string,
): ConnectorBindingOption[] {
  return connectors.map((connector) => {
    const selected = connector.secretIdentifier === secretIdentifier;
    let description = 'Uses this secret outside the sandbox.';
    let disabled = false;
    if (!connector.authSecret || connector.provider === 'channel') {
      disabled = true;
      description = 'This connector manages authentication through its platform connection.';
    } else if (connector.authorizationStrategy !== 'workspace') {
      disabled = true;
      description =
        'Change authorization ownership to Workspace before binding a workspace secret.';
    } else if (connector.credentialSource === 'stored') {
      disabled = true;
      description = 'Disconnect the stored connector credential before using a workspace secret.';
    } else if (connector.secretIdentifier && !selected) {
      disabled = true;
      description = `Already uses ${connector.secretIdentifier}. Unbind it there first.`;
    }
    return { slug: connector.slug, name: connector.name, selected, disabled, description };
  });
}

export function connectorBindingChanges(
  connectors: readonly WorkspaceAdminConnector[],
  secretIdentifier: string,
  selectedSlugs: readonly string[],
): { bind: string[]; unbind: string[] } {
  const selected = new Set(selectedSlugs);
  const currentlyBound = new Set(
    connectors
      .filter((connector) => connector.secretIdentifier === secretIdentifier)
      .map((connector) => connector.slug),
  );
  return {
    bind: [...selected].filter((slug) => !currentlyBound.has(slug)),
    unbind: [...currentlyBound].filter((slug) => !selected.has(slug)),
  };
}

export type SecretDeliveryPresentation = {
  label: string;
  description: string;
  tone: 'warning' | 'secondary' | 'outline';
};

const PRESENTATIONS: Record<SecretDeliveryStrategy, SecretDeliveryPresentation> = {
  runtime: {
    label: 'Sandbox',
    description: 'Available to agent code and commands as an environment variable.',
    tone: 'warning',
  },
  broker: {
    label: 'Kortix service',
    description: 'Used by an approved Kortix service without entering the sandbox.',
    tone: 'secondary',
  },
  egress: {
    label: 'Network boundary',
    description: 'Added to approved outbound requests at the network boundary.',
    tone: 'secondary',
  },
  denied: {
    label: 'Disabled',
    description: 'Stored securely, but unavailable to sessions and Kortix services.',
    tone: 'outline',
  },
};

export function secretDeliveryPresentation(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretDeliveryPresentation {
  if (strategy === 'broker' && consumer === 'llm_gateway') {
    return {
      label: 'LLM gateway',
      description: 'Used for model requests without entering the sandbox.',
      tone: 'secondary',
    };
  }
  if (strategy === 'broker' && consumer === 'http_broker') {
    return {
      label: 'HTTPS broker',
      description: 'Added only to an approved HTTPS request outside the sandbox.',
      tone: 'secondary',
    };
  }
  if (strategy === 'broker' && consumer === 'connector') {
    return {
      label: 'Connector',
      description: 'Used by an authorized connector without entering the sandbox.',
      tone: 'secondary',
    };
  }
  if (strategy === 'broker' && consumer === 'git_proxy') {
    return {
      label: 'Git service',
      description: 'Used for repository access without entering the sandbox.',
      tone: 'secondary',
    };
  }
  return PRESENTATIONS[strategy];
}

export type NetworkBoundaryAvailability = 'available' | 'workspace_not_pinned' | 'unsupported';

/**
 * Network-boundary delivery is injected by the Platinum provider itself. The
 * workspace must run on Platinum. A deployment that merely offers Platinum is
 * not enough: on any other provider nothing injects the header and the secret
 * is silently dead.
 */
export function networkBoundaryAvailability(
  workspace?: {
    available_sandbox_providers?: readonly string[] | null;
    default_sandbox_provider?: string | null;
  } | null,
): NetworkBoundaryAvailability {
  if (!workspace?.available_sandbox_providers?.includes('platinum')) return 'unsupported';
  return workspace.default_sandbox_provider === 'platinum' ? 'available' : 'workspace_not_pinned';
}

/** Why network-boundary delivery cannot run here, and how to fix it. */
export function networkBoundaryBlockedReason(
  availability: NetworkBoundaryAvailability,
): string | null {
  if (availability === 'available') return null;
  if (availability === 'unsupported') return 'Not available in this deployment.';
  return 'This workspace does not run on Platinum — pin it in Feature flags → Runtime → Sandbox provider.';
}

export type SecretDeliveryOption = SecretDeliveryPresentation & {
  strategy: SecretDeliveryStrategy;
  disabled: boolean;
  /** Why the option cannot be selected. Null when it can. */
  disabledReason: string | null;
};

export function secretDeliveryOptions(
  selected: SecretDeliveryStrategy,
  status: SecretDeliveryStatus,
  networkBoundary: NetworkBoundaryAvailability,
): SecretDeliveryOption[] {
  return (Object.keys(PRESENTATIONS) as SecretDeliveryStrategy[]).map((strategy) => {
    const disabledReason =
      strategy === 'egress'
        ? networkBoundaryBlockedReason(networkBoundary)
        : strategy === 'broker' && strategy === selected && status !== 'available'
          ? 'Not available in this deployment.'
          : null;
    return {
      strategy,
      ...PRESENTATIONS[strategy],
      disabled: disabledReason !== null,
      disabledReason,
    };
  });
}

export type SecretDeliveryBlockedReason = 'no_agent_grant';

/**
 * Read the API's per-secret delivery verdict. The field is tri-state: absent or
 * null means granted, not applicable, OR undetermined — so anything other than
 * an exact `no_agent_grant` stays silent.
 */
export function secretDeliveryBlockedReason(secret: {
  identifier: string;
  delivery_blocked_reason?: string | null;
}): SecretDeliveryBlockedReason | null {
  return secret.delivery_blocked_reason === 'no_agent_grant' ? 'no_agent_grant' : null;
}

/**
 * A runtime secret reaches the sandbox without a grant, and a disabled one goes
 * nowhere by design. Only broker and egress delivery need a named agent grant.
 */
export function shouldWarnMissingAgentGrant(
  blockedReason: SecretDeliveryBlockedReason | null,
  strategy: SecretDeliveryStrategy,
): boolean {
  if (blockedReason !== 'no_agent_grant') return false;
  return strategy === 'broker' || strategy === 'egress';
}

export type MissingAgentGrantNotice = {
  title: string;
  body: string;
  /** kortix.yaml snippet that grants the secret to one agent. */
  manifest: string;
};

export function missingAgentGrantNotice(identifier: string): MissingAgentGrantNotice {
  return {
    title: 'No agent can receive this secret',
    body: `List ${identifier} under an agent's secrets in kortix.yaml, then run the session with that agent. "secrets: all" does not grant this delivery mode — only an explicit list does.`,
    manifest: `kortix_version: 2\nagents:\n  my-agent:\n    secrets: [${identifier}]`,
  };
}

export type SecretDeliverySyncFailure = {
  session_id: string;
  sandbox_id: string | null;
  reason: string;
};

export type SecretDeliverySync = {
  ok: boolean;
  targeted: number;
  synced: number;
  failed: number;
  failures: SecretDeliverySyncFailure[];
};

/**
 * Read the `delivery_sync` block a secret write returns. The field is additive
 * and null when no sync ran, so an unrecognized shape reports nothing rather
 * than guessing at a failure.
 */
export function readSecretDeliverySync(result: unknown): SecretDeliverySync | null {
  if (typeof result !== 'object' || result === null) return null;
  const sync = (result as { delivery_sync?: unknown }).delivery_sync;
  if (typeof sync !== 'object' || sync === null) return null;
  const record = sync as Record<string, unknown>;
  if (typeof record.ok !== 'boolean') return null;
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  const rawFailures = Array.isArray(record.failures) ? record.failures : [];
  return {
    ok: record.ok,
    targeted: count(record.targeted),
    synced: count(record.synced),
    failed: count(record.failed),
    failures: rawFailures.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const failure = entry as Record<string, unknown>;
      if (typeof failure.reason !== 'string') return [];
      return [
        {
          session_id: typeof failure.session_id === 'string' ? failure.session_id : '',
          sandbox_id: typeof failure.sandbox_id === 'string' ? failure.sandbox_id : null,
          reason: failure.reason,
        },
      ];
    }),
  };
}

/**
 * The save succeeded; the running sandboxes did not take the new policy. The
 * user has to know the difference — the secret looks configured but the live
 * sessions still use the previous one.
 */
export function secretDeliverySyncWarning(
  identifier: string,
  result: unknown,
): { message: string; description: string } | null {
  const sync = readSecretDeliverySync(result);
  if (!sync || sync.ok) return null;
  const count = sync.failed > 0 ? sync.failed : sync.targeted;
  const scope =
    count > 0 ? `${count} running session${count === 1 ? '' : 's'}` : 'the running sessions';
  return {
    message: `Saved ${identifier}, but it is not applied to ${scope}`,
    description: sync.failures[0]?.reason ?? 'No failure reason was reported.',
  };
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export type BrokerPolicyForm = {
  hosts: string;
  methods: string;
  path: string;
  injectionKind: 'header' | 'query' | 'json_body_field';
  injectionTarget: string;
  template: string;
};

export function buildBrokerPolicy(form: BrokerPolicyForm): SecretEgressPolicy | null {
  const hosts = form.hosts
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean);
  const methods = form.methods
    .split(/[\s,]+/)
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean);
  const path = form.path.trim();
  const target = form.injectionTarget.trim();
  if (hosts.length === 0 || !target) return null;
  if (methods.some((method) => !HTTP_METHODS.has(method))) return null;
  if (path && !path.startsWith('/')) return null;
  if (form.injectionKind === 'header' && form.template && !form.template.includes('{{secret}}')) {
    return null;
  }

  const inject =
    form.injectionKind === 'header'
      ? {
          kind: 'header' as const,
          name: target,
          ...(form.template.trim() ? { template: form.template.trim() } : {}),
        }
      : form.injectionKind === 'query'
        ? { kind: 'query' as const, name: target }
        : { kind: 'json_body_field' as const, path: target };
  return {
    backend: 'kortix_fetch',
    rules: hosts.map((host) => ({
      host,
      ...(methods.length > 0 ? { methods } : {}),
      ...(path ? { path } : {}),
    })),
    inject,
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

export type NetworkBoundaryPolicyForm = {
  hosts: string;
  injectionTarget: string;
  template: string;
};

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EXACT_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function buildNetworkBoundaryPolicy(
  form: NetworkBoundaryPolicyForm,
): SecretEgressPolicy | null {
  const hosts = form.hosts
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const target = form.injectionTarget.trim();
  const template = form.template.trim();
  if (hosts.length === 0 || hosts.some((host) => !EXACT_HOST.test(host))) return null;
  if (!HEADER_NAME.test(target)) return null;
  if (template && !template.includes('{{secret}}')) return null;
  return {
    rules: [...new Set(hosts)].map((host) => ({ host })),
    inject: {
      kind: 'header',
      name: target,
      ...(template ? { template } : {}),
    },
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

export function canSaveSecretDelivery(input: {
  isEdit: boolean;
  key: string;
  value: string;
  requiresValue: boolean;
  requiresRotation: boolean;
  currentStrategy: SecretDeliveryStrategy;
  nextStrategy: SecretDeliveryStrategy;
  nextConsumer: SecretConsumer | null;
  brokerPolicyValid: boolean;
  networkBoundaryPolicyValid?: boolean;
  selectedConnectorCount?: number;
}): boolean {
  const hasValue = Boolean(input.value.trim());
  if (!input.isEdit && !input.key.trim()) return false;
  if (input.requiresValue && !hasValue) return false;
  if (input.nextStrategy === 'runtime' && input.requiresRotation && !hasValue) return false;
  if (
    input.nextStrategy === 'broker' &&
    input.nextConsumer === 'http_broker' &&
    !input.brokerPolicyValid
  ) {
    return false;
  }
  if (input.nextStrategy === 'egress' && !input.networkBoundaryPolicyValid) return false;
  if (
    input.nextStrategy === 'broker' &&
    input.nextConsumer === 'connector' &&
    (input.selectedConnectorCount ?? 0) === 0
  ) {
    return false;
  }
  if (input.nextStrategy === 'broker') return true;
  return !input.isEdit || hasValue || input.nextStrategy !== input.currentStrategy;
}
