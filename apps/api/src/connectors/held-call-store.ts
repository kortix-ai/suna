/**
 * The full input of a call held for approval, encrypted at rest in
 * `connector_held_calls.input_enc`. Only the approved run reads it. It never
 * leaves this table: no API response, log line, audit event or
 * `result_summary` carries it.
 */
import type { AgentGrant } from '@kortix/db';
import { connectorCalls, connectorHeldCalls } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import { db } from '../shared/db';
import type { CallPolicySet } from './gateway';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The job queue of approved held runs (held-call-run.ts). One job per execution id. */
export const HELD_CALL_QUEUE = 'connector-held-call';

/**
 * How long one held run may own its `dispatched` row. A job is claimed again
 * only after its visibility (`HELD_RUN_VISIBILITY_MS`), and the fence comes
 * after the claim, so the first re-claim of a crashed run finds the row older
 * than this ceiling and settles it `unknown`. It must stay above the call
 * deadline (`KORTIX_CONNECTOR_CALL_TIMEOUT_MS`, kept below Cloudflare's
 * 100 s) and below the visibility minus the work before the fence.
 */
export const HELD_RUN_CEILING_MS = 3 * 60_000;
export const HELD_RUN_VISIBILITY_MS = 5 * 60_000;

/** Plaintext v1. The envelope has no AAD, so the ids and the digest are inside it and checked after decrypt. */
export interface HeldCallInput {
  v: 1;
  execution_id: string;
  project_id: string;
  request_digest: string;
  /** Not checked after decrypt: a project transfer rewrites the row's account. */
  account_id: string;
  connector_slug: string;
  /** Connector-relative path. */
  action_path: string;
  /** The arguments the policy engine saw. */
  args: Record<string, unknown>;
  connection_id: string | null;
  approval_context: string | null;
  policy_set: CallPolicySet | null;
  acting_token_id: string | null;
  session_id: string | null;
  user_id: string;
  agent_grant: AgentGrant | null;
  agent_principal: { onBehalfOfUserId: string | null; agentId?: string | null } | null;
}

export type HeldInputRefusal = 'held_input_undecryptable' | 'held_input_mismatch';

export class HeldInputRefusedError extends Error {
  constructor(readonly reason: HeldInputRefusal) {
    super(reason);
    this.name = 'HeldInputRefusedError';
  }
}

export function sealHeldInput(input: HeldCallInput): string {
  return encryptProjectSecret(input.project_id, JSON.stringify(input));
}

/** Decrypts and checks the embedded ids and digest against the gate row. Throws `HeldInputRefusedError`. */
export function openHeldInput(
  gate: { executionId: string; projectId: string; requestDigest: string | null },
  inputEnc: string,
): HeldCallInput {
  let held: HeldCallInput;
  try {
    held = JSON.parse(decryptProjectSecret(gate.projectId, inputEnc)) as HeldCallInput;
  } catch {
    throw new HeldInputRefusedError('held_input_undecryptable');
  }
  if (
    held?.v !== 1 ||
    !gate.requestDigest ||
    held.execution_id !== gate.executionId ||
    held.project_id !== gate.projectId ||
    held.request_digest !== gate.requestDigest
  ) {
    throw new HeldInputRefusedError('held_input_mismatch');
  }
  return held;
}

/** The held input of a gate, or null when there is none or it was wiped. Throws `HeldInputRefusedError`. */
export async function readHeldInput(executionId: string, exec: Tx | typeof db = db): Promise<HeldCallInput | null> {
  const [row] = await exec
    .select({
      inputEnc: connectorHeldCalls.inputEnc,
      projectId: connectorCalls.projectId,
      requestDigest: connectorCalls.requestDigest,
    })
    .from(connectorHeldCalls)
    .innerJoin(connectorCalls, eq(connectorCalls.executionId, connectorHeldCalls.executionId))
    .where(eq(connectorHeldCalls.executionId, executionId))
    .limit(1);
  if (!row?.inputEnc) return null;
  return openHeldInput({ executionId, projectId: row.projectId, requestDigest: row.requestDigest }, row.inputEnc);
}

/** Sets `input_enc` to NULL. The row and its state stay. */
export async function wipeHeldInput(executionId: string, exec: Tx | typeof db = db): Promise<void> {
  await exec
    .update(connectorHeldCalls)
    .set({ inputEnc: null, updatedAt: new Date() })
    .where(eq(connectorHeldCalls.executionId, executionId));
}
