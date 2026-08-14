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

export function brokerConsumerForSecret(consumer?: SecretConsumer | null): BrokerConsumer {
  if (consumer === 'llm_gateway') return 'llm_gateway';
  if (consumer === 'connector') return 'connector';
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
    // The only mode where agent code can read the value, so the badge is a
    // warning and not a neutral label. `secrets-view.tsx` says the same thing
    // in longhand right below it (`InfoBanner tone="warning"`, "Readable inside
    // the sandbox"); the two must agree.
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

export type NetworkBoundaryAvailability = 'available' | 'project_not_pinned' | 'unsupported';

/**
 * Two independent mechanisms deliver a network-boundary secret, and a project
 * needs only one.
 *
 * The original one is the **Platinum provider edge**, which is why this used to
 * be a Platinum check. A deployment that merely offers Platinum was never
 * enough: on any other provider nothing injects the header and the secret is
 * silently dead.
 *
 * The second is the **in-guest shim**, a per-project experimental flag. It works
 * on any provider, so it short-circuits the provider question entirely. It is a
 * deliberate opt-in — it also needs a sandbox image new enough to run the shim,
 * which nothing here can verify.
 */
export function networkBoundaryAvailability(
  project?: {
    available_sandbox_providers?: readonly string[] | null;
    default_sandbox_provider?: string | null;
    experimental?: Partial<Record<string, boolean>> | null;
  } | null,
): NetworkBoundaryAvailability {
  if (project?.experimental?.network_boundary_shim) return 'available';
  if (!project?.available_sandbox_providers?.includes('platinum')) return 'unsupported';
  return project.default_sandbox_provider === 'platinum' ? 'available' : 'project_not_pinned';
}

/** The flag's name in Feature flags → Experimental, quoted so the sentence below
 *  points at something the user can actually find. */
const SHIM_FLAG = 'Network boundary without Platinum';

/** Why network-boundary delivery cannot run here, and how to fix it. Both
 *  states are now fixable, so neither says "not available" — the shim flag is
 *  an escape hatch from either one. */
export function networkBoundaryBlockedReason(
  availability: NetworkBoundaryAvailability,
): string | null {
  if (availability === 'available') return null;
  if (availability === 'unsupported') {
    return `Turn on "${SHIM_FLAG}" in Feature flags → Experimental.`;
  }
  return `This project does not run on Platinum — pin it in Feature flags → Runtime → Sandbox provider, or turn on "${SHIM_FLAG}" in Feature flags → Experimental.`;
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
    manifest: agentGrantSnippet(identifier, null),
  };
}

/** The slice of the project config the grant action reads. Structural, because
 *  a capability-filtered response blanks `agent_discovery` that the SDK type
 *  declares as always present. */
export type AgentGrantConfig = {
  agent_discovery?: string | null;
  default_agent?: string | null;
  /** @deprecated Server alias for `default_agent`. */
  open_code_default_agent?: string | null;
  agents?: readonly { name: string; scope?: { env?: string[] | 'all' } | null }[];
};

export type AgentGrantCandidate = {
  name: string;
  /** The agent's manifest list already names the identifier. */
  alreadyGranted: boolean;
  /** The agent's declared `secrets:` value. Null for an agent the manifest does
   *  not declare — the endpoint upserts one. */
  currentSecrets: string[] | 'all' | null;
};

export type AgentGrantPlan = {
  /** Agents the action can name, in manifest order. Empty means no action. */
  candidates: AgentGrantCandidate[];
  /** The agent the action preselects, or null when there is nothing to grant to. */
  preselected: string | null;
  /**
   * This edit writes the manifest's FIRST `agents:` block. The server reports
   * the final verdict as `adopted_governance`; this is the client's estimate,
   * and it only ever decides whether to ask for a confirmation.
   */
  adoptsGovernance: boolean;
};

function admitsIdentifier(list: readonly string[], identifier: string): boolean {
  const target = identifier.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === target);
}

