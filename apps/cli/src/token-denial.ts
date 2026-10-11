import { type Auth } from './api/auth.ts';
import { clientFromAuth, type ApiErrorCredential } from './api/client.ts';
import {
  cachedTokenIdentity,
  formatGrantList,
  tokenKindLabel,
  type TokenIdentity,
} from './api/token-identity.ts';
import type { MeResponse } from './api/types.ts';
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
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.action === 'string' ? { action: record.action } : {}),
  };
}

/**
 * The remedy line for an agent-session denial, chosen by the server's code.
 * Only a grant miss is fixed in kortix.yaml; a ceiling miss is fixed by an
 * admin; a human-only action is not an agent's at all.
 */
function agentFixLine(agent: string, pending: RecordedDenial): string {
  const actionText = pending.action ? `${C.cyan}${pending.action}${C.reset}` : 'the action';
  switch (pending.code) {
    case 'agent_ceiling_insufficient':
      return `${actionText} is outside agent ${C.bold}${agent}${C.reset}'s role — ask an admin to raise agent ${agent}'s role`;
    case 'agent_human_only_action':
      return `${actionText} is reserved for people — a human must do this`;
    case 'agent_session_forbidden':
      // A route that refuses every agent session outright (e.g. granting a
      // secret to an agent). No kortix_permissions entry unlocks it.
      return 'agent sessions cannot do this — a person with project access must do this';
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
    await clientFromAuth(auth).get<MeResponse>('/accounts/me');
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
export async function printPermissionDenialIdentity(): Promise<void> {
  const pending = denial;
  denial = null;
  if (!pending) return;
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
  if (identity.agent) {
    lines.push(`  ${C.dim}granted   ${C.reset}${formatGrantList(identity.permissions)}`);
    lines.push(`  ${C.dim}fix       ${C.reset}${agentFixLine(identity.agent, pending)}`);
  } else if (identity.userEmail) {
    lines.push(`  ${C.dim}user      ${C.reset}${identity.userEmail}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
