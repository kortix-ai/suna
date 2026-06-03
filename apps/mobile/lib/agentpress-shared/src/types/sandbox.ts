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

export function isSandboxUsable(status: SandboxStatus): boolean {
  return status === 'LIVE';
}
