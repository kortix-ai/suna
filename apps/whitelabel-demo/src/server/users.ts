/**
 * Wrapper-mode per-user project ownership — a tiny JSON-file store, gitignored
 * under `.lumen-data/` (created lazily). Maps `userId` (the login email) to
 * the list of project ids they created THROUGH this wrapper.
 *
 * This is the whole isolation model: a wrapper end user only ever sees/can-act
 * on projects they themselves provisioned. The file mechanics live in
 * `json-store.ts`; this module is only the ownership logic.
 */

import { WRAPPER_DATA_DIR, readJsonStore, writeJsonStore } from './json-store';
import path from 'node:path';

type UsersData = Record<string, string[]>;

const DATA_FILE = path.join(WRAPPER_DATA_DIR, 'users.json');

function readData(): UsersData {
  return readJsonStore<UsersData>(DATA_FILE, {});
}

function writeData(data: UsersData): void {
  writeJsonStore(WRAPPER_DATA_DIR, DATA_FILE, data);
}

// Kortix project ids are UUIDs. Enforced on WRITE (only record what upstream
// actually minted) and on READ (ids from this file end up inside upstream
// request URLs — see /api/session-costs — so a hand-edited or corrupted store must
// never be able to steer a request anywhere unexpected).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Kortix id is a UUID; project AND session ids are validated with this before either is interpolated into an upstream URL. */
export function isValidProjectId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Same UUID contract, named for the session route that validates `sessionId` the same way. */
export function isValidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

/** Every project id `userId` owns (created through the wrapper). */
export function listOwnedProjects(userId: string): string[] {
  return (readData()[userId] ?? []).filter(isValidProjectId);
}

/** Record that `userId` owns `projectId` — called right after a successful `/projects/provision`. */
export function addOwnedProject(userId: string, projectId: string): void {
  if (!userId || !isValidProjectId(projectId)) return;
  const data = readData();
  const existing = data[userId] ?? [];
  if (!existing.includes(projectId)) {
    data[userId] = [...existing, projectId];
    writeData(data);
  }
}

/** True if `userId` owns `projectId`. */
export function isOwner(userId: string, projectId: string): boolean {
  return listOwnedProjects(userId).includes(projectId);
}
