/**
 * Feature flags as the in-sandbox CLI sees them.
 *
 * The API puts `KORTIX_FEATURES` (comma list of enabled flags, or `none`) in
 * every project session's sandbox env and re-pushes it when a flag toggles.
 * Absent variable = a human's local CLI, or an older sandbox: nothing is
 * hidden. Present = a flagged command or option that is not listed is hidden.
 */
import { sandboxEnvValue } from './api/sandbox-env.ts';

/** Enabled flags, or null when this process does not report its flags. */
export function sandboxFeatures(raw: string | undefined = sandboxEnvValue('KORTIX_FEATURES')): Set<string> | null {
  if (raw === undefined) return null;
  return new Set(raw.split(',').map((f) => f.trim()).filter(Boolean));
}

export function featureHidden(feature: string, features: Set<string> | null = sandboxFeatures()): boolean {
  return features !== null && !features.has(feature);
}

/** Drop the commands whose flag is off. */
export function visibleCommands<T extends { feature?: string }>(
  commands: readonly T[],
  features: Set<string> | null = sandboxFeatures(),
): readonly T[] {
  return commands.filter((c) => !c.feature || !featureHidden(c.feature, features));
}
