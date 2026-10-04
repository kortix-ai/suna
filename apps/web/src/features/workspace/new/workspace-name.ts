/**
 * Client-side mirror of the name rules in `POST /v1/projects/provision`
 * (`apps/api/src/http/projects/projects.ts`). The server stays authoritative — this
 * exists so a bad name is an inline field error instead of a network round-trip
 * that ends in a 400.
 *
 * Keep these two in lockstep. The API comment explains the cost of drifting: an
 * over-long name passes the charset check, provisions the upstream repo, then
 * dies on the DB insert, leaving an orphaned managed repo per retry.
 */

// Mirrored from apps/api/src/services/projects/lib/serializers.ts:570
export const WORKSPACE_NAME_MAX_LENGTH = 120;
export const WORKSPACE_NAME_PATTERN = /^[a-zA-Z0-9._ -]+$/;

const CHARSET_ERROR = 'Use only letters, numbers, spaces, hyphens, underscores or dots';

export type WorkspaceNameResult = { ok: true; name: string } | { ok: false; error: string };

export function validateWorkspaceName(raw: string): WorkspaceNameResult {
  const name = raw.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  if (!WORKSPACE_NAME_PATTERN.test(name)) return { ok: false, error: CHARSET_ERROR };
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return { ok: false, error: `Name must be ${WORKSPACE_NAME_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, name };
}

const NAME_ADJECTIVES = [
  'Amber',
  'Bright',
  'Calm',
  'Clever',
  'Cosmic',
  'Crisp',
  'Golden',
  'Lucky',
  'Nimble',
  'Quiet',
  'Rapid',
  'Silver',
  'Steady',
  'Sunny',
  'Swift',
  'Vivid',
] as const;

const NAME_NOUNS = [
  'Atlas',
  'Beacon',
  'Comet',
  'Falcon',
  'Harbor',
  'Horizon',
  'Lantern',
  'Meadow',
  'Orbit',
  'Pine',
  'Quartz',
  'Ridge',
  'River',
  'Summit',
  'Tide',
  'Willow',
] as const;

/**
 * A ready-to-use project name ("Amber Falcon"), so `/new` opens with a valid,
 * friendly name instead of an empty required field. Always passes
 * `validateWorkspaceName` — letters and one space only. `random` is injectable
 * for tests.
 */
export function suggestWorkspaceName(random: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  return `${pick(NAME_ADJECTIVES)} ${pick(NAME_NOUNS)}`;
}
