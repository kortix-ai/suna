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

/**
 * One Access value, as the picker offers it.
 *
 * The stored shape is two columns — `strategy` and `consumer` — and the
 * picker used to make the user fill them in two steps: pick "Delivery", then
 * for "Kortix service" pick "Used by". "Kortix service" was a UX grouping
 * over three unrelated mechanisms (LLM gateway, HTTPS broker, Connector), not
 * a delivery mechanism itself, and it forced a second screen to express a
 * single choice. There are five mechanisms and the user picks exactly one, so
 * there is exactly one control.
 *
 * `git_proxy` is deliberately NOT here. It is assigned by the git-connection
 * flow (apps/api/src/projects/lib/git.ts) and nothing else ever writes it, so
 * offering it as a sixth option would be offering a choice that does not
 * exist. It still has a label and description for the rows that carry it —
 * see `secretAccessIsSystemManaged` and `secretDeliveryPresentation`.
 */
export type SecretAccessChoice =
  | 'sandbox'
  | 'network_boundary'
  | 'http_broker'
  | 'llm_gateway'
  | 'connector'
  | 'disabled';

/**
 * The two things an Access value can be for.
 *
 * `agent` — the value serves code the project runs. Either it is IN the
 * process (Sandbox) or it is attached to that code's outbound request and
 * never in the process at all (Network boundary, HTTPS broker).
 *
 * `service` — the value serves a first-party Kortix service. The project's
 * own code never touches it.
 *
 * This is ORDER and copy, not a second decision: grouping the list is what
 * makes five flat options readable, and it costs the user no extra click.
 */
export type SecretAccessGroup = 'agent' | 'service' | 'none';

export const SECRET_ACCESS_GROUP_LABEL: Record<SecretAccessGroup, string | null> = {
  agent: "For your agent's own code",
  service: 'For a Kortix service',
  none: null,
};

/** The stored `strategy` + `consumer` pair one choice writes. */
export function secretAccessTarget(choice: SecretAccessChoice): {
  strategy: SecretDeliveryStrategy;
  consumer: SecretConsumer | null;
} {
  switch (choice) {
    case 'sandbox':
      return { strategy: 'runtime', consumer: 'sandbox' };
    case 'network_boundary':
      return { strategy: 'egress', consumer: 'network' };
    case 'http_broker':
      return { strategy: 'broker', consumer: 'http_broker' };
    case 'llm_gateway':
      return { strategy: 'broker', consumer: 'llm_gateway' };
    case 'connector':
      return { strategy: 'broker', consumer: 'connector' };
    case 'disabled':
      return { strategy: 'denied', consumer: null };
  }
}

/**
 * Read a stored row back into the one value the picker shows.
 *
 * A `git_proxy` row resolves to `http_broker` here ON PURPOSE ONLY as a
 * last-resort fallback: callers must check `secretAccessIsSystemManaged`
 * first and never open the picker on such a row, because silently
 * re-labelling a git-assigned secret as an HTTPS-broker secret would rewrite
 * its consumer on the next save.
 */
