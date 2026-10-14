import { config, type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { invalidateSandbox, loadSandbox } from './backend';

// ── Provider resolution (share endpoints) ─────────────────────────────────────
// A thin policy layer over the single backend row loader: the share routes only
// proxy to *active* sandboxes on an allowed provider. The proxy data path
// (forwardToSandbox / resolvePreviewWsUpstream) uses backend.loadSandbox
// directly — there is no separate provider cache anymore.

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
    logger.error(`[PREVIEW] Provider lookup failed for ${externalId}`, { error: String(err) });
    return null;
  }
}

/** Drop cached backend state for a sandbox (called on lifecycle transitions). */
export function invalidateProviderCache(externalId: string): void {
  invalidateSandbox(externalId);
}
