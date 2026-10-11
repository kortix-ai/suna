// Access on a paired computer, as the machine reports it and as its owner
// changes it through Kortix. The machine decides: its agent applies a
// narrowing at once and asks the owner on the computer before it widens
// access (contract v2 §A). Kortix stores only the agent's signed report, at
// `machine_info.access`.

import { TunnelErrorCode, TunnelRelayError } from 'agent-tunnel';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { isTunnelConnectionLive, relayRpcToConnectedAgent } from './core/cluster-forwarder';

type AccessMode = 'ask' | 'always' | 'off';
const MODES: readonly AccessMode[] = ['ask', 'always', 'off'];

/** One owner action (agent-tunnel `AccessChange`). */
export interface ComputerAccessChange {
  mode?: AccessMode;
  grantMinutes?: number;
  revoke?: boolean;
  deny?: boolean;
  keepAwake?: boolean;
}

/** `machine_info.access`: the agent's report. Agents before 0.1.4 send only `mode` and `grantedUntil`. */
export interface ReportedComputerAccess {
  mode: AccessMode;
  grantedUntil: string | null;
  deniedUntil?: string | null;
  keepAwake?: boolean;
  keepAwakeSupported?: boolean;
  pendingRequest?: { capability: string; requestedAt: string; change?: ComputerAccessChange } | null;
  desktopPermissions?: { accessibility: boolean; screenRecording: boolean } | null;
}

/** How long a machine holds a relayed change for its owner (agent-tunnel ACCESS_HOLD_MS). */
const ACCESS_HOLD_MS = 20_000;
/** A request is shown this long (agent-tunnel REQUEST_FRESH_MS). */
const REQUEST_FRESH_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

function isoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** A change from a request body or a report: only known fields, each with its type. Null if anything is wrong. */
export function parseAccessChange(value: unknown): ComputerAccessChange | null {
  if (!isRecord(value)) return null;
  const change: ComputerAccessChange = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'mode' && MODES.includes(field as AccessMode)) change.mode = field as AccessMode;
    else if (key === 'grantMinutes' && typeof field === 'number' && field > 0 && field <= 24 * 60) change.grantMinutes = field;
    else if ((key === 'revoke' || key === 'deny' || key === 'keepAwake') && typeof field === 'boolean') change[key] = field;
    else return null;
  }
  return Object.keys(change).length > 0 ? change : null;
}

/** The agent's `tunnel.access.state` report. Null for anything malformed; an unknown optional field is dropped. */
export function parseAccessState(params: unknown): ReportedComputerAccess | null {
  if (!isRecord(params) || !MODES.includes(params.mode as AccessMode)) return null;
  const grantedUntil = isoOrNull(params.grantedUntil ?? null);
  if (grantedUntil === undefined) return null;
  const state: ReportedComputerAccess = { mode: params.mode as AccessMode, grantedUntil };
  const deniedUntil = isoOrNull(params.deniedUntil);
  if (deniedUntil !== undefined) state.deniedUntil = deniedUntil;
  if (typeof params.keepAwake === 'boolean') state.keepAwake = params.keepAwake;
  if (typeof params.keepAwakeSupported === 'boolean') state.keepAwakeSupported = params.keepAwakeSupported;
  const pending = params.pendingRequest;
  if (pending === null) state.pendingRequest = null;
  else if (isRecord(pending) && typeof pending.capability === 'string' && pending.capability.length <= 32) {
    const requestedAt = isoOrNull(pending.requestedAt);
    const change = pending.change === undefined ? undefined : parseAccessChange(pending.change);
    if (requestedAt && change !== null) {
      state.pendingRequest = { capability: pending.capability, requestedAt, ...(change ? { change } : {}) };
    }
  }
  const desktop = params.desktopPermissions;
  if (desktop === null) state.desktopPermissions = null;
  else if (isRecord(desktop) && typeof desktop.accessibility === 'boolean' && typeof desktop.screenRecording === 'boolean') {
    state.desktopPermissions = { accessibility: desktop.accessibility, screenRecording: desktop.screenRecording };
  }
  return state;
}

/** The `access` field of a computer: the last report, with lapsed grants and stale requests removed. */
export interface ComputerAccessView extends ReportedComputerAccess {
  /** The agent serves `POST /v1/tunnel/connections/:id/access` (agent-tunnel 0.1.4 and later). */
  controllable: boolean;
}

