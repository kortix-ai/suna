import type { SandboxProviderName } from '../config';
import type { AppMachineSpec } from './hosting';

export type ManagedContainerProviderName = 'aws_lightsail';

export type AppHostingSelection =
  | { type: 'sandbox'; provider: SandboxProviderName | null }
  | { type: 'managed_container'; provider: ManagedContainerProviderName };

export interface AppHostingSelectionInput {
  /** @deprecated Use hosting.type=sandbox and hosting.provider. */
  provider?: SandboxProviderName;
  hosting?:
    | { type: 'sandbox'; provider?: SandboxProviderName }
    | { type: 'managed_container'; provider: ManagedContainerProviderName };
}

const LIGHTSAIL_POWERS = [
  // The App resource contract persists integer CPU and memory values. Keep
  // the backend table inside that public contract until a decimal-resource
  // migration makes the smaller Lightsail powers representable end to end.
  { name: 'medium', cpuCores: 1, memoryGb: 2, monthlyUsd: 40 },
  { name: 'large', cpuCores: 2, memoryGb: 4, monthlyUsd: 80 },
  { name: 'xlarge', cpuCores: 4, memoryGb: 8, monthlyUsd: 160 },
] as const;

export type LightsailPowerName = (typeof LIGHTSAIL_POWERS)[number]['name'];

export function resolveAppHostingSelection(input: AppHostingSelectionInput): AppHostingSelection {
  if (input.hosting && input.provider) {
    throw new Error('provider cannot be combined with hosting');
  }
  if (!input.hosting) return { type: 'sandbox', provider: input.provider ?? null };
  if (input.hosting.type === 'sandbox') {
    return { type: 'sandbox', provider: input.hosting.provider ?? null };
  }
  return input.hosting;
}

export function lightsailPowerForMachine(machine: AppMachineSpec): LightsailPowerName {
  const power = LIGHTSAIL_POWERS.find(
    (candidate) => candidate.cpuCores === machine.cpuCores && candidate.memoryGb === machine.memoryGb,
  );
  if (!power) {
    throw new Error(
      `AWS Lightsail does not support ${machine.cpuCores} vCPU and ${machine.memoryGb} GB memory`,
    );
  }
  return power.name;
}

export function minimumMonthlyHostingCost(
  hosting: AppHostingSelection,
  machine: AppMachineSpec,
): number {
  if (hosting.type === 'sandbox') return 0;
  return lightsailMonthlyCostForMachine(machine);
}

export function lightsailMonthlyCostForMachine(machine: AppMachineSpec): number {
  const power = lightsailPowerForMachine(machine);
  return LIGHTSAIL_POWERS.find((candidate) => candidate.name === power)!.monthlyUsd;
}

export type AppHostingConfigurationValidation =
  | { ok: true; requiredMonthlyUsd: number }
  | {
    ok: false;
    code: 'app_hosting_budget_too_low';
    requiredMonthlyUsd: number;
    budgetUsd: number;
    message: string;
  };

/** Validate one App machine and budget against the selected hosting backend. */
export function validateAppHostingConfiguration(
  hosting: AppHostingSelection,
  machine: AppMachineSpec,
  budgetUsd: number,
): AppHostingConfigurationValidation {
  const requiredMonthlyUsd = minimumMonthlyHostingCost(hosting, machine);
  if (requiredMonthlyUsd <= budgetUsd) return { ok: true, requiredMonthlyUsd };
  return {
    ok: false,
    code: 'app_hosting_budget_too_low',
    requiredMonthlyUsd,
    budgetUsd,
    message: `AWS Lightsail requires at least $${requiredMonthlyUsd.toFixed(2)} per month for this machine`,
  };
}
