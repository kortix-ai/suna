/**
 * Wrapper-mode runtime ownership.
 *
 * The store maps one opaque runtime external id to its Kortix project id.
 * The BFF records the mapping from an authenticated session `/start`
 * response. Runtime proxy requests then reuse the existing project ownership
 * check. Unknown runtime ids fail closed.
 */

import path from 'node:path';
import { WRAPPER_DATA_DIR, readJsonStore, writeJsonStore } from './json-store';
import { isValidProjectId } from './users';

interface RuntimeEntry {
  projectId: string;
  recordedAt: number;
}

type RuntimeData = Record<string, RuntimeEntry>;

const DATA_FILE = path.join(WRAPPER_DATA_DIR, 'runtime-access.json');
const MAX_RUNTIME_ENTRIES = 10_000;
const RUNTIME_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function readData(): RuntimeData {
  return readJsonStore<RuntimeData>(DATA_FILE, {});
}

function writeData(data: RuntimeData): void {
  writeJsonStore(WRAPPER_DATA_DIR, DATA_FILE, data);
}

function isValidRuntimeId(runtimeId: string): boolean {
  return RUNTIME_ID_RE.test(runtimeId);
}

export function recordRuntimeProject(runtimeId: string, projectId: string): void {
  if (!isValidRuntimeId(runtimeId) || !isValidProjectId(projectId)) return;

  const data = readData();
  data[runtimeId] = { projectId, recordedAt: Date.now() };

  const entries = Object.entries(data);
  if (entries.length > MAX_RUNTIME_ENTRIES) {
    entries
      .sort((left, right) => left[1].recordedAt - right[1].recordedAt)
      .slice(0, entries.length - MAX_RUNTIME_ENTRIES)
      .forEach(([id]) => delete data[id]);
  }

  writeData(data);
}

export function resolveRuntimeProject(runtimeId: string): string | null {
  if (!isValidRuntimeId(runtimeId)) return null;
  const entry = readData()[runtimeId];
  return entry && isValidProjectId(entry.projectId) ? entry.projectId : null;
}
