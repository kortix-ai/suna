import { execOnHost } from '../../update/exec';
import { config } from '../../config';
import type { ResolvedEndpoint } from '../providers';
import { justavpsFetch } from '../providers/justavps';

export type InstanceLayerStatus = 'healthy' | 'degraded' | 'offline' | 'unknown';

export type InstanceRepairAction =
  | 'start_host'
  | 'reboot_host'
  | 'stop_host'
  | 'start_workload'
  | 'restart_workload'
  | 'stop_workload'
  | 'restart_runtime'
  | 'restart_service';

interface HttpProbeResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  text?: string;
  error?: string;
}

function unavailableProbe<T = any>(error: string): HttpProbeResult<T> {
  return { ok: false, status: 0, error };
}

export interface InstanceLayerActionDescriptor {
  action: InstanceRepairAction;
  label: string;
  serviceId?: string;
}

export interface InstanceLayerHealth {
  key: 'host' | 'workload' | 'runtime';
  label: string;
  status: InstanceLayerStatus;
  summary: string;
  actions: InstanceLayerActionDescriptor[];
  details: Record<string, unknown>;
}

export interface AdminInstanceHealth {
  sandbox_id: string;
  overall_status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  recommended_action: InstanceRepairAction | null;
  layers: {
    host: InstanceLayerHealth;
    workload: InstanceLayerHealth;
    runtime: InstanceLayerHealth;
  };
}

export function createUnsupportedInstanceHealth(
  sandboxId: string,
  provider: string,
): AdminInstanceHealth {
  const summary = `Detailed health is not available for provider: ${provider}`;
  return {
    sandbox_id: sandboxId,
    overall_status: 'unknown',
    recommended_action: null,
    layers: {
      host: {
        key: 'host',
        label: 'Host',
        status: 'unknown',
        summary,
        actions: [],
        details: { provider, supported: false },
      },
      workload: {
        key: 'workload',
        label: 'Workload',
        status: 'unknown',
        summary,
        actions: [],
        details: { provider, supported: false },
      },
      runtime: {
        key: 'runtime',
        label: 'Runtime',
        status: 'unknown',
        summary,
        actions: [],
        details: { provider, supported: false },
      },
    },
  };
}

interface JustAvpsMachineHealth {
  id: string;
  slug: string;
  status: string;
  ip: string | null;
  region: string | null;
  server_type: string | null;
  ready_at: string | null;
  provisioning_stage: string | null;
  health?: {
    last_heartbeat_at?: string | null;
  } | null;
}

function parseKeyValue(stdout: string): Record<string, string> {
  const entries = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('=');
      return index === -1 ? null : [line.slice(0, index), line.slice(index + 1)];
    })
    .filter((entry): entry is [string, string] => Array.isArray(entry));
  return Object.fromEntries(entries);
}