/**
 * Who can this secret be granted to, and does the grant change the project's
 * governance posture?
 *
 * `agent_discovery` is the server's own verdict on whether the manifest
 * declares any agent (apps/api/src/projects/git/config.ts `resolveConfigAgents`)
 * — `declarative` means it does, `opencode` means it declares none. Anything
 * else is a config we cannot read, and an unread config confirms rather than
 * guesses: a missed confirmation silently revokes working runtime secrets.
 */
export function agentGrantPlan(
  config: AgentGrantConfig | null | undefined,
  identifier: string,
): AgentGrantPlan {
  const declared: AgentGrantCandidate[] = [];
  for (const agent of config?.agents ?? []) {
    const name = agent.name?.trim();
    if (!name || declared.some((candidate) => candidate.name === name)) continue;
    const env = agent.scope?.env;
    declared.push({
      name,
      alreadyGranted: Array.isArray(env) && admitsIdentifier(env, identifier),
      currentSecrets: env === 'all' ? 'all' : Array.isArray(env) ? env : null,
    });
  }

  const defaultAgent = (config?.default_agent ?? config?.open_code_default_agent ?? '').trim();
  // A project can carry a default agent that no manifest entry declares — the
  // endpoint upserts the entry, so it is still a valid target.
  const candidates =
    declared.length > 0 || !defaultAgent
      ? declared
      : [{ name: defaultAgent, alreadyGranted: false, currentSecrets: null }];
  const preselected =
    candidates.find((candidate) => candidate.name === defaultAgent)?.name ??
    candidates[0]?.name ??
    null;

  return {
    candidates,
    preselected,
    adoptsGovernance: config?.agent_discovery !== 'declarative',
  };
}

/**
 * The `secrets:` list one agent ends up with, for the hand-edit snippet.
 *
 * `all` and an absent key both withhold broker/egress delivery, so neither can
 * be appended to and the explicit list starts at this identifier. The grant
 * endpoint is more generous with `all` — it expands the shorthand to every
 * identifier the PROJECT holds (`grantSecretToAgentV2`). The client cannot
 * reproduce that: its secrets list omits another member's private override, so
 * enumerating here would print a list that silently revokes one.
 */
export function mergeAgentSecretGrant(
  current: readonly string[] | 'all' | null | undefined,
  identifier: string,
): string[] {
  if (!Array.isArray(current)) return [identifier];
  return admitsIdentifier(current, identifier) ? [...current] : [...current, identifier];
}

/** The kortix.yaml edit that grants the secret, for anyone editing the repo by hand. */
export function agentGrantSnippet(
  identifier: string,
  agent: string | null,
  current?: readonly string[] | 'all' | null,
): string {
  const secrets = mergeAgentSecretGrant(current, identifier);
  return `kortix_version: 2\nagents:\n  ${agent ?? 'my-agent'}:\n    secrets: [${secrets.join(', ')}]`;
}

/** One agent needs no picker, so the button carries the name instead. */
export function agentGrantActionLabel(plan: AgentGrantPlan, selected: string | null): string {
  return plan.candidates.length === 1 && selected ? `Grant to ${selected}` : 'Grant';
}

/** Why picking this agent is not a plain addition. Null when it is. */
export function agentGrantCandidateHint(candidate: AgentGrantCandidate): string | null {
  if (candidate.alreadyGranted) return 'Already lists this secret.';
  if (candidate.currentSecrets === 'all') {
    return 'Runs on "secrets: all". The grant expands that to an explicit list of the project secrets.';
  }
  return null;
}

export type AgentGrantConfirmation = { title: string; body: string; confirmLabel: string };

/**
 * The one destructive edge of this action. A project with no `agents:` block
 * hands every project secret to every agent. The first block flips that to
 * deny-by-default (apps/api/src/projects/agents.ts), so agents that are not
 * listed lose the runtime secrets they use today.
 */
export function agentGrantConfirmation(identifier: string, agent: string): AgentGrantConfirmation {
  return {
    title: 'Start governing agents in kortix.yaml',
    body: `This project declares no agents yet, so every agent receives every project secret. Granting ${identifier} to ${agent} writes the first agents: block. From then on an agent that is not listed receives no project secrets — including the sandbox secrets that work today. Add the other agents to kortix.yaml to keep their access.`,
    confirmLabel: `Grant to ${agent}`,
  };
}

