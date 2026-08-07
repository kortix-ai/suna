import { createHash } from 'node:crypto';

export interface GitWriteCommand {
  ref: string;
  oldOid: string;
  newOid: string;
}

const encoder = new TextEncoder();

/** Build one internal empty-pack receive-pack command followed by a flush. */
export function buildTaskGitWriteReconcileBody(
  target: GitWriteCommand,
  oldOid: string,
  newOid: string,
): Uint8Array<ArrayBuffer> {
  const payload = `${oldOid} ${newOid} ${target.ref}\0report-status`;
  const bytes = encoder.encode(payload);
  const header = (bytes.byteLength + 4).toString(16).padStart(4, '0');
  const command = encoder.encode(`${header}${payload}0000`);
  const packHeader = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const digest = createHash(oldOid.length === 64 ? 'sha256' : 'sha1')
    .update(packHeader)
    .digest();
  const body = new Uint8Array(command.byteLength + packHeader.byteLength + digest.byteLength);
  body.set(command, 0);
  body.set(packHeader, command.byteLength);
  body.set(digest, command.byteLength + packHeader.byteLength);
  return body;
}

/** True only when the requested mutation completed or its old CAS cannot match. */
export function taskGitWriteMutationIsSettled(
  target: GitWriteCommand,
  currentOid: string | null,
): boolean {
  if (currentOid === target.newOid) return true;
  if (/^0+$/.test(target.oldOid)) return currentOid !== null;
  return currentOid !== target.oldOid;
}
