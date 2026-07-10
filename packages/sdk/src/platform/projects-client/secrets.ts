// Secrets — project/shared + personal secret overrides, provider OAuth, git creds.

import { backendApi } from '../api-client';
import { unwrap, type ConnectorSharing, type ProjectGitConnection } from './shared';

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
    /** Omit to leave an existing secret's value untouched (e.g. a no-op touch). */
    value?: string;
  },
) {
  return unwrap(
    await backendApi.post<ProjectSecret>(`/projects/${projectId}/secrets`, input),
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
    await backendApi.post<ProviderOAuthStart>(
      `/projects/${projectId}/oauth/${provider}/start`,
      { sharing: input?.sharing },
    ),
  );
}

export async function pollProjectProviderOAuth(
  projectId: string,
  provider: string,
  flowId: string,
): Promise<ProviderOAuthPoll> {
  return unwrap(
    await backendApi.post<ProviderOAuthPoll>(
      `/projects/${projectId}/oauth/${provider}/poll`,
      { flow_id: flowId },
    ),
  );
}

export async function upsertProjectGitCredential(
  projectId: string,
  input: { token: string },
) {
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
