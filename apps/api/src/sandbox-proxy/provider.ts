import { config, type SandboxProviderName } from '../config';
import { invalidateSandbox, loadSandbox } from './backend';

export type ResolvedProvider = {
  provider: SandboxProviderName;
  baseUrl: string;
  serviceKey: string;
};

export async function resolveProvider(externalId: string): Promise<ResolvedProvider | null> {
  try {
    const record = await loadSandbox(externalId);
    if (!record || record.status !== 'active') return null;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(record.provider)) {
      return null;
    }
    return {
      provider: record.provider as SandboxProviderName,
      baseUrl: record.baseUrl,
      serviceKey: record.serviceKey ?? '',
    };
  } catch (err) {
    console.error(`[PREVIEW] Provider lookup failed for ${externalId}:`, err);
    return null;
  }
}

/** Drop cached backend state for a sandbox (called on lifecycle transitions). */
export function invalidateProviderCache(externalId: string): void {
  invalidateSandbox(externalId);
}
