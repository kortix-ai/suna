/**
 * Shared sandbox state types for AgentPress
 * Used by both frontend (Next.js) and mobile (React Native)
 */

/**
 * Unified sandbox status that combines Daytona state + service health
 */
export type SandboxStatus =
  | 'LIVE'      // Daytona STARTED + all services healthy
  | 'STARTING'  // Daytona transitioning OR services starting up
  | 'OFFLINE'   // Daytona STOPPED/ARCHIVED (intentionally off)
  | 'FAILED'    // Daytona STARTED but services unhealthy/degraded
  | 'UNKNOWN';  // Cannot determine state

/**
 * Raw Daytona states from the SDK
 */
export type DaytonaState =
  | 'started'
  | 'stopped'
  | 'archived'
  | 'archiving'
  | string; // Allow unknown states

/**
 * Service health status from sandbox container /health endpoint
 */
export type ServiceHealthStatus = 'running' | 'stopped' | 'starting' | 'error';

/**
 * Overall health status from sandbox container
 */
export type OverallHealthStatus = 'healthy' | 'starting' | 'degraded' | 'unhealthy';

/**
 * Service health response from sandbox container /health endpoint
 */
export interface ServicesHealth {
  status: OverallHealthStatus;
  services: Record<string, ServiceHealthStatus>;
  critical_services: string[];
  error?: string;
}

/**
 * Complete sandbox state response from backend /project/{id}/sandbox/status
 * Note: Uses snake_case to match backend API response format
 */
export interface SandboxState {
  /** Unified status: LIVE, STARTING, OFFLINE, FAILED, UNKNOWN */
  status: SandboxStatus;
  /** Sandbox ID from Daytona */
  sandbox_id: string;
  /** Project ID this sandbox belongs to */
  project_id: string;
  /** Raw Daytona state: started, stopped, archived, archiving */
  daytona_state: DaytonaState;
  /** Health info from sandbox container (only when Daytona state is started) */
  services_health?: ServicesHealth;
  /** ISO timestamp when this status was checked */
  last_checked: string;
  /** Error message if status check failed */
  error?: string;
  /** VNC preview URL */
  vnc_preview?: string;
  /** Sandbox base URL */
  sandbox_url?: string;
  /** CPU cores allocated */
  cpu?: number;
  /** Memory in GB allocated */
  memory?: number;
  /** Disk in GB allocated */
  disk?: number;
  /** Target/region where sandbox is running */
  target?: string;
}

/**
 * Derive unified status from Daytona state and service health
 *
 * Logic:
 * - OFFLINE: Daytona stopped/archived
 * - STARTING: Daytona archiving OR Daytona started but services not healthy yet
 * - LIVE: Daytona started AND services healthy
 * - FAILED: Daytona started but services degraded/unhealthy
 * - UNKNOWN: Cannot determine
 */
export function deriveSandboxStatus(
  daytonaState: DaytonaState | undefined | null,
  servicesHealth?: ServicesHealth | null
): SandboxStatus {
  if (!daytonaState) {
    return 'UNKNOWN';
  }

  const normalizedState = daytonaState.toLowerCase();

  // If Daytona says stopped/archived, it's offline regardless of health
  if (normalizedState === 'stopped' || normalizedState === 'archived') {
    return 'OFFLINE';
  }

  // If archiving or stopping, it's transitioning - treat as STARTING for faster polling
  if (normalizedState === 'archiving' || normalizedState === 'stopping') {
    return 'STARTING';
  }

  // Daytona says started - check service health
  if (normalizedState === 'started') {
    if (!servicesHealth) {
      // No health info yet - assume starting
      return 'STARTING';
    }

    switch (servicesHealth.status) {
      case 'healthy':
        return 'LIVE';
      case 'starting':
        return 'STARTING';
      case 'degraded':
      case 'unhealthy':
        return 'FAILED';
      default:
        return 'UNKNOWN';
    }
  }

  return 'UNKNOWN';
}

/**
 * Check if sandbox is in a usable state (can execute operations)
 */
export function isSandboxUsable(status: SandboxStatus): boolean {
  return status === 'LIVE';
}

/**
 * Check if sandbox is transitioning (starting up or shutting down)
 */
export function isSandboxTransitioning(status: SandboxStatus): boolean {
  return status === 'STARTING';
}

/**
 * Check if sandbox is offline and needs to be started
 */
export function isSandboxOffline(status: SandboxStatus): boolean {
  return status === 'OFFLINE';
}

/**
 * Check if sandbox has failed and may need intervention
 */
export function isSandboxFailed(status: SandboxStatus): boolean {
  return status === 'FAILED';
}

/**
 * Get human-readable label for status
 */
export function getSandboxStatusLabel(status: SandboxStatus): string {
  switch (status) {
    case 'LIVE':
      return 'Live';
    case 'STARTING':
      return 'Starting...';
    case 'OFFLINE':
      return 'Offline';
    case 'FAILED':
      return 'Failed';
    case 'UNKNOWN':
    default:
      return 'Unknown';
  }
}
