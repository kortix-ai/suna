import type {
  AdminConnector,
  SecretConsumer,
  SecretDeliveryStatus,
  SecretDeliveryStrategy,
  SecretEgressPolicy,
} from '@kortix/sdk';

export type ConnectorBindingOption = {
  slug: string;
  name: string;
  selected: boolean;
  disabled: boolean;
  description: string;
};

export type BrokerConsumer = 'llm_gateway' | 'connector' | 'http_broker';

/** Normalize the deprecated persisted consumer without exposing it in the UI. */
export function brokerConsumerForSecret(consumer?: SecretConsumer | null): BrokerConsumer {
  if (consumer === 'llm_gateway') return 'llm_gateway';
  if (consumer === 'connector' || consumer === 'executor') return 'connector';
  return 'http_broker';
}

export function connectorBindingOptions(
  connectors: readonly AdminConnector[],
  secretIdentifier: string,
): ConnectorBindingOption[] {
  return connectors.map((connector) => {
    const selected = connector.secretIdentifier === secretIdentifier;
    let description = 'Uses this secret outside the sandbox.';
    let disabled = false;
    if (!connector.authSecret || connector.provider === 'channel') {
      disabled = true;
      description = 'This connector manages authentication through its platform connection.';
    } else if (connector.authorizationStrategy !== 'project') {
      disabled = true;
      description = 'Change authorization ownership to Project before binding a project secret.';
    } else if (connector.credentialSource === 'stored') {
      disabled = true;
      description = 'Disconnect the stored connector credential before using a project secret.';
    } else if (connector.secretIdentifier && !selected) {
      disabled = true;
      description = `Already uses ${connector.secretIdentifier}. Unbind it there first.`;
    }
    return { slug: connector.slug, name: connector.name, selected, disabled, description };
  });
}

export function connectorBindingChanges(
  connectors: readonly AdminConnector[],
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

export type SecretDeliveryOption = SecretDeliveryPresentation & {
  strategy: SecretDeliveryStrategy;
  disabled: boolean;
};

export function secretDeliveryOptions(
  selected: SecretDeliveryStrategy,
  status: SecretDeliveryStatus,
): SecretDeliveryOption[] {
  return (Object.keys(PRESENTATIONS) as SecretDeliveryStrategy[]).map((strategy) => ({
    strategy,
    ...PRESENTATIONS[strategy],
    disabled:
      strategy === 'egress' ||
      (strategy === 'broker' && strategy === selected && status !== 'available'),
  }));
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