export function computerAccessView(machineInfo: unknown, now = Date.now()): ComputerAccessView | null {
  const info = isRecord(machineInfo) ? machineInfo : {};
  const access = parseAccessState(info.access);
  if (!access) return null;
  const live = (iso: string | null | undefined) => (iso && Date.parse(iso) > now ? iso : null);
  return {
    ...access,
    grantedUntil: live(access.grantedUntil),
    ...(access.deniedUntil !== undefined ? { deniedUntil: live(access.deniedUntil) } : {}),
    ...(access.pendingRequest !== undefined
      ? {
          pendingRequest:
            access.pendingRequest && now - Date.parse(access.pendingRequest.requestedAt) < REQUEST_FRESH_MS
              ? access.pendingRequest
              : null,
        }
      : {}),
    controllable: info.controlsAccess === true,
  };
}

export type ChangeComputerAccessResult =
  | { ok: true; access: ComputerAccessView }
  | {
      ok: false;
      status: 404 | 409 | 502 | 504;
      kind: 'not_found' | 'computer_offline' | 'agent_update_required' | 'computer_access_unconfirmed' | 'error';
      message: string;
    };

const npxAccess = 'npx @kortix/agent-tunnel@latest access';

/**
 * Relays the owner's change to the machine (`tunnel.access.set`) and waits
 * for its answer. A widening waits up to ACCESS_HOLD_MS for the owner to
 * confirm on the computer. The caller authorized the owner (`ownerClause`).
 */
export async function changeComputerAccess(
  tunnelId: string,
  ownerClause: SQL,
  change: ComputerAccessChange,
): Promise<ChangeComputerAccessResult> {
  const [row] = await db
    .select()
    .from(tunnelConnections)
    .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause));
  if (!row) return { ok: false, status: 404, kind: 'not_found', message: 'Tunnel connection not found' };
  const name = row.name || 'This computer';
  if (!isTunnelConnectionLive(row)) {
    return {
      ok: false,
      status: 409,
      kind: 'computer_offline',
      message: `${name} is offline. Change access on the computer itself: the Kortix menu bar, or ${npxAccess}.`,
    };
  }
  if (computerAccessView(row.machineInfo)?.controllable !== true) {
    return {
      ok: false,
      status: 409,
      kind: 'agent_update_required',
      message: `Update Kortix on ${name} to change its access from here, or run ${npxAccess} on it.`,
    };
  }

  let result: unknown;
  try {
    result = await relayRpcToConnectedAgent({
      tunnelId,
      accountId: row.accountId,
      method: 'tunnel.access.set',
      params: { ...change },
      timeoutMs: config.TUNNEL_RPC_TIMEOUT_MS + ACCESS_HOLD_MS,
    });
  } catch (error) {
    const code = error instanceof TunnelRelayError ? error.code : TunnelErrorCode.LOCAL_ERROR;
    const message = error instanceof Error ? error.message : String(error);
    if (code === TunnelErrorCode.ACCESS_UNCONFIRMED || message.startsWith('computer_access_unconfirmed:')) {
      return {
        ok: false,
        status: 409,
        kind: 'computer_access_unconfirmed',
        message: message.replace(/^computer_access_unconfirmed:\s*/, ''),
      };
    }
    if (code === TunnelErrorCode.NOT_CONNECTED) return { ok: false, status: 409, kind: 'computer_offline', message };
    return { ok: false, status: code === TunnelErrorCode.TIMEOUT ? 504 : 502, kind: 'error', message };
  }

  const reported = parseAccessState(result);
  if (!reported) return { ok: false, status: 502, kind: 'error', message: 'The computer answered with an unreadable access state.' };
  // The answer carries no macOS permissions: keep the last report of them.
  const access = { ...reported, desktopPermissions: computerAccessView(row.machineInfo)?.desktopPermissions ?? null };
  // The agent reports the change too; storing its answer now means the next read already shows it.
  await db
    .update(tunnelConnections)
    .set({
      machineInfo: sql`coalesce(${tunnelConnections.machineInfo}, '{}'::jsonb) || ${JSON.stringify({ access })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(tunnelConnections.tunnelId, tunnelId));
  return { ok: true, access: { ...access, controllable: true } };
}
