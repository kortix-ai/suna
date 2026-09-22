import { loadAuth, loadAuthForHost, type Auth } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
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
  hostArg?: string;
  /** The server's verdict reason and action (spec 2026-09-22 §4). Absent on
   *  an older server; the hint then falls back to the manifest remedy. */
  code?: string;
  action?: string;
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
export function recordPermissionDenial(status: number, hostArg?: string, detail?: DenialDetail): void {
  if (status !== 401 && status !== 403) return;
  // Keep the FIRST denial: a command that probes several projects reports the
  // one that actually stopped it, not the last probe to fail.
  if (denial) return;
  denial = {
    status,
    ...(hostArg ? { hostArg } : {}),
    ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
    ...(typeof detail?.action === 'string' ? { action: detail.action } : {}),
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
    case 'agent_scope_insufficient':
      return (
        `add ${actionText} to ${C.cyan}agents.${agent}.kortix_permissions${C.reset}` +
        `${C.dim} in kortix.yaml, then merge${C.reset}`
      );
    default:
      return (
        `add the action to ${C.cyan}agents.${agent}.kortix_permissions${C.reset}` +
        `${C.dim} in kortix.yaml, then merge${C.reset}`
      );
  }
}

/** Test seam — clears state between cases. */
export function resetPermissionDenial(): void {
  denial = null;
}

async function resolveIdentity(auth: Auth): Promise<TokenIdentity | null> {
  const cached = cachedTokenIdentity(auth.token);
  if (cached) return cached;
  try {
    // The client records the identity for us (api/client.ts captureIdentity),
    // so this both answers now and warms the host line for the next command.
    await clientFromAuth(auth).get<MeResponse>('/accounts/me');
  } catch {
    // The token may be dead (401) or the network down. A stale entry still
    // names the agent, which is the point.
    return cachedTokenIdentity(auth.token, { allowStale: true });
  }
  return cachedTokenIdentity(auth.token, { allowStale: true });
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
  const auth = pending.hostArg ? loadAuthForHost(pending.hostArg) : loadAuth();
  if (!auth?.token) return;

  let identity: TokenIdentity | null;
  try {
    identity = await resolveIdentity(auth);
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