async function fetchEndpointJson<T = any>(
  endpoint: ResolvedEndpoint,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  timeoutMs = 2500,
): Promise<HttpProbeResult<T>> {
  try {
    const response = await fetch(`${endpoint.url}${path}`, {
      method,
      headers: {
        ...endpoint.headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => '');
    let data: T | undefined;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // ignore non-json response
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapHostStatus(machineStatus: string): InstanceLayerStatus {
  if (machineStatus === 'ready') return 'healthy';
  if (machineStatus === 'provisioning') return 'degraded';
  if (machineStatus === 'stopped' || machineStatus === 'deleted' || machineStatus === 'error') return 'offline';
  return 'unknown';
}

function summarizeHost(machine: JustAvpsMachineHealth): string {
  if (machine.status === 'ready') return 'Host ready';
  if (machine.status === 'provisioning') return `Host provisioning${machine.provisioning_stage ? ` · ${machine.provisioning_stage}` : ''}`;
  if (machine.status === 'stopped') return 'Host stopped';
  if (machine.status === 'error') return 'Host error';
  if (machine.status === 'deleted') return 'Host deleted';
  return `Host ${machine.status}`;
}

function summarizeWorkload(details: Record<string, string>, status: InstanceLayerStatus): string {
  if (status === 'healthy') return 'Workload container running';
  if (details.container_status === 'missing') return 'Workload container missing';
  if (details.workload_service && details.workload_service !== 'active') {
    return `Workload service ${details.workload_service}`;
  }
  if (details.container_status) return `Container ${details.container_status}`;
  return 'Workload state unknown';
}

function summarizeRuntime(
  kortix: HttpProbeResult<any>,
  globalHealth: HttpProbeResult<any>,
  sessionStatus: HttpProbeResult<any>,
  coreStatus: HttpProbeResult<any>,
  status: InstanceLayerStatus,
): string {
  if (status === 'healthy') return 'Core runtime healthy';
  if (!kortix.ok) {
    return kortix.status === 0 && kortix.error
      ? `Kortix core unavailable · ${kortix.error}`
      : 'Kortix core unavailable';
  }
  if (!globalHealth.ok) {
    return globalHealth.status === 0 && globalHealth.error
      ? `OpenCode not ready · ${globalHealth.error}`
      : 'OpenCode not ready';
  }
  if (!sessionStatus.ok) {
    return sessionStatus.status === 0 && sessionStatus.error
      ? `Session API failing · ${sessionStatus.error}`
      : 'Session API failing';
  }
  if (!coreStatus.ok) return 'Service manager unavailable';
  return 'Core runtime degraded';
}

function describeProbeFailure(result: HttpProbeResult<any>, label: string): string | null {
  if (result.ok) return null;
  if (result.status === 0) return `${label} timed out`;
  return `${label} returned ${result.status}`;
}

function deriveOverallStatus(
  host: InstanceLayerStatus,
  workload: InstanceLayerStatus,
  runtime: InstanceLayerStatus,
): AdminInstanceHealth['overall_status'] {
  if (host === 'offline' || workload === 'offline') return 'offline';
  if (host === 'degraded' || workload === 'degraded' || runtime === 'degraded') return 'degraded';
  if (host === 'healthy' && workload === 'healthy' && runtime === 'healthy') return 'healthy';
  return 'unknown';
}

function deriveRecommendedAction(
  host: InstanceLayerHealth,
  workload: InstanceLayerHealth,
  runtime: InstanceLayerHealth,
): InstanceRepairAction | null {
  if (host.status === 'offline') return host.details.machine_status === 'stopped' ? 'start_host' : 'reboot_host';
  if (workload.status !== 'healthy') return workload.status === 'offline' ? 'restart_workload' : 'start_workload';
  if (runtime.status !== 'healthy') return 'restart_runtime';
  return null;
}

export async function getJustAvpsInstanceHealth(
  sandboxId: string,
  externalId: string,
  endpoint?: ResolvedEndpoint | null,
  endpointError?: string | null,
): Promise<AdminInstanceHealth> {
  const machine = await justavpsFetch<JustAvpsMachineHealth>(`/machines/${externalId}`, { timeoutMs: 8000 });

  const hostLayer: InstanceLayerHealth = {
    key: 'host',
    label: 'Host',
    status: mapHostStatus(machine.status),
    summary: summarizeHost(machine),
    actions: machine.status === 'stopped'
      ? [{ action: 'start_host', label: 'Start host' }]
      : machine.status === 'deleted'
        ? []
        : [
            { action: 'reboot_host', label: 'Reboot host' },
            { action: 'stop_host', label: 'Stop host' },
          ],
    details: {
      machine_status: machine.status,
      ip: machine.ip,
      region: machine.region,
      server_type: machine.server_type,
      ready_at: machine.ready_at,
      provisioning_stage: machine.provisioning_stage,
      last_heartbeat_at: machine.health?.last_heartbeat_at ?? null,
    },
  };

  let workloadLayer: InstanceLayerHealth = {
    key: 'workload',
    label: 'Workload',
    status: hostLayer.status === 'healthy' ? 'unknown' : 'offline',
    summary: hostLayer.status === 'healthy'
      ? endpointError
        ? 'Workload checks unavailable'
        : 'Checking workload'
      : 'Host unavailable',
    actions: [
      { action: 'start_workload', label: 'Start workload' },
      { action: 'restart_workload', label: 'Restart workload' },
      { action: 'stop_workload', label: 'Stop workload' },
    ],
    details: endpointError ? { endpoint_error: endpointError } : {},
  };

  let runtimeLayer: InstanceLayerHealth = {
    key: 'runtime',
    label: 'Runtime',
    status: 'offline',
    summary: 'Runtime unavailable',
    actions: [{ action: 'restart_runtime', label: 'Restart core runtime' }],
    details: {
      services: [],
      ...(endpointError ? { endpoint_error: endpointError } : {}),
    },
  };

  if ((hostLayer.status === 'healthy' || hostLayer.status === 'degraded') && endpoint) {
    const workloadResult = await execOnHost(
      endpoint,
      [
        'printf "docker_service=%s\n" "$(systemctl is-active docker.service 2>/dev/null || echo unknown)"',
        'printf "workload_service=%s\n" "$(systemctl is-active justavps-docker.service 2>/dev/null || echo unknown)"',
        'printf "workload_enabled=%s\n" "$(systemctl is-enabled justavps-docker.service 2>/dev/null || echo unknown)"',
        'printf "container_status=%s\n" "$(docker inspect justavps-workload --format \"{{.State.Status}}\" 2>/dev/null || echo missing)"',
      ].join('; '),
      8,
    );

    const workloadDetails = workloadResult.success ? parseKeyValue(workloadResult.stdout) : {};
    const dockerService = workloadDetails.docker_service || 'unknown';
    const workloadService = workloadDetails.workload_service || 'unknown';
    const containerStatus = workloadDetails.container_status || 'unknown';

    let workloadStatus: InstanceLayerStatus = 'unknown';
    if (dockerService === 'active' && workloadService === 'active' && containerStatus === 'running') {
      workloadStatus = 'healthy';
    } else if (workloadService === 'activating' || containerStatus === 'restarting') {
      workloadStatus = 'degraded';
    } else if (
      dockerService === 'failed' ||
      dockerService === 'inactive' ||
      workloadService === 'failed' ||
      workloadService === 'inactive' ||
      containerStatus === 'missing' ||
      containerStatus === 'exited' ||
      containerStatus === 'dead'
    ) {
      workloadStatus = 'offline';
    }

    workloadLayer = {
      key: 'workload',
      label: 'Workload',
      status: workloadStatus,
      summary: summarizeWorkload(workloadDetails, workloadStatus),
      actions: workloadStatus === 'healthy'
        ? [
            { action: 'restart_workload', label: 'Restart workload' },
            { action: 'stop_workload', label: 'Stop workload' },
          ]
        : [
            { action: 'start_workload', label: 'Start workload' },
            { action: 'restart_workload', label: 'Restart workload' },
            { action: 'stop_workload', label: 'Stop workload' },
          ],
      details: {
        docker_service: dockerService,
        workload_service: workloadService,
        workload_enabled: workloadDetails.workload_enabled || 'unknown',
        container_status: containerStatus,
      },
    };

    if (workloadLayer.status === 'healthy' || workloadLayer.status === 'degraded') {
      const runtimeEndpoint = endpoint
        ? {
            url: `https://8000--${machine.slug}.${config.JUSTAVPS_PROXY_DOMAIN}`,
            headers: endpoint.headers,
          }
        : null;
      const [kortixHealth, globalHealth, sessionStatus, coreStatus] = await Promise.all([
        runtimeEndpoint ? fetchEndpointJson(runtimeEndpoint, '/kortix/health') : Promise.resolve(unavailableProbe('runtime endpoint unavailable')),
        runtimeEndpoint ? fetchEndpointJson(runtimeEndpoint, '/global/health') : Promise.resolve(unavailableProbe('runtime endpoint unavailable')),
        runtimeEndpoint ? fetchEndpointJson(runtimeEndpoint, '/session/status') : Promise.resolve(unavailableProbe('runtime endpoint unavailable')),
        runtimeEndpoint ? fetchEndpointJson(runtimeEndpoint, '/kortix/core/status') : Promise.resolve(unavailableProbe('runtime endpoint unavailable')),
      ]);

      const runtimeProbeIssues = [
        describeProbeFailure(kortixHealth, 'kortix health'),
        describeProbeFailure(globalHealth, 'global health'),
        describeProbeFailure(sessionStatus, 'session status'),
      ].filter((issue): issue is string => Boolean(issue));

      const services = Array.isArray(coreStatus.data?.services)
        ? coreStatus.data.services.map((service: any) => {
            let derivedStatus = service.status;
            let derivedLastError = service.lastError ?? null;

            if (service.id === 'opencode-serve' && runtimeProbeIssues.length > 0) {
              derivedStatus = 'unresponsive';
              derivedLastError = runtimeProbeIssues.join(' · ');
            } else if (service.id === 'svc-kortix-master' && !kortixHealth.ok) {
              derivedStatus = 'unresponsive';
              derivedLastError = describeProbeFailure(kortixHealth, 'kortix health');
            }

            return {
              id: service.id,
              name: service.name,
              scope: service.scope,
              status: derivedStatus,
              lastError: derivedLastError,
            };
          })
        : [];

      const degradedServices = services.filter((service: any) => service.status === 'failed' || service.status === 'backoff' || service.status === 'unresponsive');

      let runtimeStatus: InstanceLayerStatus = 'unknown';
      if (kortixHealth.ok && globalHealth.ok && sessionStatus.ok && degradedServices.length === 0) {
        runtimeStatus = 'healthy';
      } else if (kortixHealth.status === 0 && globalHealth.status === 0 && sessionStatus.status === 0) {
        runtimeStatus = 'offline';
      } else {
        runtimeStatus = 'degraded';
      }

      runtimeLayer = {
        key: 'runtime',
        label: 'Runtime',
        status: runtimeStatus,
        summary: summarizeRuntime(kortixHealth, globalHealth, sessionStatus, coreStatus, runtimeStatus),
        actions: [
          { action: 'restart_runtime', label: 'Restart core runtime' },
          ...services.map((service: any) => ({
            action: 'restart_service' as const,
            label: `Restart ${service.name}`,
            serviceId: service.id,
          })),
        ],
        details: {
          kortix_health: { status: kortixHealth.status, data: kortixHealth.data ?? null, error: kortixHealth.error ?? null },
          global_health: { status: globalHealth.status, data: globalHealth.data ?? null, error: globalHealth.error ?? null },
          session_status: { status: sessionStatus.status, data: sessionStatus.data ?? null, error: sessionStatus.error ?? null },
          runtime_probe_issues: runtimeProbeIssues,
          services,
        },
      };
    }
  }

  const overall = deriveOverallStatus(hostLayer.status, workloadLayer.status, runtimeLayer.status);
  return {
    sandbox_id: sandboxId,
    overall_status: overall,
    recommended_action: deriveRecommendedAction(hostLayer, workloadLayer, runtimeLayer),
    layers: {
      host: hostLayer,
      workload: workloadLayer,
      runtime: runtimeLayer,
    },
  };
}
