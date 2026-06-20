/**
 * Instance configuration — single source of truth for regions and feature flags.
 * Region IDs must match JustAVPS provider regions (hel1 = EU/Finland).
 *
 * Default server type and location come from the backend API response
 * (GET /platform/sandbox/justavps/server-types returns defaultServerType + defaultLocation).
 * The fallbackRegion is only used until the API responds.
 *
 * NOTE: US region removed — EU-only deployments for cost optimisation.
 */
export const INSTANCE_CONFIG = {
  fallbackRegion: 'hel1',
  regions: [
    { id: 'hel1', label: 'Europe', shorthand: 'EU', icon: '\u{1F1EA}\u{1F1FA}', lat: 60.1699, lng: 24.9384, phi: 5.85, theta: 0.35 },
  ],
  regionPickerEnabled: false,
} as const;

export type RegionId = typeof INSTANCE_CONFIG.regions[number]['id'];
export type RegionInfo = typeof INSTANCE_CONFIG.regions[number];
