export class ArtifactActivityQueryError extends Error {
  readonly status = 400;
  constructor(readonly code: 'invalid_limit' | 'invalid_cursor', message: string) { super(message); }
}

export interface ActivityKey { us: number; id: string }

export function activityLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > 100) {
    throw new ArtifactActivityQueryError('invalid_limit', 'limit must be decimal digits from 1 to 100');
  }
  return number;
}

export function activityMicros(instant: string): number {
  const milliseconds = Date.parse(instant);
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(instant)?.[1] ?? '';
  const us = milliseconds * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
  if (!Number.isSafeInteger(us) || us < 0) throw new ArtifactActivityQueryError('invalid_cursor', 'Invalid activity timestamp');
  return us;
}

export function activityInstant(us: number): string {
  return new Date(Math.floor(us / 1000)).toISOString().replace('Z', `${String(us % 1000).padStart(3, '0')}Z`);
}

export function compareActivity(a: ActivityKey, b: ActivityKey): number {
  return b.us - a.us || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function activityCursor(artifactId: string, key: ActivityKey): string {
  return Buffer.from(JSON.stringify({ v: 1, artifact_id: artifactId, t: key.us, id: key.id })).toString('base64url');
}

export function readActivityCursor(artifactId: string, value: string | undefined): ActivityKey | null {
  if (value === undefined) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (row.v !== 1 || row.artifact_id !== artifactId || !Number.isSafeInteger(row.t) || row.t < 0
      || typeof row.id !== 'string' || !/^(event|save):[A-Za-z0-9_-]{1,128}$/.test(row.id)) throw new Error();
    return { us: row.t, id: row.id };
  } catch {
    throw new ArtifactActivityQueryError('invalid_cursor', 'cursor must belong to this Artifact activity feed');
  }
}
