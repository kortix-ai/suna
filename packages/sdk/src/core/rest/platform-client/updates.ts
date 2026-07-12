/**
 * Platform API client — sandbox update + version/changelog API.
 */

import type { SandboxInfo } from './types';
import { getPlatformUrl } from './shared';

export interface ChangelogChange {
  type: 'feature' | 'fix' | 'improvement' | 'breaking' | 'upstream' | 'security' | 'deprecation';
  text: string;
}

export interface ChangelogArtifact {
  name: string;
  target: 'npm' | 'docker-hub' | 'github-release' | 'daytona';
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  description: string;
  changes: ChangelogChange[];
  artifacts?: ChangelogArtifact[];
  /** Present on dev changelog entries */
  channel?: 'stable' | 'dev';
  sha?: string;
  author?: string;
}

export type VersionChannel = 'stable' | 'dev';

export interface VersionEntry {
  version: string;
  channel: VersionChannel;
  date: string;
  title: string;
  body?: string;
  sha?: string;
  current: boolean;
}

export interface AllVersionsResponse {
  versions: VersionEntry[];
  current: {
    version: string;
    channel: VersionChannel;
  };
}

export interface SandboxVersionInfo {
  version: string;
  channel?: string;
  date?: string;
  sha?: string;
  changelog: ChangelogEntry | null;
}

export interface SandboxUpdateResult {
  success?: boolean;
  upToDate?: boolean;
  previousVersion?: string;
  currentVersion: string;
  changelog?: ChangelogEntry | null;
  output?: string;
  error?: string;
}

/**
 * Update phases — Docker image-based flow.
 *
 * JustAVPS: backing_up → pulling → patching → stopping → restarting → verifying → complete
 * Local Docker is manual-only and is not updated through the API.
 */
export type UpdatePhase =
  | 'idle'
  | 'backing_up'
  | 'pulling'
  | 'patching'
  | 'stopping'
  | 'removing'
  | 'recreating'
  | 'restarting'
  | 'verifying'
  | 'starting'
  | 'health_check'
  | 'complete'
  | 'failed';

export interface SandboxUpdateStatus {
  phase: UpdatePhase;
  progress: number;
  message: string;
  targetVersion: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  /** Provider-side backup ID while phase === 'backing_up'. Null otherwise. */
  backupId?: string | null;
  cancelRequested?: boolean;
  diagnostics?: Record<string, string | number | boolean | null>;
}

/** Phases where the sandbox is being modified and must not be used. */
export const DESTRUCTIVE_PHASES: UpdatePhase[] = [
  'pulling', 'patching', 'stopping', 'removing', 'recreating',
  'restarting', 'verifying', 'starting', 'health_check',
];

export function isDestructivePhase(phase: UpdatePhase): boolean {
  return DESTRUCTIVE_PHASES.includes(phase);
}

/**
 * Get the current update status from kortix-api.
 * The API tracks the Docker pull + recreate progress.
 */
export async function getSandboxUpdateStatus(
  sandbox?: SandboxInfo,
): Promise<SandboxUpdateStatus> {
  return {
    phase: 'idle',
    progress: 0,
    message: 'Sandbox image updates are managed by project-session provisioning.',
    targetVersion: null,
    previousVersion: null,
    currentVersion: sandbox?.version ?? null,
    error: null,
    startedAt: null,
    updatedAt: null,
  };
}

/**
 * Get the latest available sandbox version — proxied through the platform API.
 * Uses GitHub Releases API for stable, GitHub Commits API for dev.
 *
 * @param channel — 'stable' (default) or 'dev'
 */
export async function getLatestSandboxVersion(channel?: VersionChannel): Promise<SandboxVersionInfo> {
  const params = channel ? `?channel=${channel}` : '';
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/latest${params}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Version check failed: ${res.status}`);
  const latest = await res.json() as SandboxVersionInfo & { title?: string };

  try {
    const changelogEntries = await getFullChangelog(channel || 'stable');
    latest.changelog = changelogEntries.find((entry) => entry.version === latest.version) ?? changelogEntries[0] ?? null;
  } catch {
    latest.changelog = null;
  }

  return latest;
}

/**
 * Get the full changelog from the platform.
 * Supports channel filtering: 'stable', 'dev', or 'all' (default).
 */
export async function getFullChangelog(channel?: 'stable' | 'dev' | 'all'): Promise<ChangelogEntry[]> {
  const params = channel ? `?channel=${channel}` : '';
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/changelog${params}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Changelog fetch failed: ${res.status}`);
  const data = await res.json();
  return data.changelog;
}

/**
 * Get all available versions (both stable and dev).
 */
export async function getAllVersions(): Promise<AllVersionsResponse> {
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/all`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`All versions fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Trigger a Docker image-based sandbox update via kortix-api.
 *
 * The API pulls the new image, stops the container, removes it (preserving
 * the /workspace volume), and recreates with the new image. The frontend
 * should poll getSandboxUpdateStatus() for progress.
 */
export async function triggerSandboxUpdate(
  sandbox: SandboxInfo,
  version: string,
): Promise<SandboxUpdateResult> {
  throw new Error('Sandbox image updates are managed by project-session provisioning');
}

/**
 * Reset the update status on kortix-api (e.g. after a failed update to allow retry).
 */
export async function resetSandboxUpdateStatus(sandbox?: SandboxInfo): Promise<void> {
  return;
}

export async function cancelSandboxUpdate(sandbox?: SandboxInfo): Promise<void> {
  return;
}
