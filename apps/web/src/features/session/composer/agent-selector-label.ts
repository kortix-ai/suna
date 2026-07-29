import { HARNESSES, type HarnessId } from '@kortix/shared/harnesses';

export function getAgentHarnessLabel(harness: HarnessId | null | undefined): string | null {
  return harness ? HARNESSES[harness].label : null;
}
