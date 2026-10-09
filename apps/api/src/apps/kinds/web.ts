/**
 * Kind `web`: a site or a server built from a deployment. Its lifecycle (idle
 * sleep, always-on keep-alive, budget stop) runs in the App workers
 * (../idle-reaper.ts, workers/), so it has no maintenance pass here.
 */
import type { AppCapability, AppHostingType, AppKindModule } from './index';

export const webKind: AppKindModule = {
  capabilities(hostingType: AppHostingType | null): AppCapability[] {
    const out: AppCapability[] = ['deployments', 'rollback', 'preview'];
    if (hostingType === 'sandbox') out.push('sleep');
    if (hostingType === 'static') out.push('static');
    return out;
  },
};
