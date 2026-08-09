import { runDaytonaCi, type DaytonaCiInput } from './daytona-ci';
import { runPlatinumCi, type PlatinumCiInput } from './platinum-ci';

export type SandboxCiProvider = 'auto' | 'platinum' | 'daytona';

export function parseSandboxCiProvider(value: string | undefined): SandboxCiProvider {
  const provider = String(value || 'auto').toLowerCase();
  if (provider === 'auto' || provider === 'platinum' || provider === 'daytona') return provider;
  throw new Error(`TEST_SANDBOX_PROVIDER must be auto, platinum, or daytona; received ${value}`);
}

export async function runSandboxCi(
  input: {
    provider: SandboxCiProvider;
    platinum: PlatinumCiInput;
    daytona: DaytonaCiInput;
  },
  runners: {
    platinum: (input: PlatinumCiInput) => Promise<number>;
    daytona: (input: DaytonaCiInput) => Promise<number>;
  } = { platinum: runPlatinumCi, daytona: runDaytonaCi },
): Promise<number> {
  if (input.provider === 'platinum') return runners.platinum(input.platinum);
  if (input.provider === 'daytona') return runners.daytona(input.daytona);

  if (input.platinum.apiKey) {
    try {
      console.log('[sandbox-ci] provider=platinum mode=auto');
      return await runners.platinum(input.platinum);
    } catch (error) {
      if (!input.daytona.apiKey) throw error;
      console.warn(
        `[sandbox-ci] provider=platinum unavailable; fallback=daytona error=${String(error)}`,
      );
    }
  }
  if (!input.daytona.apiKey) {
    throw new Error('auto mode requires PLATINUM_API_KEY or DAYTONA_API_KEY');
  }
  console.log('[sandbox-ci] provider=daytona mode=auto');
  return runners.daytona(input.daytona);
}
