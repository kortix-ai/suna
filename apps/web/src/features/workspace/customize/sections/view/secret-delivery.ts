import type {
  AdminConnector,
  SecretConsumer,
  SecretDeliveryStrategy,
  SecretEgressPolicy,
  SecretInjectionSlot,
} from '@kortix/sdk';

import {
  LLM_PROVIDERS,
  type LlmProviderEntry,
  getLlmProviderCatalogRevision,
} from '@/lib/llm-providers';

export type ConnectorBindingOption = {
  slug: string;
  name: string;
  selected: boolean;
  disabled: boolean;
  description: string;
};

/**
 * EXPOSURE — can agent code read this value? The one question a user answers.
 *
 * The page used to ask a different question: pick one of five DELIVERY
 * mechanisms (Sandbox / Network boundary / HTTPS broker / LLM gateway /
 * Connector). That list folded two independent axes into one control
 * (docs/specs/2026-08-19-secrets-exposure-usage-model.md §2): WHO spends the
 * value, and WHETHER the sandbox can read it. `ANTHROPIC_API_KEY` is spent by
 * the LLM gateway AND legitimately by agent code, so no single item on that
 * list described it.
 *
 * The axes are now separate. This one has exactly three values and every one
 * of them is a real answer to "can your code read this value?":
 *
 *  - `enforced`    — no. The sandbox holds a handle; Kortix substitutes the
 *                    real value server-side, only on an approved host.
 *  - `environment` — yes. The plaintext is an env var in the sandbox.
 *  - `disabled`    — nothing is delivered anywhere.
 *
 * "Network boundary" and "HTTPS broker" are gone as user-facing choices. They
 * were two mechanisms for ONE answer (spec §4), and naming both forced the
 * user to pick an implementation.
 */
export type SecretExposure = 'enforced' | 'environment' | 'disabled';

/**
 * USAGE — who spends the value. Assigned, never picked.
 *
 * `agent` is implied by any exposure other than `disabled`. The other three
 * are written by their own flows and are read-only here:
 *
 *  - `llm_gateway` — the LLM providers screen (`provider-connect.tsx`).
 *  - `connector`   — the connector binding, whose own control stays editable.
 *  - `git`         — the git-connection flow (`apps/api/src/projects/lib/git.ts`).
 *
 * Offering any of them in the exposure picker would offer a choice that does
 * not exist, and saving would move the secret off the consumer the assigning
 * flow reads.
 */
export type SecretUsage = 'agent' | 'llm_gateway' | 'connector' | 'git';

/** The stored `strategy` + `consumer` pair one exposure writes (spec §3). */
export function secretExposureTarget(exposure: SecretExposure): {
  strategy: SecretDeliveryStrategy;
  consumer: SecretConsumer | null;
} {
  switch (exposure) {
    case 'environment':
      return { strategy: 'runtime', consumer: 'sandbox' };
    case 'enforced':
      return { strategy: 'egress', consumer: 'network' };
    case 'disabled':
      return { strategy: 'denied', consumer: null };
  }
}

/**
 * Read a stored row back as its exposure (spec §3's read-side mapping).
 *
 * `broker`/`http_broker` reads as `enforced`: the legacy HTTPS-broker row is
 * the same guarantee — the sandbox holds a handle and the value is added
 * outside it. `broker`/`llm_gateway`, `broker`/`connector` and
 * `broker`/`git_proxy` have no sandbox presence at all, which is `disabled`
 * as far as EXPOSURE goes; callers must read `secretUsage` too, and
 * `secretUsageIsAssigned` before opening the picker on such a row.
 */