export function secretAccessChoice(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretAccessChoice {
  if (strategy === 'runtime') return 'sandbox';
  if (strategy === 'egress') return 'network_boundary';
  if (strategy === 'denied') return 'disabled';
  if (consumer === 'llm_gateway') return 'llm_gateway';
  if (consumer === 'connector') return 'connector';
  return 'http_broker';
}

/**
 * True when Kortix assigned this row's Access and a human may not reassign
 * it.
 *
 * Only the git-connection flow produces one. The picker has no `git_proxy`
 * option, so an edit dialog opened on such a row would offer five values none
 * of which is the one it has — and saving would move the secret off the
 * consumer the git connection depends on.
 */
export function secretAccessIsSystemManaged(consumer?: SecretConsumer | null): boolean {
  return consumer === 'git_proxy';
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
  const currentlyBound = new Set<string>();
  for (const connector of connectors) {
    if (connector.secretIdentifier === secretIdentifier) currentlyBound.add(connector.slug);
  }
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

/**
 * The five pickable mechanisms, in the order the picker lists them.
 *
 * Order is the argument. Sandbox and Network boundary sit adjacent because
 * they are the real either/or for one question — does the value go INTO the
 * process, or does it only ever attach to that process's outbound request.
 * The HTTPS broker closes that group as the policy-shaped version of the same
 * idea. LLM gateway and Connector follow as a separate group: Kortix plumbing
 * the project's code never interacts with, not a variant of the boundary.
 *
 * Wording is unchanged from the strategy-keyed table this replaces — only the
 * key and the grouping are new — so every existing badge and sentence still
 * reads exactly the same.
 */
const ACCESS_PRESENTATIONS: Record<
  SecretAccessChoice,
  SecretDeliveryPresentation & { group: SecretAccessGroup }
> = {
  sandbox: {
    // The only mode where agent code can read the value, so the badge is a
    // warning and not a neutral label. `secrets-view.tsx` says the same thing
    // in longhand right below it (`InfoBanner tone="warning"`, "Readable
    // inside the sandbox"); the two must agree.
    label: 'Sandbox',
    description: 'Available to agent code and commands as an environment variable.',
    tone: 'warning',
    group: 'agent',
  },
  network_boundary: {
    label: 'Network boundary',
    description: 'Added to approved outbound requests at the network boundary.',
    tone: 'secondary',
    group: 'agent',
  },
  http_broker: {
    label: 'HTTPS broker',
    description: 'Added only to an approved HTTPS request outside the sandbox.',
    tone: 'secondary',
    group: 'agent',
  },
  llm_gateway: {
    label: 'LLM gateway',
    description: 'Used for model requests without entering the sandbox.',
    tone: 'secondary',
    group: 'service',
  },
  connector: {
    label: 'Connector',
    description: 'Used by an authorized connector without entering the sandbox.',
    tone: 'secondary',
    group: 'service',
  },
  disabled: {
    label: 'Disabled',
    description: 'Stored securely, but unavailable to sessions and Kortix services.',
    tone: 'outline',
    group: 'none',
  },
};

/**
 * The one Access value no user can pick, so it lives outside the picker's
 * table. Wording unchanged from the `git_proxy` branch this replaces.
 */
const GIT_SERVICE_PRESENTATION: SecretDeliveryPresentation = {
  label: 'Git service',
  description: 'Used for repository access without entering the sandbox.',
  tone: 'secondary',
};

export type SecretDeliveryLegendEntry = SecretDeliveryPresentation & {
  choice: SecretAccessChoice;
  group: SecretAccessGroup;
};

/**
 * Every Access value the page can show, in picker order.
 *
 * The Secrets page renders this as its "What each Access value means" legend.
 * It reads the same table the picker and each row's badge read, which is the
 * only reason the three can be trusted to agree.
 */
export function secretDeliveryLegend(): SecretDeliveryLegendEntry[] {
  return (Object.keys(ACCESS_PRESENTATIONS) as SecretAccessChoice[]).map((choice) => ({
    choice,
    ...ACCESS_PRESENTATIONS[choice],
  }));
}

export function secretDeliveryPresentation(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretDeliveryPresentation {
  if (secretAccessIsSystemManaged(consumer)) return GIT_SERVICE_PRESENTATION;
  const { group: _group, ...presentation } =
    ACCESS_PRESENTATIONS[secretAccessChoice(strategy, consumer)];
  return presentation;
}

export type NetworkBoundaryAvailability = 'available' | 'project_not_pinned' | 'unsupported';

/** The slice of project detail the boundary questions read. Structural, because
 *  a capability-filtered response omits fields the SDK type declares. */
export type NetworkBoundaryProject = {
  available_sandbox_providers?: readonly string[] | null;
  default_sandbox_provider?: string | null;
  experimental?: Partial<Record<string, boolean>> | null;
};

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
  project?: NetworkBoundaryProject | null,
): NetworkBoundaryAvailability {
  if (project?.experimental?.network_boundary_shim) return 'available';
  if (!project?.available_sandbox_providers?.includes('platinum')) return 'unsupported';
  return project.default_sandbox_provider === 'platinum' ? 'available' : 'project_not_pinned';
}

export type NetworkBoundaryMode = 'provider-edge' | 'in-guest-shim';

/**
 * WHICH mechanism serves this project, not merely whether one does.
 *
 * Mirrors `networkBoundaryMode` in
 * apps/api/src/secrets/network-boundary-availability.ts, including its
 * precedence: the provider edge wins where it exists, because it needs nothing
 * in the guest and injects for every client in the sandbox. The deployment-wide
 * `config.isPlatinumEnabled()` half of that check reads here as Platinum being
 * among the project's offered providers.
 *
 * Availability alone is not enough to write copy with: the two mechanisms
 * produce OPPOSITE symptoms for the same working request, so a panel that knows
 * only "yes" describes half the projects wrongly.
 */
export function networkBoundaryMode(
  project?: NetworkBoundaryProject | null,
): NetworkBoundaryMode | null {
  if (
    project?.available_sandbox_providers?.includes('platinum') &&
    project.default_sandbox_provider === 'platinum'
  ) {
    return 'provider-edge';
  }
  return project?.experimental?.network_boundary_shim ? 'in-guest-shim' : null;
}

/** The flag's name in Feature flags → Experimental, quoted so the sentences
 *  below point at something the user can actually find. Must match the
 *  `network_boundary_shim` entry in the API's feature-flag registry, which is
 *  what that screen renders. */
const SHIM_FLAG = 'Network boundary in-guest shim';

/**
 * Why network-boundary delivery cannot run here, and how to fix it. Both states
 * are now fixable, so neither says "not available".
 *
 * The flag leads in both. A project on a provider with no credential edge is
 * one opt-in away from a working boundary, whereas re-pinning it to Platinum
 * moves every session in the project onto another provider to solve a
 * per-secret problem.
 */
export function networkBoundaryBlockedReason(
  availability: NetworkBoundaryAvailability,
): string | null {
  if (availability === 'available') return null;
  if (availability === 'unsupported') {
    return `Turn on "${SHIM_FLAG}" in Feature flags → Experimental.`;
  }
  return `Turn on "${SHIM_FLAG}" in Feature flags → Experimental, or pin this project to Platinum in Feature flags → Runtime → Sandbox provider.`;
}

/**
 * The Access value the dialog opens with.
 *
 * An existing secret opens on the value it has — always, including a value
 * the picker does not offer, so the caller can lock the control instead of
 * showing the wrong one (see `secretAccessIsSystemManaged`).
 *
 * A NEW secret defaults to Network boundary wherever the project can deliver
 * it, and to Sandbox everywhere else. Sandbox is the only value whose
 * plaintext lands in a process the agent can read, so it is the one that
 * should be chosen on purpose rather than by default.
 */
export function defaultSecretAccess(
  row: { strategy: SecretDeliveryStrategy; consumer: SecretConsumer | null } | null | undefined,
  networkBoundary: NetworkBoundaryAvailability,
): SecretAccessChoice {
  if (row) return secretAccessChoice(row.strategy, row.consumer);
  return networkBoundary === 'available' ? 'network_boundary' : 'sandbox';
}

export type SecretDeliveryOption = SecretDeliveryPresentation & {
  choice: SecretAccessChoice;
  group: SecretAccessGroup;
  disabled: boolean;
  /** Why the option cannot be selected. Null when it can. */
  disabledReason: string | null;
};

/**
 * Every Access value the user may pick, flat and in one list.
 *
 * `selected` is the value the dialog currently holds. It matters for exactly
 * one case: a broker row whose backing service reports itself unavailable
 * stays visible and disabled rather than vanishing, so the user can see what
 * the secret is set to.
 */
export function secretDeliveryOptions(
  selected: SecretAccessChoice,
  status: SecretDeliveryStatus,
  networkBoundary: NetworkBoundaryAvailability,
): SecretDeliveryOption[] {
  const choices = Object.keys(ACCESS_PRESENTATIONS) as SecretAccessChoice[];
  return choices.map((choice) => {
    const presentation = ACCESS_PRESENTATIONS[choice];
    const isBroker = secretAccessTarget(choice).strategy === 'broker';
    const disabledReason =
      choice === 'network_boundary'
        ? networkBoundaryBlockedReason(networkBoundary)
        : isBroker && choice === selected && status !== 'available'
          ? 'Not available in this deployment.'
          : null;
    return {
      choice,
      ...presentation,
      disabled: disabledReason !== null,
      disabledReason,
    };
  });
}

export type SecretDeliveryOptionGroup = {
  group: SecretAccessGroup;
  /** Null for the group that gets no heading. */
  label: string | null;
  options: SecretDeliveryOption[];
};

/**
 * The same flat list, bucketed for rendering.
 *
 * Radix requires a `SelectLabel` to sit inside a `SelectGroup`, so the picker
 * cannot emit a heading as a loose sibling between items — it throws
 * "`SelectLabel` must be used within `SelectGroup`" and takes the page down
 * with it. Grouping is therefore computed here rather than reconstructed in
 * JSX, and the order within each group is the order `secretDeliveryOptions`
 * produced.
 */
export function secretDeliveryOptionGroups(
  options: readonly SecretDeliveryOption[],
): SecretDeliveryOptionGroup[] {
  const groups: SecretDeliveryOptionGroup[] = [];
  for (const option of options) {
    const current = groups[groups.length - 1];
    if (current && current.group === option.group) {
      current.options.push(option);
      continue;
    }
    groups.push({
      group: option.group,
      label: SECRET_ACCESS_GROUP_LABEL[option.group],
      options: [option],
    });
  }
  return groups;
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
 * The one thing about this mode nobody can deduce from inside the sandbox: what
 * a WORKING boundary looks like when the upstream echoes the credential back.
 *
 * The two mechanisms answer that oppositely, which is why the mode is a
 * required argument rather than a default. The provider edge cuts the response,
 * so an echo endpoint answers `curl: (52) Empty reply from server` —
 * byte-identical to a dead host, and an agent with nothing else to go on
 * invents a network explanation for it. The in-guest shim relays through the
 * broker instead and returns an ordinary 200 with `[REDACTED]` in place of the
 * value; showing the edge's symptom there makes a working boundary look broken,
 * and a genuinely dead host look like success. The agent is told exactly one of
 * these two stories (apps/api/src/projects/secret-capabilities.ts), so the panel
 * that configures the mode has to tell the user the same one.
 *
 * The probe is shared: under both mechanisms an endpoint that SPENDS the
 * credential answers 200 or 401, which is what makes it the one worth pasting.
 * It names the first declared host so it can be run as-is; with no host typed
 * yet it falls back to a placeholder rather than an empty URL.
 */
export function networkBoundaryEchoNotice(
  hosts: string,
  mode: NetworkBoundaryMode,
): NetworkBoundaryEchoNotice {
  const host = parseBoundaryHosts(hosts)[0] ?? 'api.example.com';
  return {
    title:
      mode === 'in-guest-shim'
        ? 'A blocked echo comes back as [REDACTED]'
        : 'A blocked echo looks exactly like a dead host',
    body:
      mode === 'in-guest-shim'
        ? 'A response that would carry this value back into the sandbox comes back with [REDACTED] in its place, so an ordinary 200 is the boundary working. An empty reply or a connection error on an allowed host is a real failure here, not the boundary doing its job.'
        : 'A response that would carry this value back into the sandbox is cut, so curl reports "curl: (52) Empty reply from server". On an allowed host that is the boundary working, not the host being down.',
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
