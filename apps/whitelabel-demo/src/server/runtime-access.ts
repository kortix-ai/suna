/**
 * Wrapper-mode runtime ownership.
 *
 * The store maps one opaque runtime external id to its Kortix project id.
 * The BFF records the mapping from an authenticated session `/start`
 * response. Runtime proxy requests then reuse the existing project ownership
 * check. Unknown runtime ids fail closed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidProjectId } from './users';

interface RuntimeEntry {
  projectId: string;
  recordedAt: number;
}

type RuntimeData = Record<string, RuntimeEntry>;

const DATA_DIR = process.env.LUMEN_DATA_DIR || path.join(process.cwd(), '.lumen-data');
const DATA_FILE = path.join(DATA_DIR, 'runtime-access.json');
const MAX_RUNTIME_ENTRIES = 10_000;
const RUNTIME_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function readData(): RuntimeData {
  try {
    if (!existsSync(DATA_FILE)) return {};
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as RuntimeData) : {};
  } catch {
    return {};
  }
}

function writeData(data: RuntimeData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
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
