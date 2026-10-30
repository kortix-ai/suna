/**
 * Project feature flags as the CLI sees them. A flagged command or system
 * skill is shown and runs ONLY where its flag is known on; anywhere else it is
 * hidden, and running it prints that the flag is off.
 *
 * Where the CLI learns the flags:
 *   • in a session box — KORTIX_FEATURE_FLAGS, the project's enabled flags the
 *     API sets at provisioning (apps/api projects/lib/feature-flag-env.ts);
 *   • elsewhere — the linked project's `experimental_features` from
 *     `GET /projects/:id`. No project, no credential or no answer in time
 *     means the flags are unknown, and a flagged item stays hidden.
 */
import { resolveProjectAuth, takeFlagValue } from './command-helpers.ts';
import { clientFromAuth } from './api/client.ts';
import { resolveProjectRef } from './project-link.ts';

export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS';

type Env = Record<string, string | undefined>;

/** The box's enabled flags, or null outside a session box. */
export function boxFeatureFlags(env: Env = process.env): Set<string> | null {
  const raw = env[FEATURE_FLAGS_ENV_NAME];
  if (raw === undefined) return null;
  return new Set(raw.split(',').map((flag) => flag.trim()).filter(Boolean));
}

interface FeatureRow {
  key: string;
  enabled?: boolean;
}

/**
 * The enabled flags of the project a command acts on: the box's list, else the
 * project's from the API within `timeoutMs`, else null (unknown). Reads
 * `--project` / `--host` from `argv` without consuming them. Never prompts.
 */
export async function enabledFeatureFlags(
  argv: readonly string[] = [],
  opts: { timeoutMs?: number; env?: Env } = {},
): Promise<Set<string> | null> {
  const box = boxFeatureFlags(opts.env);
  if (box) return box;
  const rest = [...argv];
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch {
    return null; // a flag without its value: the command itself reports it
  }
  const ref = resolveProjectRef(projectArg);
  const { auth } = resolveProjectAuth({ hostArg });
  if (!ref?.projectId || !auth?.token) return null;
  const read = clientFromAuth(auth)
    .get<{ experimental_features?: FeatureRow[] }>(`/projects/${ref.projectId}`)
    .then((project) => new Set((project.experimental_features ?? []).filter((r) => r.enabled).map((r) => r.key)))
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 10_000).unref?.());
  return Promise.race([read, timeout]);
}

/** True for an unflagged item, or a flag in `flags`. */
export function featureShown(flag: string | null | undefined, flags: Set<string> | null): boolean {
  return !flag || flags?.has(flag) === true;
}

/** The one line a hidden item prints instead of itself. */
export function featureOffMessage(what: string, flag: string, flags: Set<string> | null): string {
  if (flags === null) {
    return `${what} is behind the \`${flag}\` feature flag, and this project's flags could not be read. Link a project (kortix projects use) or pass --project <id>.`;
  }
  return `${what} is behind the \`${flag}\` feature flag, which is off for this project. A project admin turns it on: kortix projects features enable ${flag}`;
}
