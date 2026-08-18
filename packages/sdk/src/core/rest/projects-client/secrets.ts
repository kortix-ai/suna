// Secrets — project/shared + personal secret overrides, provider OAuth, git creds.

import { backendApi } from '../../http/api-client';
import { type ConnectorSharing, type ProjectGitConnection, unwrap } from './shared';

export type SecretDeliveryStrategy = 'runtime' | 'egress' | 'broker' | 'denied';
export type SecretConsumer =
  | 'sandbox'
  | 'llm_gateway'
  | 'connector'
  | 'git_proxy'
  | 'http_broker'
  | 'network';
export type SecretDeliveryStatus = 'available' | 'unavailable' | 'disabled';
export type SecretDeliveryBlockedReason = 'no_agent_grant';
export type SecretInjectionSlot =
  | { kind: 'header'; name: string; template?: string }
  | { kind: 'query'; name: string }
  | { kind: 'json_body_field'; path: string };
export interface SecretEgressRule {
  host: string;
  methods?: string[];
  path?: string;
  inject?: SecretInjectionSlot;
}
export interface SecretEgressPolicy {
  backend?: 'llm_gateway' | 'connector' | 'git_proxy' | 'kortix_fetch';
  base_url_env?: string;
  rules: SecretEgressRule[];
  inject: SecretInjectionSlot;
  on_no_match?: 'deny' | 'observe';
  tls?: 'terminate' | 'tunnel';
}
export interface UpdateSecretStrategyOptions {
  consumer?: SecretConsumer | null;
  egress_policy?: SecretEgressPolicy;
  handle_prefix?: string;
}
export interface SecretBrokerRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body_base64?: string;
}
export interface SecretBrokerResponse {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
}

/**
 * One project secret: `{ identifier, name (the env var KEY), value }`.
 * `identifier` is unique per project — the handle an agent's `secrets` grant
 * references and the UI shows. `name` (the KEY) is NOT unique — multiple
 * identifiers may share one (e.g. GMAPS-primary / GMAPS-backup, both
 * GOOGLE_MAPS_API_KEY). Authorization is centralized on the agent grant (by
 * identifier); every project member with read access sees every secret — there
 * is no per-secret member/group sharing and no resource-side agent allow-list.
 */
export interface ProjectSecret {
  /** Unique per project. The handle an agent's `secrets` grant references. */
  identifier: string;
  /** The env var KEY injected into the sandbox. Not unique. */
  name: string;
  project_id: string;
  /** Shared row id; null when only a personal override (or nothing) exists. */
  secret_id: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  system?: boolean;
  readonly?: boolean;
  purpose?: string | null;
  can_rotate?: boolean;
  managed_by?: string | null;
  /** A shared/project value is set. */
  configured: boolean;
  /** My own private override (value never returned), and whether it's active.
   *  Used today only by the CODEX_AUTH_JSON per-user provider login. */
  mine: { active: boolean; updated_at: string } | null;
  /** What actually runs in my sessions for this identifier. */
  effective_source: 'mine' | 'shared' | 'none';
  /** I'm allowed to edit the shared row (project manager). */
  can_manage_shared: boolean;
  /** Stored delivery policy. Optional for compatibility with older servers. */
  strategy?: SecretDeliveryStrategy;
  /** Service that consumes the value. Null when no consumer is configured. */
  consumer?: SecretConsumer | null;
  /** Whether the selected delivery path is usable in this deployment. */
  delivery_status?: SecretDeliveryStatus;
  /** The agent-grant axis of delivery, orthogonal to `delivery_status`. A
   *  secret whose path this deployment fully supports still reaches nothing
   *  when the manifest's agent roster admits no agent for it. Null when some
   *  agent admits it, or when the project has published no roster at all. */
  delivery_blocked_reason?: SecretDeliveryBlockedReason | null;
  /** Whether this project can inject at the network boundary at all — via the
   *  provider edge or the in-guest shim, whichever it has. False makes every
   *  `egress` secret undeliverable however well-formed its policy is, so a
   *  caller rendering `strategy: 'egress'` needs this to explain the state. */
  network_boundary_available?: boolean;
  /** Network policy metadata. The secret value is never present. */
  egress_policy?: SecretEgressPolicy | null;
  strategy_locked?: boolean;
  last_rotated_at?: string | null;
  /** The stored value may have entered an earlier sandbox and must be replaced. */
  requires_rotation?: boolean;
}

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  /** Whether the requesting member can edit shared rows (vs only their own overrides). */
  can_manage?: boolean;
  /** Env keys declared as required in the project's kortix.yaml manifest. */
  required: string[];
  /** Env keys declared as optional in the project's kortix.yaml manifest. */
  optional: string[];
  /**
   * 'loaded'  → kortix.yaml read successfully (env lists are authoritative).
   * 'missing' → manifest file not present in the repo.
   * 'error'   → couldn't fetch/parse the repo (private repo, network, etc.).
   */
  manifest_status?: 'loaded' | 'missing' | 'error';
  /** Path the API tried (defaults to "kortix.yaml" but configurable per project). */
  manifest_path?: string;
  /** Error string when manifest_status === 'error'. */
  manifest_error?: string;
}

