// Agent-minted SETUP LINKS — short-lived links the in-sandbox agent mints so
// a human can (a) enter a workspace secret VALUE, or (b) 1-click connect a
// Pipedream app, without the agent ever seeing the value/credential itself.
// See apps/api/src/workspaces/routes/setup-links.ts for the server-side handlers.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface RequestWorkspaceSecretInput {
  /** One or more env var names to request (A-Z, 0-9, _; max 64 chars each). */
  names: string[];
  /** Optional per-name display label, keyed by name. */
  labels?: Record<string, string>;
  /** Optional per-name description, keyed by name. */
  descriptions?: Record<string, string>;
  /** `'runtime'` (workspace secret, default) or `'connector'` (connector credential). */
  scope?: 'runtime' | 'connector';
  expiresInMinutes?: number;
}

export interface SecretRequestLink {
  kind: 'secret';
  url: string;
  names: string[];
  scope: 'runtime' | 'connector';
  expires_at: string;
}

/** Mint a link a human opens to enter one or more secret values. */
export async function requestWorkspaceSecret(
  workspaceId: string,
  input: RequestWorkspaceSecretInput,
): Promise<SecretRequestLink> {
  return unwrap(
    await backendApi.post<SecretRequestLink>(`/workspaces/${workspaceId}/secret-requests`, {
      names: input.names,
      labels: input.labels,
      descriptions: input.descriptions,
      scope: input.scope,
      expires_in_minutes: input.expiresInMinutes,
    }),
    'Failed to mint secret-entry link',
  );
}

export interface RequestWorkspaceConnectorInput {
  /** The Pipedream connector slug (already declared in kortix.yaml). */
  slug: string;
  expiresInMinutes?: number;
}

export interface ConnectorRequestLink {
  kind: 'connector';
  url: string;
  slug: string;
  app: string;
  expires_at: string;
}

/** Mint a link a human opens to 1-click connect a Pipedream app (Quick Connect). */
export async function requestWorkspaceConnector(
  workspaceId: string,
  input: RequestWorkspaceConnectorInput,
): Promise<ConnectorRequestLink> {
  return unwrap(
    await backendApi.post<ConnectorRequestLink>(`/workspaces/${workspaceId}/connect-requests`, {
      slug: input.slug,
      expires_in_minutes: input.expiresInMinutes,
    }),
    'Failed to mint connect link',
  );
}

/** What a human is being asked to approve, behind an approval link. */
export interface ApprovalLinkDetails {
  kind: 'approval';
  workspace_id: string;
  workspace_name: string;
  execution_id: string;
  session_id: string | null;
  /** Fully-qualified tool path, e.g. `gmail.send_email`. */
  action: string;
  connector: string | null;
  /** read | write | destructive | null */
  risk: string | null;
  status: string;
  /** False once resolved (or expired) — render the outcome, not buttons. */
  pending: boolean;
  /**
   * REDACTED arguments the call would run with — the answer to "where is this
   * actually going?". Credential-shaped fields are replaced server-side and
   * never leave the API.
   */
  args_preview: Record<string, unknown> | null;
  /** False when the API could not preserve every non-secret argument in the preview. */
  review_complete?: boolean;
  /** One-line rendering of the fields that identify the target. */
  args_summary: string | null;
  policy_source: string | null;
  requested_at: string;
  resolved_at: string | null;
  expires_at: string;
}

/**
 * Read a pending approval by its link token.
 *
 * REQUIRES A SIGNED-IN, AUTHORISED ACCOUNT: unlike the secret/connect links
 * above, the token is only a pointer to which decision is being asked for — it
 * carries no authority to make it. 401 = sign in; 403 = signed in but not a
 * manager/launcher on that workspace.
 */
export async function getApprovalLink(token: string): Promise<ApprovalLinkDetails> {
  return unwrap(
    await backendApi.get<ApprovalLinkDetails>(`/approval-links/${token}`),
    'Failed to load approval',
  );
}
