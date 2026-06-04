export type SandboxStatus = 'LIVE' | 'STARTING' | 'OFFLINE' | 'FAILED' | 'UNKNOWN';
export type DaytonaState = 'started' | 'stopped' | 'archived' | 'archiving' | string;
export type ServiceHealthStatus = 'running' | 'stopped' | 'starting' | 'error';
export type OverallHealthStatus = 'healthy' | 'starting' | 'degraded' | 'unhealthy';

export interface ServicesHealth {
  status: OverallHealthStatus;
  services: Record<string, ServiceHealthStatus>;
  critical_services: string[];
  error?: string;
}

export interface SandboxState {
  status: SandboxStatus;
  sandbox_id: string;
  project_id: string;
  daytona_state: DaytonaState;
  services_health?: ServicesHealth;
  last_checked: string;
  error?: string;
  vnc_preview?: string;
  sandbox_url?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  target?: string;
}

export function deriveSandboxStatus(
  daytonaState: DaytonaState | undefined | null,
  servicesHealth?: ServicesHealth | null
): SandboxStatus {
  if (!daytonaState) return 'UNKNOWN';
  if (daytonaState === 'started') {
    if (servicesHealth?.status === 'healthy') return 'LIVE';
    if (servicesHealth?.status === 'starting') return 'STARTING';
    return 'LIVE';
  }
  if (daytonaState === 'stopped' || daytonaState === 'archived') return 'OFFLINE';
  return 'UNKNOWN';
}

export function isSandboxUsable(status: SandboxStatus): boolean {
  return status === 'LIVE';
}

export function isSandboxTransitioning(status: SandboxStatus): boolean {
  return status === 'STARTING';
}

export function isSandboxOffline(status: SandboxStatus): boolean {
  return status === 'OFFLINE';
}

export function isSandboxFailed(status: SandboxStatus): boolean {
  return status === 'FAILED';
}

export function getSandboxStatusLabel(status: SandboxStatus): string {
  switch (status) {
    case 'LIVE': return 'Live';
    case 'STARTING': return 'Starting';
    case 'OFFLINE': return 'Offline';
    case 'FAILED': return 'Failed';
    default: return 'Unknown';
  }
}
