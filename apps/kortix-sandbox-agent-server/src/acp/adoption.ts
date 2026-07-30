import type { SandboxBootState } from '../routes/health';
import { parseAcpHarnessId, type AcpHarnessId } from './harness-registry';

type AcpRuntimeStarter = {
  getOrCreate(serverId: string, harness: AcpHarnessId): Promise<unknown>;
};

export async function adoptManagedAcpRuntime(
  bootState: SandboxBootState,
  runtime: AcpRuntimeStarter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const harness = parseAcpHarnessId(env.KORTIX_RUNTIME_HARNESS);
  const serverId =
    (env.KORTIX_ACP_SERVER_ID ?? '').trim() ||
    (harness ? (env.KORTIX_SESSION_ID ?? '').trim() : '');

  bootState.acpHarness = harness;
  bootState.acpServerId = serverId || null;
  bootState.acpRuntimeReady = false;
  bootState.acpRuntimeError = null;
  if (!harness || !serverId) return false;

  bootState.initialOpenCodeSessionRequired = false;
  try {
    await runtime.getOrCreate(serverId, harness);
    bootState.acpRuntimeReady = true;
  } catch (error) {
    bootState.acpRuntimeError = error instanceof Error ? error.message : String(error);
  }
  return true;
}
