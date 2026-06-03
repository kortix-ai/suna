/**
 * Per-project gate for the experimental `[[apps]]` deployment surface.
 *
 * Apps used to be a single platform-wide env flag (`KORTIX_APPS_EXPERIMENTAL`).
 * It's now per-project: a project can opt in (or out) from Customize → Settings,
 * stored in `projects.metadata.apps_enabled`. The env flag becomes the DEFAULT
 * for projects that haven't made an explicit choice — flip it on to default the
 * whole fleet on, or leave it off (the default) and enable apps per project.
 *
 * DB-only — never in kortix.toml.
 */
import { config } from '../config';

/** Effective apps gate for a project: the per-project override
 * (projects.metadata.apps_enabled) over the operator default
 * (KORTIX_APPS_EXPERIMENTAL). */
export function resolveAppsEnabled(metadata: unknown): boolean {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.apps_enabled;
  if (typeof raw === 'boolean') return raw;
  return config.KORTIX_APPS_EXPERIMENTAL;
}
