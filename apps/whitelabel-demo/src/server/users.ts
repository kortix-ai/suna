/**
 * Wrapper-mode per-user project ownership — a tiny JSON-file store, gitignored
 * under `.lumen-data/` (created lazily). Maps `userId` (the login email) to
 * the list of project ids they created THROUGH this wrapper.
 *
 * This is the whole isolation model: a wrapper end user only ever sees/can-act
 * on projects they themselves provisioned. It's intentionally file-backed and
 * synchronous — this is a reference demo for a single Node process, not a
 * production multi-instance deployment. A real deployment would swap this for
 * a real table (keyed the same way) without touching any caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type UsersData = Record<string, string[]>;

const DATA_DIR = path.join(process.cwd(), '.lumen-data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

function readData(): UsersData {
  try {
    if (!existsSync(DATA_FILE)) return {};
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as UsersData) : {};
  } catch {
    return {};
  }
}

function writeData(data: UsersData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** Every project id `userId` owns (created through the wrapper). */
export function listOwnedProjects(userId: string): string[] {
  return readData()[userId] ?? [];
}

/** Record that `userId` owns `projectId` — called right after a successful `/projects/provision`. */
export function addOwnedProject(userId: string, projectId: string): void {
  if (!userId || !projectId) return;
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