export function secretExposure(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretExposure {
  if (strategy === 'runtime') return 'environment';
  if (strategy === 'egress') return 'enforced';
  if (strategy === 'denied') return 'disabled';
  return consumer === 'http_broker' ? 'enforced' : 'disabled';
}

/** Who spends this row's value. Null for a row nothing may spend. */
export function secretUsage(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretUsage | null {
  if (strategy === 'denied') return null;
  if (consumer === 'llm_gateway') return 'llm_gateway';
  if (consumer === 'connector') return 'connector';
  if (consumer === 'git_proxy') return 'git';
  return 'agent';
}

/**
 * True when another flow assigned this row's usage and the exposure picker
 * must not be shown.
 *
 * This generalizes the `git_proxy` lock the page already had. The picker
 * writes exactly three `(strategy, consumer)` pairs and none of them is
 * `llm_gateway`, `connector` or `git_proxy`, so rendering it on such a row
 * would silently move the secret off the consumer its owning flow reads —
 * disconnecting a model provider, a connector, or a repository.
 */
export function secretUsageIsAssigned(consumer?: SecretConsumer | null): boolean {
  return consumer === 'llm_gateway' || consumer === 'connector' || consumer === 'git_proxy';
}

/**
 * The `(strategy, consumer)` pair a save writes, given the picked exposure and
 * the row it is editing.
 *
 * Two rows keep the pair they are stored with:
 *
 *  - An **assigned usage** (`secretUsageIsAssigned`). The picker never opened
 *    on it, so there is nothing to write.
 *  - A **legacy HTTPS-broker row** that stays enforced. `kortix secrets call`
 *    addresses it by that pair (spec §4), and its stored policy carries a
 *    `kortix_fetch` backend and possibly a query or JSON-body slot — both of
 *    which `networkBoundaryPolicyError` rejects on an `egress` row, so
 *    rewriting the pair would 400 the save rather than migrate the secret.
 *
 * Everything else writes the pair its exposure names (spec §3).
 */
export function secretDeliveryTarget(
  exposure: SecretExposure,
  row?: { strategy: SecretDeliveryStrategy; consumer: SecretConsumer | null } | null,
): { strategy: SecretDeliveryStrategy; consumer: SecretConsumer | null } {
  if (row && secretUsageIsAssigned(row.consumer)) {
    return { strategy: row.strategy, consumer: row.consumer };
  }
  if (exposure === 'enforced' && row?.strategy === 'broker' && row.consumer === 'http_broker') {
    return { strategy: 'broker', consumer: 'http_broker' };
  }
  return secretExposureTarget(exposure);
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
  tone: 'warning' | 'secondary' | 'info';
};

/**
 * The three exposures, in the order the picker lists them.
 *
 * Order is the argument. `environment` leads because it is the default and the
 * one every project gets: the real value loads into the sandbox as an env var,
 * the mode that needs no setup and works the same on every provider. It is
 * warning-toned everywhere it renders — it is the only value whose plaintext
 * lands in a process the agent can read, an honest label, not an alarm.
 * `enforced` sits second and is an EXPERIMENTAL opt-in behind the
 * `secrets_egress` flag (still in testing): the value never enters the sandbox,
 * Kortix substitutes it outside on an approved host. `disabled` closes the list
 * because it is an off switch, not a delivery mode.
 */
const EXPOSURE_PRESENTATIONS: Record<SecretExposure, SecretDeliveryPresentation> = {
  environment: {
    // The only exposure where agent code can read the value, so the badge is a
    // warning and not a neutral label. `secrets-view.tsx` says the same thing
    // in longhand right below it (`InfoBanner tone="warning"`); the two must
    // agree.
    label: 'Environment variable',
    description: 'The real value is an environment variable agent code and commands can read.',
    tone: 'warning',
  },
  enforced: {
    label: 'Enforce at the network',
    description:
      'The sandbox holds a handle. Kortix substitutes the real value only on requests to the approved hosts.',
    tone: 'secondary',
  },
  disabled: {
    label: 'Disabled',
    // A neutral filled pill, not the near-invisible `outline` treatment whose
    // `bg-accent` (surface-1) sits one hairline off the page surface and reads
    // as bare text. `info` is the design system's neutral badge — a muted fill
    // plus a border in both themes — de-emphasized but unmistakably a pill.
    description: 'Stored securely, but delivered to no session and no Kortix service.',
    tone: 'info',
  },
};

/**
 * The three usages no user can pick, so they live outside the picker's table.
 *
 * Each is written by one flow and read by one consumer. A row that carries one
 * renders this label read-only — see `secretUsageIsAssigned`.
 */
const ASSIGNED_USAGE_PRESENTATIONS: Record<
  Exclude<SecretUsage, 'agent'>,
  SecretDeliveryPresentation
> = {
  llm_gateway: {
    label: 'LLM gateway',
    description: 'Spent by the Kortix model gateway. It never enters the sandbox.',
    tone: 'secondary',
  },
  connector: {
    label: 'Connector',
    description: 'Spent by an authorized connector. It never enters the sandbox.',
    tone: 'secondary',
  },
  git: {
    label: 'Git',
    description: 'Spent for repository access. It never enters the sandbox.',
    tone: 'secondary',
  },
};

export type SecretDeliveryLegendEntry = SecretDeliveryPresentation & {
  /** Stable key for React, and the value the picker writes when `kind` is
   *  `exposure`. */
  key: SecretExposure | Exclude<SecretUsage, 'agent'>;
  kind: 'exposure' | 'usage';
};

/**
 * Every Access value the page can show: the three exposures a user picks,
 * then the three usages another flow assigns.
 *
 * The Secrets page renders this as its "What each Access value means" legend.
 * It reads the same tables the picker and each row's badge read, which is the
 * only reason the three can be trusted to agree.
 *
 * `showEnforced` drops the experimental "Enforce at the network" definition
 * when no row uses it and the `secrets_egress` flag is off — the legend must
 * not explain a value the picker never offers, or the page reintroduces exactly
 * the network-boundary confusion the flag hides.
 */
export function secretDeliveryLegend(showEnforced = true): SecretDeliveryLegendEntry[] {
  return [
    ...(Object.keys(EXPOSURE_PRESENTATIONS) as SecretExposure[])
      .filter((key) => showEnforced || key !== 'enforced')
      .map((key) => ({
        key,
        kind: 'exposure' as const,
        ...EXPOSURE_PRESENTATIONS[key],
      })),
    ...(Object.keys(ASSIGNED_USAGE_PRESENTATIONS) as Exclude<SecretUsage, 'agent'>[]).map(
      (key) => ({
        key,
        kind: 'usage' as const,
        ...ASSIGNED_USAGE_PRESENTATIONS[key],
      }),
    ),
  ];
}

/**
 * The one badge a row shows.
 *
 * An assigned usage wins over the exposure: `broker`/`llm_gateway` is exposure
 * `disabled`, and rendering "Disabled" beside a working provider key would be
 * a lie. Everything else shows its exposure.
 */
export function secretDeliveryPresentation(
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): SecretDeliveryPresentation {
  const usage = secretUsage(strategy, consumer);
  if (usage && usage !== 'agent') return ASSIGNED_USAGE_PRESENTATIONS[usage];
  return EXPOSURE_PRESENTATIONS[secretExposure(strategy, consumer)];
}

/**
 * The value a signing credential shows the user, verbatim (spec §7).
 *
 * A computed secret is an ingredient in a calculation that never travels — an
 * AWS SigV4 access key, an HMAC webhook secret, an SSH or PEM private key.
 * Whoever computes must hold, so no network boundary can help and the value
 * has to be in the environment. Saying that once, at the moment the user
 * pastes it, is the difference between an informed choice and a user who
 * thinks the product failed to protect the key.
 */
export const SIGNING_CREDENTIAL_NOTE =
  'This key signs requests locally; egress enforcement cannot apply.';

export type SecretClassification = {
  /** The exposure the dialog opens on. Never `disabled` — nothing is created
   *  switched off. */
  exposure: Exclude<SecretExposure, 'disabled'>;
  /** Hosts to prefill. Empty unless the catalog names the vendor's API host. */
  hosts: string[];
  /** The catalog provider whose auth env vars include this key, if any. */
  modelProvider: { id: string; label: string } | null;
  /** `SIGNING_CREDENTIAL_NOTE` when the value looks like signing material. */
  signingNote: string | null;
};

/**
 * AWS access-key ids. The prefix set is AWS's own documented list of unique
 * id prefixes; `AKIA` (long-term) and `ASIA` (STS) are the two a user pastes
 * into a secret. 16 uppercase alphanumerics follow, always.
 */
const AWS_ACCESS_KEY_ID = /^(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}$/;
/** PEM blocks — RSA/EC/OPENSSH private keys all carry this header. */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
/** OpenSSH key material pasted without its PEM wrapper, and PuTTY's format. */
const SSH_KEY_MATERIAL = /^(?:ssh-rsa |ssh-ed25519 |ssh-dss |ecdsa-sha2-|PuTTY-User-Key-File)/;

function looksLikeSigningCredential(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    AWS_ACCESS_KEY_ID.test(trimmed) ||
    PEM_PRIVATE_KEY.test(trimmed) ||
    SSH_KEY_MATERIAL.test(trimmed)
  );
}

/**
 * Env var name → catalog provider, rebuilt only when the catalog changes.
 *
 * `LLM_PROVIDER_BY_ENV_VAR` covers the PRIMARY auth method only, so it misses
 * a provider's alias keys (`GEMINI_API_KEY`, `GOOGLE_API_KEY`). Recognition
 * has to accept every env var any method declares, which is the same set the
 * API's own `isGatewayManagedEnv` reads
 * (`apps/api/src/llm-gateway/sandbox-credentials.ts`) — and the same
 * revision-keyed cache, for the same reason: the live catalog fetch replaces
 * `LLM_PROVIDERS` in place.
 */
let cachedCatalogRevision = -1;
let cachedProviderByEnvVar = new Map<string, LlmProviderEntry>();
function providerByEnvVar(): Map<string, LlmProviderEntry> {
  const revision = getLlmProviderCatalogRevision();
  if (revision === cachedCatalogRevision) return cachedProviderByEnvVar;
  const map = new Map<string, LlmProviderEntry>();
  for (const entry of LLM_PROVIDERS) {
    for (const method of entry.authRequirement.methods) {
      for (const envVar of method.envVars) if (!map.has(envVar)) map.set(envVar, entry);
    }
  }
  cachedProviderByEnvVar = map;
  cachedCatalogRevision = revision;
  return map;
}

/**
 * Curated API hosts for providers whose SDK hardcodes the base URL, so
 * models.dev declares no `api` and `LlmProviderEntry.apiHost` is null (24 of
 * 167 today — Anthropic and OpenAI among them). These are stable, documented
 * constants, NOT values derived from a catalog URL; a recognized model key with
 * no catalog host would otherwise leave the hosts field empty and Save disabled
 * until the user typed the host by hand (spec §7). Keyed by catalog provider id.
 */
const WELL_KNOWN_API_HOSTS: Readonly<Record<string, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com',
};

