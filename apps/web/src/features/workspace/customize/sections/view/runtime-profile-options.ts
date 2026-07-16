import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';
import type { AcpHarness, RuntimeProfile } from '@kortix/sdk/projects-client';

// Identity, labels, and config dirs derive from the canonical `@kortix/shared`
// harness descriptor — do not re-hardcode the harness tuple, labels, or
// config-dir strings here (see packages/shared/src/harnesses.ts).
export const ACP_HARNESSES: readonly AcpHarness[] = HARNESS_IDS;
export const ACP_HARNESS_LABELS: Record<AcpHarness, string> = Object.fromEntries(
  HARNESS_IDS.map((id) => [id, HARNESSES[id].label]),
) as Record<AcpHarness, string>;
export const ACP_HARNESS_CONFIG_DIRS: Record<AcpHarness, string> = Object.fromEntries(
  HARNESS_IDS.map((id) => [id, HARNESSES[id].configDir]),
) as Record<AcpHarness, string>;

export function withAllAcpHarnesses(
  current: Record<string, RuntimeProfile>,
): Record<string, RuntimeProfile> {
  const next = { ...current };
  for (const harness of ACP_HARNESSES) {
    if (!Object.values(next).some((profile) => profile.harness === harness)) {
      next[harness] = { harness, config_dir: ACP_HARNESS_CONFIG_DIRS[harness] };
    }
  }
  return next;
}
