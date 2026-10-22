/**
 * What an App supports now. Clients branch on `capabilities`, never on how the
 * App was made. A route that needs a capability the App lacks answers 409
 * `app_capability_unsupported`.
 */
export const APP_CAPABILITIES = [
  'deployments',
  'rollback',
  'preview',
  'sleep',
  'static',
  'member_tokens',
  'machines',
  'scale',
  'exec',
  'volumes',
  'snapshots',
] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];

/** How the active deployment is served: `sandbox` (a server) or `static`; null when never deployed. */
export type AppHostingType = 'sandbox' | 'static';

/**
 * `hostingType`: the active deployment's. A server App runs machines (it
 * sleeps when idle, scales and runs commands); a static App is served from
 * storage. `hasVolumes`: the App has volumes (snapshots come with them).
 * `external`: the App is hosted elsewhere (`external_url`).
 */
export function appCapabilities(
  hostingType: AppHostingType | null,
  hasVolumes = false,
  external: { frameable: boolean } | null = null,
): AppCapability[] {
  // An external App is only a URL: Kortix frames it when the site allows that, and runs nothing.
  if (external) return external.frameable ? ['preview'] : [];
  const out: AppCapability[] = ['deployments', 'rollback', 'preview', 'member_tokens'];
  if (hostingType === 'sandbox') out.push('sleep', 'machines', 'scale', 'exec');
  if (hostingType === 'static') out.push('static');
  if (hasVolumes) out.push('volumes', 'snapshots');
  return out;
}

/** The 409 body for a route whose capability this App lacks. */
export function capabilityUnsupportedBody(capability: AppCapability) {
  return {
    error: `This App does not support ${capability.replaceAll('_', ' ')}.`,
    code: 'app_capability_unsupported',
    capability,
  };
}