/** The catalog host, or the curated fallback for an SDK-hardcoded provider. */
function providerApiHost(provider: LlmProviderEntry | null): string | null {
  if (!provider) return null;
  return provider.apiHost ?? WELL_KNOWN_API_HOSTS[provider.id] ?? null;
}

/**
 * The system's opening answer for a new secret (spec §7).
 *
 * The user supplies a name and a value; everything else is derived and every
 * derived answer is overridable. Three recognitions, in priority order:
 *
 *  1. **Signing material in the value.** `environment`, with the one sentence
 *     that explains why. This outranks the key name because it is a property
 *     of the credential itself: `AWS_ACCESS_KEY_ID` pasted as an `AKIA…` value
 *     cannot be enforced at any boundary, whatever the catalog says.
 *  2. **A known model key.** `environment`, but the vendor's API host is still
 *     prefilled from the same catalog the LLM providers screen reads (or
 *     `WELL_KNOWN_API_HOSTS` when that provider's SDK hardcodes the URL). The
 *     host waits ready so that a project which has turned ON the experimental
 *     `secrets_egress` flag and switches to enforced does not have to type it.
 *  3. **Everything else.** `environment` with an empty host list.
 *
 * The default is ALWAYS `environment`: the real value loads into the sandbox,
 * the mode that needs no setup and works on every provider. Enforced (network
 * substitution) is an experimental opt-in behind `secrets_egress`; a new secret
 * is never defaulted onto it, so the default never points at an option the
 * picker may not even show.
 */
