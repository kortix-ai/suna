/**
 * Persistent machines (session option `persistent_machine`, Platinum only).
 *
 * The box boots from a Platinum root volume: its whole root disk is a volume,
 * so packages the agent installs, its config and /workspace all persist.
 *
 *   stop  = Platinum's stop of a root-volume box: a final commit, nothing is
 *           kept on the host. The box and its volume stay.
 *   start = Platinum's start: a cold boot of the volume's head on any host.
 *           Running processes and memory do not survive a stop.
 *   reset = carry the session's chat (OpenCode's data and state) and the
 *           daemon's pins onto the session volume, delete the box (its root
 *           volume goes with it) and boot a fresh one from the current image
 *           with that volume mounted. The chat continues; the session's branch
 *           is restored like any re-provision; anything else on the old disk
 *           is gone. Drives are their own volumes and are untouched.
 *   delete = the session's delete removes the box; Platinum deletes the root
 *           volume with it.
 *
 * The root volume belongs to the box (Platinum `root_volume: true`), so the
 * box is never retired on stop the way an ephemeral box is. It gets a session
 * state volume only from a reset, which is where the chat survives the disk.
 * Drives still mount; the root disk takes one of the sandbox's mount slots.
 *
 * Image upgrades: a persistent machine keeps booting the image it was created
 * from. Only a reset moves it to the current image.
 */

import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

/** project_sessions metadata: the session runs on a persistent machine (set at create, never changed). */
export const PERSISTENT_MACHINE_SESSION_KEY = 'persistent_machine';
/** session_sandboxes metadata: this box boots from a Platinum root volume. */
export const ROOT_VOLUME_BOX_KEY = 'rootVolume';

export function persistentMachineFromSessionMetadata(metadata: unknown): boolean {
  return (metadata as Record<string, unknown> | null | undefined)?.[PERSISTENT_MACHINE_SESSION_KEY] === true;
}

export async function isPersistentMachineSession(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return persistentMachineFromSessionMetadata(row?.metadata);
}

/** Does this sandbox row's box boot from a root volume? */
export function isRootVolumeBox(metadata: unknown): boolean {
  return (metadata as Record<string, unknown> | null | undefined)?.[ROOT_VOLUME_BOX_KEY] === true;
}
