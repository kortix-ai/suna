import { createHash } from 'node:crypto';
import { projectPiHistory, validatePiHistoryTransition, type PiHistorySelection, type PiHistoryWorkspaceMove } from '../../../packages/shared/src/pi-history';
import type { WorkspaceHistoryReceipt } from '../../../packages/shared/src/workspace-history';
import type { SessionLog } from './session-store';

export class SessionRewindError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function appendId(operationId: string, phase: string): string {
  const bytes = createHash('sha256').update(`pi-rewind:${operationId}:${phase}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SessionRewind {
  constructor(private readonly log: SessionLog, private readonly workspace: {
    apply(move: PiHistoryWorkspaceMove): Promise<WorkspaceHistoryReceipt>;
    abort(move: PiHistoryWorkspaceMove): Promise<WorkspaceHistoryReceipt>;
  }) {}

  async prepare(selection: PiHistorySelection, workspace: PiHistoryWorkspaceMove | null, operationId = crypto.randomUUID()): Promise<void> {
    const transition = validatePiHistoryTransition(await this.log.read(), {
      kind: 'history', version: 1, revision: selection.revision, action: 'prepare', operationId, selection, workspace,
    });
    await this.log.append(transition, { idempotencyKey: appendId(operationId, 'prepare') });
    await this.recover();
  }

  async recover(): Promise<void> {
    const state = projectPiHistory(await this.log.read());
    const pending = state.pending;
    if (!pending) return;
    let action: 'commit' | 'cancel' = 'commit';
    let failure: unknown;
    if (pending.workspace) {
      let receipt: WorkspaceHistoryReceipt;
      try { receipt = await this.workspace.apply(pending.workspace); }
      catch (error) {
        failure = error;
        try { receipt = await this.workspace.abort(pending.workspace); }
        catch { throw new SessionRewindError('Workspace recovery is pending. Retry rewind before sending another prompt.', 503); }
      }
      if (receipt.operationId !== pending.operationId || receipt.from !== pending.workspace.from || receipt.to !== pending.workspace.to) {
        throw new SessionRewindError('Workspace recovery returned a different operation identity.', 503);
      }
      if (receipt.status === 'cancelled') action = 'cancel';
      else if (receipt.status !== 'complete') throw new SessionRewindError('Workspace recovery is pending.', 503);
    }
    await this.log.append({ kind: 'history', version: 1, revision: state.revision, operationId: pending.operationId, action }, { idempotencyKey: appendId(pending.operationId, action) });
    if (action === 'cancel') throw new SessionRewindError(failure instanceof Error ? failure.message : 'Workspace rewind was cancelled. The conversation is unchanged.');
  }
}
