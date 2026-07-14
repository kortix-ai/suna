import { enterpriseVersion, type EnterpriseReleaseManifest } from './release-contract.ts';

export type UpdateTrigger = 'bootstrap' | 'hourly' | 'release-hint' | 'cli-update' | 'cli-reconcile' | 'cli-rollback';

export interface UpdateRequest {
  trigger: UpdateTrigger;
  channel: 'stable';
  force: boolean;
  requested_release?: string;
  rollback_to?: string;
}

export interface ReleaseHistoryEntry {
  release: string;
  manifest_sha256: string;
  verified_at: string;
  status: 'healthy' | 'rolled-back';
}

export interface InstalledReleaseState {
  release: string | null;
  channel: 'stable';
  status: string;
  manifest_sha256: string | null;
  updated_at: string | null;
  last_wal_archived_at: string | null;
  last_wal_name: string | null;
  last_base_backup_at: string | null;
  last_base_backup_key: string | null;
  history: ReleaseHistoryEntry[];
}

export type ReleaseDecision =
  | { action: 'noop'; reason: string; release: string }
  | { action: 'install' | 'update'; release: string }
  | { action: 'rollback'; release: string };

export function parseUpdateRequest(value: unknown): UpdateRequest {
  const input = asRecord(value);
  if (input.source === 'aws.events' && input['detail-type'] === 'Scheduled Event') {
    return { trigger: 'hourly', channel: 'stable', force: false };
  }
  if (input.source === 'com.kortix.enterprise.release' && input['detail-type'] === 'Kortix stable release') {
    const detail = asRecord(input.detail);
    if (detail.channel !== 'stable') throw new Error('release hint channel must be stable');
    return { trigger: 'release-hint', channel: 'stable', force: false };
  }

  const trigger = input.trigger;
  if (!isTrigger(trigger)) throw new Error('execution input has an unsupported trigger');
  const channel = input.channel ?? 'stable';
  if (channel !== 'stable') throw new Error('enterprise updater may only use the stable channel');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new Error('force must be boolean');
  const requested = input.requested_release === undefined
    ? undefined
    : enterpriseVersion(input.requested_release, 'requested_release');
  const rollback = input.rollback_to === undefined
    ? undefined
    : enterpriseVersion(input.rollback_to, 'rollback_to');
  if (requested && rollback) throw new Error('requested_release and rollback_to are mutually exclusive');
  if (trigger === 'cli-rollback' && !rollback) throw new Error('cli-rollback requires rollback_to');
  if (trigger !== 'cli-rollback' && rollback) throw new Error('rollback_to requires cli-rollback');
  return {
    trigger,
    channel: 'stable',
    force: input.force ?? false,
    ...(requested ? { requested_release: requested } : {}),
    ...(rollback ? { rollback_to: rollback } : {}),
  };
}

export function selectRelease(
  request: UpdateRequest,
  current: InstalledReleaseState,
  candidate: EnterpriseReleaseManifest,
  manifestSha256: string,
): ReleaseDecision {
  const expected = request.rollback_to ?? request.requested_release ?? candidate.version;
  if (candidate.version !== expected) {
    throw new Error(`signed target version ${candidate.version} does not match requested ${expected}`);
  }
  if (candidate.channel !== 'stable') throw new Error('candidate is not on stable');

  if (request.rollback_to) {
    if (!current.release) throw new Error('cannot roll back an installation without a current release');
    const verified = current.history.some((entry) => (
      entry.release === candidate.version && entry.manifest_sha256 === manifestSha256 && entry.status === 'healthy'
    ));
    if (!verified) throw new Error('rollback target is not in verified healthy release history');
    if (!candidate.compatibility.rollback_from.includes(current.release)) {
      throw new Error(`release ${candidate.version} does not permit rollback from ${current.release}`);
    }
    if (candidate.version === current.release) {
      return { action: 'noop', reason: 'rollback target is already installed', release: candidate.version };
    }
    return { action: 'rollback', release: candidate.version };
  }

  if (current.release === candidate.version && current.manifest_sha256 === manifestSha256 && current.status === 'healthy') {
    return { action: 'noop', reason: 'signed stable release is already healthy', release: candidate.version };
  }
  return { action: current.release ? 'update' : 'install', release: candidate.version };
}

export function requireMaintenanceWindow(
  request: UpdateRequest,
  window: string,
  now: Date,
  hasInstalledRelease: boolean,
): void {
  if (!hasInstalledRelease || request.force) return;
  if (!isWithinMaintenanceWindow(window, now)) {
    throw new Error(`outside UTC maintenance window ${window}; use a guarded force request to bypass only this gate`);
  }
}

export function requireFreshRecoveryPoint(
  state: InstalledReleaseState,
  now: Date,
  maxWalAgeMinutes = 15,
  maxBaseBackupAgeHours = 36,
): void {
  const wal = requiredPastTimestamp(state.last_wal_archived_at, 'WAL archive');
  const base = requiredPastTimestamp(state.last_base_backup_at, 'physical base backup');
  const walAge = now.getTime() - wal.getTime();
  const baseAge = now.getTime() - base.getTime();
  if (walAge < 0 || walAge > maxWalAgeMinutes * 60_000) {
    throw new Error(`latest WAL archive is not within ${maxWalAgeMinutes} minutes of the update`);
  }
  if (baseAge < 0 || baseAge > maxBaseBackupAgeHours * 60 * 60_000) {
    throw new Error(`latest physical base backup is not within ${maxBaseBackupAgeHours} hours of the update`);
  }
  if (!state.last_wal_name || !state.last_base_backup_key) {
    throw new Error('recovery-point metadata is incomplete');
  }
}

export function isWithinMaintenanceWindow(window: string, now: Date): boolean {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat):(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) throw new Error('maintenance window must use Ddd:HH:MM-HH:MM in UTC');
  const [, day, startHour, startMinute, endHour, endMinute] = match;
  const start = minutes(startHour!, startMinute!);
  const end = minutes(endHour!, endMinute!);
  if (start === end) throw new Error('maintenance window must not be empty');
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetDay = weekdays.indexOf(day!);
  const currentDay = now.getUTCDay();
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (end > start) return currentDay === targetDay && current >= start && current < end;
  const nextDay = (targetDay + 1) % 7;
  return (currentDay === targetDay && current >= start) || (currentDay === nextDay && current < end);
}

function minutes(hourValue: string, minuteValue: string): number {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) {
    throw new Error('maintenance window contains an invalid UTC time');
  }
  return hour * 60 + minute;
}

function requiredPastTimestamp(value: string | null, label: string): Date {
  if (!value) throw new Error(`${label} freshness is unavailable`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} timestamp is invalid`);
  return timestamp;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution input must be an object');
  }
  return value as Record<string, unknown>;
}

function isTrigger(value: unknown): value is UpdateTrigger {
  return [
    'bootstrap', 'hourly', 'release-hint', 'cli-update', 'cli-reconcile', 'cli-rollback',
  ].includes(value as string);
}