export async function listProjectSecrets(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSecretsResponse>(
      `/projects/${projectId}/secrets`,
      // Background read fired from member-visible surfaces (model picker, LLM
      // providers, agent editor) — project.secret.read is editor-tier, so a
      // plain member legitimately 403s here. Callers render their own state.
      { showErrors: false },
    ),
  );
}

export async function upsertProjectSecret(
  projectId: string,
  input: {
    name: string;
    /** Unique per project. Defaults to `name` when omitted (the simple case —
     *  one identifier per key). Set explicitly to create a SECOND secret under
     *  the same key (e.g. "GMAPS-backup" also GOOGLE_MAPS_API_KEY). */
    identifier?: string;
    /** The only service allowed to receive plaintext. */
    consumer?: SecretConsumer | null;
    /** Use `broker` for every server-side consumer. */
    strategy?: SecretDeliveryStrategy;
    /** Required when `consumer` is `http_broker`. */
    egress_policy?: SecretEgressPolicy;
    handle_prefix?: string;
    /** Omit to leave an existing secret's value untouched (e.g. a no-op touch). */
    value?: string;
  },
) {
  return unwrap(await backendApi.post<ProjectSecret>(`/projects/${projectId}/secrets`, input));
}

export async function setProjectSecretStrategy(
  projectId: string,
  identifier: string,
  strategy: SecretDeliveryStrategy,
  options: UpdateSecretStrategyOptions = {},
) {
  return unwrap(
    await backendApi.put<ProjectSecret>(
      `/projects/${projectId}/secrets/${encodeURIComponent(identifier)}/strategy`,
      { strategy, ...options },
    ),
  );
}

export async function brokerProjectSecretRequest(
  projectId: string,
  identifier: string,
  input: SecretBrokerRequest,
): Promise<SecretBrokerResponse> {
  return unwrap(
    await backendApi.post<SecretBrokerResponse>(
      `/projects/${projectId}/secrets/${encodeURIComponent(identifier)}/broker`,
      input,
    ),
  );
}

// ── Provider OAuth device flow (poll-based) ────────────────────────────────
// Connect a subscription-backed provider (e.g. ChatGPT) via a device-code flow.
// `start` returns the challenge; the caller polls `poll` until it resolves.
// Plain JSON requests (no streaming) — survives the edge and any replica.

export interface ProviderOAuthStart {
  flow_id: string;
  verification_url: string;
  user_code: string | null;
  /** Epoch ms when the device code expires. */
  expires_at: number;
  /** Suggested poll cadence. */
  interval_ms: number;
}

export interface ProviderOAuthCredential {
  provider_id: string;
  expires_in_ms: number | null;
  updated_at: string;
}

export type ProviderOAuthPoll =
  | { status: 'pending'; next_poll_ms?: number }
  | { status: 'success'; credential: ProviderOAuthCredential }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

export async function startProjectProviderOAuth(
  projectId: string,
  provider: string,
  input?: { sharing?: ConnectorSharing },
): Promise<ProviderOAuthStart> {
  return unwrap(
    await backendApi.post<ProviderOAuthStart>(`/projects/${projectId}/oauth/${provider}/start`, {
      sharing: input?.sharing,
    }),
  );
}

export async function pollProjectProviderOAuth(
  projectId: string,
  provider: string,
  flowId: string,
): Promise<ProviderOAuthPoll> {
  return unwrap(
    await backendApi.post<ProviderOAuthPoll>(`/projects/${projectId}/oauth/${provider}/poll`, {
      flow_id: flowId,
    }),
  );
}

export async function deleteProjectProviderOAuth(projectId: string, provider: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/oauth/${encodeURIComponent(provider)}`,
    ),
  );
}

export async function upsertProjectGitCredential(projectId: string, input: { token: string }) {
  return unwrap(
    await backendApi.put<{
      configured: boolean;
      provider: string;
      git_connection: ProjectGitConnection;
    }>(`/projects/${projectId}/git-credential`, input),
  );
}

export async function deleteProjectSecret(projectId: string, identifier: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/secrets/${encodeURIComponent(identifier)}`,
    ),
  );
}

/**
 * Set/update the caller's OWN per-key override ("use mine") and/or flip whether
 * it's active. Any project member may call this; it never touches the shared
 * value or anyone else's override.
 */
export async function setPersonalProjectSecret(
  projectId: string,
  name: string,
  input: { value?: string; active?: boolean },
) {
  return unwrap(
    await backendApi.put<ProjectSecret>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}/personal`,
      input,
    ),
  );
}

/** Remove the caller's own override for a key (falls back to the shared value). */
export async function deletePersonalProjectSecret(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}/personal`,
    ),
  );
}