export type AgentGrantOutcome = {
  tone: 'success' | 'info';
  message: string;
  description?: string;
};

/** Report what the server actually did — an idempotent call changed nothing. */
export function agentGrantOutcome(result: {
  identifier: string;
  agent: string;
  already_granted: boolean;
  adopted_governance: boolean;
}): AgentGrantOutcome {
  if (result.already_granted) {
    return {
      tone: 'info',
      message: `${result.agent} already receives ${result.identifier}`,
      description: 'kortix.yaml was not changed.',
    };
  }
  return {
    tone: 'success',
    message: `Granted ${result.identifier} to ${result.agent}`,
    description: result.adopted_governance
      ? 'kortix.yaml now declares agents. An agent that is not listed receives no project secrets.'
      : undefined,
  };
}

/** Turn a grant failure into the next action the user can take. */
export function agentGrantErrorMessage(error: unknown): string {
  const fields =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  if (fields.code === 'manifest_v1_unsupported') {
    return 'This project uses a kortix_version 1 manifest. Edit kortix.toml directly, or upgrade the project to kortix_version 2.';
  }
  if (fields.code === 'secret_not_grantable') {
    return 'This secret is disabled. Change its delivery policy before granting it.';
  }
  return typeof fields.message === 'string' && fields.message
    ? fields.message
    : 'Could not grant the secret.';
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

/** The hosts the textarea declares: lowercased, deduplicated, first-seen order.
 *  The policy and the verification probe both read the list from here, so the
 *  host the user is told to probe is a host the boundary actually watches. */
export function parseBoundaryHosts(hosts: string): string[] {
  return [
    ...new Set(
      hosts
        .split(/[\s,]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function buildNetworkBoundaryPolicy(
  form: NetworkBoundaryPolicyForm,
): SecretEgressPolicy | null {
  const hosts = parseBoundaryHosts(form.hosts);
  const target = form.injectionTarget.trim();
  const template = form.template.trim();
  if (hosts.length === 0 || hosts.some((host) => !EXACT_HOST.test(host))) return null;
  if (!HEADER_NAME.test(target)) return null;
  if (template && !template.includes('{{secret}}')) return null;
  return {
    rules: hosts.map((host) => ({ host })),
    inject: {
      kind: 'header',
      name: target,
      ...(template ? { template } : {}),
    },
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

export type NetworkBoundaryEchoNotice = {
  title: string;
  /** The symptom, then what it actually means. */
  body: string;
  /** The shell probe that separates a working boundary from a missing header. */
  probe: string;
  docsHref: string;
  docsLabel: string;
};

/**
 * The one thing about this mode nobody can deduce from inside the sandbox.
 *
 * The boundary cuts any response that would carry the value back into the
 * guest, so an echo endpoint answers `curl: (52) Empty reply from server` —
 * byte-identical to a dead host. A product owner lost days to exactly that
 * reading, and their agent invented a TLS explanation for it. The panel that
 * configures the mode is the last place to say so before someone tests it.
 *
 * The probe names the first declared host so it can be pasted as-is; with no
 * host typed yet it falls back to a placeholder rather than an empty URL.
 */
export function networkBoundaryEchoNotice(hosts: string): NetworkBoundaryEchoNotice {
  const host = parseBoundaryHosts(hosts)[0] ?? 'api.example.com';
  return {
    title: 'A blocked echo looks exactly like a dead host',
    body: 'A response that would carry this value back into the sandbox is cut, so curl reports "curl: (52) Empty reply from server". On an allowed host that is the boundary working, not the host being down.',
    probe: [
      '# Probe an endpoint that USES the credential, never one that echoes headers.',
      `curl -s -o /dev/null -w '%{http_code}\\n' https://${host}/<authenticated-path>`,
      '# 200 = the header arrived. 401 = it did not.',
    ].join('\n'),
    docsHref: '/docs/project/secrets#verify-it-with-two-probes',
    docsLabel: 'Verify it with two probes',
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
