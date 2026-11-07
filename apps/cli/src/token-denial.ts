import { type Auth } from './api/auth.ts';
import { clientFromAuth, type ApiErrorCredential } from './api/client.ts';
import {
  cachedTokenIdentity,
  formatGrantList,
  tokenKindLabel,
  type TokenIdentity,
} from './api/token-identity.ts';
import type { MeResponse } from './api/types.ts';
import { toLegacyAction, toWorkspaceAction } from '@kortix/shared/workspace-actions';
import { C } from './style.ts';

// ─────────────────────────────────────────────────────────────────────────────
// "Who was refused?"
//
// A permission denial names the ACTION ("project.session.read") but never the
// IDENTITY it was evaluated against. Inside a sandbox that identity is a minted
// agent token, and nothing local names the agent — so the only way to answer
// "which agent am I, and what am I granted?" was to already know to run
// `kortix whoami --token-only`.
//
// So after a 401/403 the CLI answers it unprompted: the token kind, the agent,
// and that agent's `kortix_permissions` grant — which is exactly the list a manifest
// author has to change. One `/accounts/me` at most, and only on the error path.
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedDenial {
  status: number;
  /** The server's verdict reason and action (spec 2026-09-22 §4). Absent on
   *  an older server; the hint then falls back to the manifest remedy. */
  code?: string;
  action?: string;
  /** The credential the refused request carried (host + token, memory only).
   *  The footer resolves the identity FROM it. The active host's identity is a
   *  DIFFERENT credential — inside a sandbox it is the injected session token
   *  — and naming that sent the customer looking at an unrelated token row
   *  (KRTX-1564). Absent only for a refusal recorded before the client could
   *  tag it; the footer then names nothing rather than the wrong credential. */
  credential?: ApiErrorCredential;
}

/** The fields of a 403 body the hint reads. */
export interface DenialDetail {
  code?: string;
  action?: string;
}

let denial: RecordedDenial | null = null;

/** The credential fence refused the route: a workspace-bound credential
 *  (a workspace key, a session or agent token) reached outside its own
 *  workspace, or a route no bound credential may call. No grant fixes it. */
export const CREDENTIAL_FENCE_REFUSED = 'credential_fence_refused';
/** The fence's message tag, on servers before the typed code. */
const FENCE_CHECK_TAG = '[check=token-project-scope:';

/** The session's workspace runs without the project repository. A workspace
 *  policy, not a token scope: no kortix_permissions entry changes it. */
export const SESSION_REPOSITORY_ACCESS_DENIED = 'session_repository_access_denied';
const REPOSITORY_DENIAL_MESSAGE = 'session workspace does not allow repository access';

/**
 * Note that a call was refused. Recorded rather than printed inline because
 * `surfaceApiError` is synchronous and resolving the identity may need a
 * request; the footer is emitted once, from the CLI's async tail.
 */
export function recordPermissionDenial(
  status: number,
  detail?: DenialDetail,
  credential?: ApiErrorCredential,
): void {
  if (status !== 401 && status !== 403) return;
  // Keep the FIRST denial: a command that probes several projects reports the
  // one that actually stopped it, not the last probe to fail.
  if (denial) return;
  denial = {
    status,
    ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
    ...(typeof detail?.action === 'string' ? { action: detail.action } : {}),
    ...(credential ? { credential } : {}),
  };
}

/** Pull `code` / `action` out of an API error body, if it carries them. */
export function denialDetailFromBody(body: unknown): DenialDetail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  // Servers before the typed code send the workspace denial as a bare message.
  const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : '';
  const code =
    typeof record.code === 'string'
      ? record.code
      : message === REPOSITORY_DENIAL_MESSAGE
        ? SESSION_REPOSITORY_ACCESS_DENIED
        : message.includes(FENCE_CHECK_TAG)
          ? CREDENTIAL_FENCE_REFUSED
          : undefined;
  // The workspace name leads (`workspace_action`); `action` is the legacy name.
  const action =
    typeof record.workspace_action === 'string'
      ? record.workspace_action
      : typeof record.action === 'string'
        ? toWorkspaceAction(record.action)
        : undefined;
  return {
    ...(code ? { code } : {}),
    ...(action ? { action } : {}),
  };
}

/**
 * The remedy line for an agent-session denial, chosen by the server's code.
 * Only a grant miss is fixed in kortix.yaml; a ceiling miss is fixed by an
 * admin; a human-only action is not an agent's at all.
 */
/** True when the grant already names `action`, under either spelling. */
export function grantHolds(granted: string[] | 'all' | null | undefined, action: string | undefined): boolean {
  if (!action || granted == null) return false;
  if (granted === 'all') return true;
  const legacy = toLegacyAction(action);
  return granted.some((entry) => entry === '*' || toLegacyAction(entry) === legacy);
}

/** The remedy line for a fence refusal: the credential, never the grant. */
const FENCE_FIX_LINE =
  'this credential is bound to one workspace and this route is outside it; no grant changes that. ' +
  'Run it in that workspace, or ask a person with access to do it';

