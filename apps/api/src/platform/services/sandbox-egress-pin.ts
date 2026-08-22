/**
 * Binding a session's credential to the sandbox it was issued for.
 *
 * ## The exposure this closes
 *
 * `KORTIX_CLI_TOKEN` is in the agent's own shell environment (the CLI, git push
 * and CR-merge all need it — see agent-env-file.ts SHELL_SESSION_CREDS). It is
 * also the token the in-guest egress shim authenticates to the broker with. An
 * agent can therefore copy it out of its own env and send it anywhere, and the
 * recipient could spend the project's network-boundary secrets against the
 * allow-listed hosts for as long as the session runs.
 *
 * The credential itself was never readable — the boundary design keeps the
 * VALUE outside the guest, and that holds. This is about the token that SPENDS
 * it being usable from somewhere the sandbox is not.
 *
 * ## Why an IP pin, and why this one
 *
 * The obvious alternative — an egress allow-list restricting the sandbox to
 * Kortix — was measured and rejected: both dev-api and api.kortix.com are
 * Cloudflare-fronted (AS13335, and the SAME anycast addresses), so pinning them
 * by CIDR means trusting 1,524,736 addresses that front a large share of the
 * internet. An agent would exfiltrate through a Cloudflare Worker and the
 * control would have bought nothing, while breaking git, npm and pip.
 *
 * Measured instead (two Daytona sandboxes, personal account, 2026-08-14):
 *
 *     sandbox c6009f9d → 67.213.121.131 , 67.213.121.131
 *     sandbox 004f74dc → 67.213.113.135 , 67.213.113.135
 *
 * Each sandbox has its OWN egress address, stable across calls. So "is this
 * request coming from the sandbox the token was issued to" is answerable.
 *
 * ## Pinned at BOOT, not on first use
 *
 * The pin is recorded when the daemon relays its boot timeline — a daemon→API
 * call authenticated with the SANDBOX credential, made before the agent runs.
 * Trust-on-first-use would instead let whoever calls first set the pin, and an
 * attacker who exfiltrated the token during provisioning could pin themselves
 * and lock the sandbox out of its own secrets.
 *
 * ## Fails OPEN when unpinned, on purpose
 *
 * A session with no recorded address is allowed. Sandboxes provisioned before
 * this shipped have none, and a boot-timeline relay that never landed would
 * otherwise take a working session's secrets away with a 403 nobody could
 * diagnose. The mismatch case — a pin exists and does not match — is the one
 * that blocks, and it is the one that means what it says.
 */
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';

/** Where the pin lives on `session_sandboxes.metadata`. Stable storage detail. */
export const EGRESS_IP_KEY = 'egress_ip';

/**
 * The caller's address as this deployment sees it.
 *
 * `cf-connecting-ip` is read FIRST because the edge OVERWRITES it on every
 * request. `x-forwarded-for` is not overwritten — Cloudflare appends to what
 * the client sent, so its first hop is attacker-controlled. A caller who
 * exfiltrated a session token can therefore set `x-forwarded-for` to the pinned
 * sandbox address and replay the token from anywhere; they cannot forge
 * `cf-connecting-ip`. The xff/x-real-ip fallback stays for deployments that do
 * not sit behind Cloudflare.
 */
export function requestEgressIp(c: Context): string | null {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = c.req.header('x-forwarded-for');
  const first = xff ? xff.split(',')[0]?.trim() : undefined;
  return first || c.req.header('x-real-ip')?.trim() || null;
}

/**
 * Record the sandbox's egress address, once.
 *
 * First write wins: re-pinning on every daemon callback would let a later call
 * move the pin, which is exactly the property the boot-time pin exists to deny.
 */
export async function pinSandboxEgressIp(sandboxId: string, ip: string | null): Promise<void> {
  if (!ip) return;
  const [row] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .limit(1);
  if (!row) return;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata[EGRESS_IP_KEY] === 'string' && metadata[EGRESS_IP_KEY]) return;
  await db
    .update(sessionSandboxes)
    .set({ metadata: { ...metadata, [EGRESS_IP_KEY]: ip } })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

export type EgressPinVerdict =
  /** No pin recorded — allowed, see the fail-open note above. */
  | { ok: true; reason: 'unpinned' }
  | { ok: true; reason: 'match'; ip: string }
  /** A pin exists and the caller is somewhere else. */
  | { ok: false; reason: 'mismatch'; pinned: string; seen: string | null };

/**
 * Is this request coming from the sandbox the session was issued to?
 *
 * Looked up by SESSION rather than handed a sandbox id, because the caller that
 * needs this (the secret-broker route) authenticates a session token and has no
 * sandbox id of its own — and resolving it here keeps the two from drifting.
 */
export async function verifySandboxEgressIp(
  sessionId: string,
  seen: string | null,
): Promise<EgressPinVerdict> {
  const [row] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.sessionId, sessionId)))
    .limit(1);
  const pinned = ((row?.metadata ?? {}) as Record<string, unknown>)[EGRESS_IP_KEY];
  if (typeof pinned !== 'string' || !pinned) return { ok: true, reason: 'unpinned' };
  if (seen && seen === pinned) return { ok: true, reason: 'match', ip: pinned };
  return { ok: false, reason: 'mismatch', pinned, seen };
}
