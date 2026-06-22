export const STRIDE = 100;
// Shared internal bearer token between a worktree's API (/internal/gateway/*)
// and its standalone gateway. Fixed dev constant — both apiLaunchEnv and
// gatewayLaunchEnv inject the same value so the gateway authenticates locally.
export const DEV_GATEWAY_INTERNAL_TOKEN = 'wt-gateway-internal-dev';
export const BASE = {
  web: 13000,
  api: 13008,
  gateway: 13090,
  sbApi: 13321,
  sbDb: 13322,
  sbStudio: 13323,
  sbInbucket: 13324,
  sbAnalytics: 13327,
  sbPooler: 13329,
} as const;
export type PortName = keyof typeof BASE;
export type Ports = Record<PortName, number>;

export function computePorts(slot: number): Ports {
  const out = {} as Ports;
  for (const k of Object.keys(BASE) as PortName[]) out[k] = BASE[k] + slot * STRIDE;
  return out;
}