function agentFixLine(agent: string, pending: RecordedDenial, granted?: string[] | 'all' | null): string {
  const actionText = pending.action ? `${C.cyan}${pending.action}${C.reset}` : 'the action';
  if (pending.code === CREDENTIAL_FENCE_REFUSED) return FENCE_FIX_LINE;
  if ((pending.code === undefined || pending.code === 'agent_scope_insufficient') && grantHolds(granted, pending.action)) {
    // The grant already holds it: kortix.yaml is not the cause.
    return (
      `${actionText} is already granted — the refusal has another cause; read the error above ` +
      `(${C.cyan}kortix whoami --token-only${C.reset} shows this session's permissions)`
    );
  }
  switch (pending.code) {
    case 'agent_ceiling_insufficient':
      return `${actionText} is outside agent ${C.bold}${agent}${C.reset}'s role — ask an admin to raise agent ${agent}'s role`;
    case 'agent_human_only_action':
      return `${actionText} is reserved for people — a human must do this`;
    case 'agent_session_forbidden':
      // A route that refuses every agent session outright (e.g. granting a
      // secret to an agent). No kortix_permissions entry unlocks it.
      return 'agent sessions cannot do this — a person with workspace access must do this';
    case undefined:
    case 'agent_scope_insufficient':
      return (
        `add ${actionText} to ${C.cyan}agents.${agent}.kortix_permissions${C.reset}` +
        `${C.dim} in kortix.yaml, then merge${C.reset}`
      );
    case 'CR_AGENT_GOVERNANCE_CHANGE':
      // Servers before the permissions-only model refuse every agent merge of
      // an agents/triggers change. No grant unlocks it there.
      return 'this server lets only a person merge a change request that changes agents or triggers — ask a person to merge it';
    default:
      // Any other code is not a grant miss: never send the agent to edit
      // kortix.yaml for a refusal no grant can fix.
      return (
        `refused with ${C.cyan}${pending.code}${C.reset} — read the error above; ` +
        `${C.cyan}kortix whoami --token-only${C.reset} shows this session's permissions`
      );
  }
}

/** Test seam — clears state between cases. */
export function resetPermissionDenial(): void {
  denial = null;
}

async function resolveIdentity(credential: ApiErrorCredential): Promise<TokenIdentity | null> {
  // Live first, WITH THE REFUSED CREDENTIAL: the session grant is re-derived
  // on every prompt, so a cached identity can print `granted all` while the
  // server already enforces less.
  const auth: Auth = {
    api_base: credential.host,
    token: credential.token,
    user_id: '',
    user_email: '',
    account_id: '',
    logged_in_at: '',
  };
  try {
    // The client records the identity for us (api/client.ts captureIdentity),
    // so this both answers now and warms the cache for the next command.
    await clientFromAuth(auth).get<MeResponse>('/me');
  } catch {
    // The token may be dead (401) or the network down. A stale entry still
    // names the credential, which is the point.
  }
  return cachedTokenIdentity(credential.token, { allowStale: true });
}

/**
 * Print the acting token's identity after a denial. No-op when nothing was
 * refused, when there is no token, or when the identity cannot be resolved —
 * a diagnostic must never turn into a second error.
 *
 * Writes to stderr so `--json` stdout stays machine-readable.
 */
/**
 * `KORTIX_ERROR_FORMAT=json`: a program reads the CLI (a My Kortix tool in
 * kortixd), so a refusal or a failure is one `{"kortix_error":{…}}` line on
 * stderr instead of the human footer. stdout keeps the command's own output.
 */
export function machineErrors(): boolean {
  return process.env.KORTIX_ERROR_FORMAT === 'json';
}

/** Write one machine-readable error line to stderr. */
export function writeMachineError(error: { kind: 'denied' | 'failed'; message?: string; status?: number; code?: string; action?: string }): void {
  process.stderr.write(`${JSON.stringify({ kortix_error: error })}\n`);
}

/** A validation failure's message with the API's issues after it (`path: message; …`), so a program can fix its input. */
export function withIssues(message: string, body: unknown): string {
  const issues = (body as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return message;
  const lines = issues.slice(0, 5).map((issue) => `${(issue.path ?? []).join('.') || '(body)'}: ${issue.message ?? 'invalid'}`);
  return `${message} (${lines.join('; ')})`;
}

export async function printPermissionDenialIdentity(): Promise<void> {
  const pending = denial;
  denial = null;
  if (!pending) return;
  if (machineErrors()) {
    writeMachineError({
      kind: 'denied',
      status: pending.status,
      ...(pending.code ? { code: pending.code } : {}),
      ...(pending.action ? { action: pending.action } : {}),
    });
    return;
  }
  // No refused credential on the record → nothing this footer can name
  // honestly. The active host's identity belongs to a DIFFERENT credential;
  // printing it here is exactly the KRTX-1564 bug.
  if (!pending.credential) return;

  let identity: TokenIdentity | null;
  try {
    identity = await resolveIdentity(pending.credential);
  } catch {
    return;
  }
  if (!identity) return;

  const lines = [`  ${C.dim}acting as ${C.reset}${C.bold}${tokenKindLabel(identity)}${C.reset}`];
  if (pending.code === SESSION_REPOSITORY_ACCESS_DENIED) {
    // Two layers: the token's scopes allowed the call; the workspace policy refused it.
    if (identity.agent) lines.push(`  ${C.dim}token     ${C.reset}scopes ${formatGrantList(identity.permissions)} (not the cause)`);
    lines.push(`  ${C.dim}workspace ${C.reset}repository access denied: this session runs without the workspace repository`);
    lines.push(`  ${C.dim}fix       ${C.reset}start a session with repository access, or ask a person with workspace access to do this`);
  } else if (identity.agent) {
    lines.push(`  ${C.dim}granted   ${C.reset}${formatGrantList(identity.permissions)}`);
    lines.push(`  ${C.dim}fix       ${C.reset}${agentFixLine(identity.agent, pending, identity.permissions)}`);
  } else {
    if (identity.userEmail) lines.push(`  ${C.dim}user      ${C.reset}${identity.userEmail}`);
    if (pending.code === CREDENTIAL_FENCE_REFUSED) lines.push(`  ${C.dim}fix       ${C.reset}${FENCE_FIX_LINE}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