export function classifyNewSecret(input: { key: string; value: string }): SecretClassification {
  const key = input.key.trim().toUpperCase();
  const provider = key ? (providerByEnvVar().get(key) ?? null) : null;
  const modelProvider = provider ? { id: provider.id, label: provider.label } : null;
  if (looksLikeSigningCredential(input.value)) {
    return {
      exposure: 'environment',
      hosts: [],
      modelProvider,
      signingNote: SIGNING_CREDENTIAL_NOTE,
    };
  }
  const apiHost = providerApiHost(provider);
  return {
    exposure: 'environment',
    hosts: apiHost ? [apiHost] : [],
    modelProvider,
    signingNote: null,
  };
}

/**
 * The exposure the dialog opens with.
 *
 * An existing secret opens on the exposure it has — always, including one the
 * picker does not offer, so the caller can lock the control instead of showing
 * the wrong value (see `secretUsageIsAssigned`).
 *
 * A NEW secret opens on whatever `classifyNewSecret` decided.
 */
export function defaultSecretExposure(
  row: { strategy: SecretDeliveryStrategy; consumer: SecretConsumer | null } | null | undefined,
  classification: SecretClassification,
): SecretExposure {
  if (row) return secretExposure(row.strategy, row.consumer);
  return classification.exposure;
}

