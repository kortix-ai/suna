import { config, type SandboxProviderName } from '../config';
import { loadSandbox } from './backend';

// ── Provider resolution (share endpoints) ─────────────────────────────────────
// A thin policy layer over the single backend row loader: the share routes only
// proxy to *active* sandboxes on an allowed provider. The proxy data path
// (forwardToSandbox / resolvePreviewWsUpstream) uses backend.loadSandbox
// directly — there is no separate provider cache anymore.
//
// This lives outside `sandbox-proxy/index.ts` on purpose: lifecycle modules
// and the share route must reach the proxy's seams without a static import of
// `index.ts`, whose module body mounts the sub-apps at top level (see
// `module-graph.test.ts` — an edge back into `index.ts` from anything it
// imports makes those top-level reads order-dependent).

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