export type SecretExposureOption = SecretDeliveryPresentation & {
  exposure: SecretExposure;
};

/**
 * The exposures the user may pick.
 *
 * `environment` and `disabled` are always offered. `enforced` (network
 * substitution) is experimental and appears ONLY when `egressAvailable` — the
 * project has turned on the `secrets_egress` flag, or the row being edited is
 * already enforced (so a legacy/enforced secret stays readable and can be moved
 * off enforcement even after the flag is switched back off). The default is
 * always `environment`, so hiding `enforced` never leaves the picker pointing
 * at an option that is not present.
 */
export function secretExposureOptions(egressAvailable: boolean): SecretExposureOption[] {
  return (Object.keys(EXPOSURE_PRESENTATIONS) as SecretExposure[])
    .filter((exposure) => egressAvailable || exposure !== 'enforced')
    .map((exposure) => ({
      exposure,
      ...EXPOSURE_PRESENTATIONS[exposure],
    }));
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
 * Only an `enforced` row can meaningfully lack an agent grant. It holds a handle
 * in the sandbox, which reaches a session only when a named agent lists the
 * identifier. `environment` reaches every agent with no grant. A `none`-exposure
 * row (LLM gateway, Connector, Git, Disabled) has no sandbox presence at all, so
 * agent-grant guidance never applies to it (spec §3) — even though its stored
 * `strategy` is `broker`, the same value a legacy HTTPS-broker `enforced` row
 * carries. The consumer disambiguates the two.
 */
export function shouldWarnMissingAgentGrant(
  blockedReason: SecretDeliveryBlockedReason | null,
  strategy: SecretDeliveryStrategy,
  consumer?: SecretConsumer | null,
): boolean {
  if (blockedReason !== 'no_agent_grant') return false;
  return secretExposure(strategy, consumer) === 'enforced';
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

const EXACT_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The hosts the textarea declares: lowercased, deduplicated, first-seen order.
 *  The policy and the verification probe both read the list from here, so the
 *  host the user is told to probe is a host the relay actually admits. */
export function parseEnforcedHosts(hosts: string): string[] {
  return [
    ...new Set(
      hosts
        .split(/[\s,]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export type EnforcedPolicyForm = {
  hosts: string;
  /**
   * A LEGACY injection slot this row already carries, preserved verbatim.
   * Null for every row the current UI creates — an inject-less policy is a
   * host list and nothing else (spec §6), and the relay substitutes the
   * handle wherever the agent's own client put it.
   */
  legacyInject?: SecretInjectionSlot | null;
  /** The stored backend a legacy `broker`/`http_broker` row must keep. The API
   *  rejects that consumer without `kortix_fetch`, and rejects any backend at
   *  all on an `egress` row. */
  backend?: SecretEgressPolicy['backend'];
};

/**
 * The policy an enforced secret stores: a host allow-list, `on_no_match: deny`,
 * TLS terminated.
 *
 * No header name, no value template, no method or path filter. Those existed
 * because the boundary had to be TOLD where to write the credential; with
 * substitution the agent's own request already carries the handle in the right
 * place, so there is nothing left to name — and the 401-from-a-bad-template
 * failure mode ceases to exist for new rows (spec §6).
 *
 * A stored `legacyInject` rides through untouched: `networkBoundaryPolicyError`
 * still accepts it and the broker still applies it, so an unrelated save (a
 * value rotation, a host added) must not silently stop a working injection.
 */
export function buildEnforcedPolicy(form: EnforcedPolicyForm): SecretEgressPolicy | null {
  const hosts = parseEnforcedHosts(form.hosts);
  if (hosts.length === 0 || hosts.some((host) => !EXACT_HOST.test(host))) return null;
  return {
    ...(form.backend ? { backend: form.backend } : {}),
    rules: hosts.map((host) => ({ host })),
    ...(form.legacyInject ? { inject: form.legacyInject } : {}),
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

export type LegacyInjectionDetail = {
  title: string;
  body: string;
  /** One `label: value` line per stored field, in a fixed order. */
  lines: string[];
};

/**
 * What a legacy row's stored injection actually does, read-only.
 *
 * These rows predate substitution. The header name and value template are no
 * longer editable — they are not part of the shape a new secret can have — but
 * hiding them entirely would leave an author unable to see why their request
 * carries a header they never configured here.
 */
export function legacyInjectionDetail(
  policy: SecretEgressPolicy | null | undefined,
): LegacyInjectionDetail | null {
  const inject = policy?.inject;
  if (!inject) return null;
  const lines: string[] = [];
  if (inject.kind === 'header') {
    lines.push(`Header: ${inject.name}`);
    lines.push(`Value: ${inject.template ?? '{{secret}}'}`);
  } else if (inject.kind === 'query') {
    lines.push(`Query parameter: ${inject.name}`);
  } else {
    lines.push(`JSON body field: ${inject.path}`);
  }
  const methods = policy?.rules.find((rule) => rule.methods?.length)?.methods;
  if (methods?.length) lines.push(`Methods: ${methods.join(', ')}`);
  const path = policy?.rules.find((rule) => rule.path)?.path;
  if (path) lines.push(`Path: ${path}`);
  return {
    title: 'This secret still writes a fixed slot',
    body: 'It was created before Kortix substituted handles in place. Kortix keeps writing the slot below exactly as it does today. Remove it to serve the secret by substitution instead — the approved hosts stay the same.',
    lines,
  };
}

export type SecretEchoNotice = {
  title: string;
  /** The symptom, then what it actually means. */
  body: string;
  /** The shell probe that separates a working policy from a missing credential. */
  probe: string;
  docsHref: string;
  docsLabel: string;
};

/**
 * The one thing about this exposure nobody can deduce from inside the sandbox:
 * what a WORKING policy looks like when the upstream echoes the credential
 * back.
 *
 * There is one answer now. The relay returns an ordinary response with
 * `[REDACTED]` in place of the value (`redactSecretFromResponse`,
 * apps/api/src/secrets/http-broker.ts), on every sandbox provider. The
 * provider-edge story — a cut connection that reads as `curl: (52) Empty reply
 * from server` — described a mechanism that no longer serves any project, and
 * telling a user to expect it made a working request look broken.
 *
 * The probe names the first declared host so it can be run as-is; with no host
 * typed yet it falls back to a placeholder rather than an empty URL.
 */
export function enforcedEchoNotice(hosts: string): SecretEchoNotice {
  const host = parseEnforcedHosts(hosts)[0] ?? 'api.example.com';
  return {
    title: 'A blocked echo comes back as [REDACTED]',
    body: 'A response that would carry this value back into the sandbox comes back with [REDACTED] in its place, so an ordinary 200 is the policy working. An empty reply or a connection error on an approved host is a real failure, not the policy doing its job.',
    probe: [
      '# Probe an endpoint that USES the credential, never one that echoes headers.',
      `curl -s -o /dev/null -w '%{http_code}\\n' https://${host}/<authenticated-path>`,
      '# 200 = the real value was substituted. 401 = it was not.',
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
  enforcedPolicyValid: boolean;
  selectedConnectorCount?: number;
}): boolean {
  const hasValue = Boolean(input.value.trim());
  if (!input.isEdit && !input.key.trim()) return false;
  if (input.requiresValue && !hasValue) return false;
  if (input.nextStrategy === 'runtime' && input.requiresRotation && !hasValue) return false;
  // Both shapes that hold a host allow-list: a new `egress`/`network` row, and
  // a legacy `broker`/`http_broker` row the dialog keeps on its stored pair.
  if (
    (input.nextStrategy === 'egress' ||
      (input.nextStrategy === 'broker' && input.nextConsumer === 'http_broker')) &&
    !input.enforcedPolicyValid
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
