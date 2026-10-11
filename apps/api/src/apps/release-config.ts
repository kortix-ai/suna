/**
 * The release config a deploy stores (`app_deployments.config`), resolved by
 * `@kortix/shared/app-config`. The deploy engine reads only the resolved form;
 * a release from before release configs gets one derived from its runtime spec
 * and the App row.
 */
import { z } from '@hono/zod-openapi';
import {
  appReleaseConfigIssues,
  appServicesFor,
  resolveAppReleaseConfig,
  type AppConfigIssue,
  type AppReleaseConfig,
  type AppReleaseConfigInput,
} from '@kortix/shared/app-config';

const int = () => z.number().int();
const CheckInput = z.object({
  type: z.enum(['http', 'tcp']).optional(),
  port: int().optional(),
  path: z.string().max(2048).optional(),
  interval_s: int().optional(),
  timeout_s: int().optional(),
  grace_period_s: int().optional(),
}).strict();
const serviceFields = {
  internal_port: int().optional(),
  protocol: z.enum(['http', 'tcp']).optional(),
  access: z.enum(['public', 'app', 'admins']).optional(),
  auto_stop_machines: z.enum(['off', 'stop', 'suspend']).optional(),
  auto_start_machines: z.boolean().optional(),
  min_machines_running: int().optional(),
  processes: z.array(z.string().max(32)).max(20).optional(),
  checks: z.array(CheckInput).max(10).optional(),
};
const VmInput = z.object({
  cpu: int().optional(),
  memory_gb: int().optional(),
  disk_gb: int().optional(),
  processes: z.array(z.string().max(32)).max(20).optional(),
}).strict();

/** `kortix.yaml` `apps.<name>` on the wire. Every field is optional. */
export const ReleaseConfigSchema = z.object({
  processes: z.record(z.string().max(32), z.string().max(4096)).optional(),
  http_service: z.object(serviceFields).strict().optional(),
  services: z.array(z.object({ name: z.string().max(31).optional(), ...serviceFields }).strict()).max(10).optional(),
  mounts: z.array(z.object({
    source: z.string().max(30).optional(),
    destination: z.string().max(1024).optional(),
    initial_size_gb: int().optional(),
    snapshot_retention_days: int().optional(),
    processes: z.array(z.string().max(32)).max(20).optional(),
  }).strict()).max(8).optional(),
  vm: z.union([VmInput, z.array(VmInput).max(20)]).optional(),
  deploy: z.object({
    strategy: z.enum(['rolling', 'immediate', 'bluegreen', 'canary']).optional(),
    release_command: z.string().max(4000).nullable().optional(),
  }).strict().optional(),
  port: int().optional(),
  command: z.string().max(4096).optional(),
  readiness_path: z.string().max(2048).optional(),
  always_on: z.boolean().optional(),
  resources: z.object({ cpu: int().optional(), memory_gb: int().optional(), disk_gb: int().optional() }).strict().optional(),
}).strict().openapi('KortixAppReleaseConfig');

type AppSize = { cpuCores: number; memoryGb: number; diskGb: number };

const resources = (app: AppSize) => ({ cpu: app.cpuCores, memory_gb: app.memoryGb, disk_gb: app.diskGb });

/**
 * The config a release from today's source fields runs: one `app` group on
 * the source port, sized like the App. It sets no always-on (the App row's
 * `always_on` stays the live switch) and no check (appd keeps the image's
 * readiness path, so an existing App behaves exactly as before).
 */
export function derivedReleaseConfig(app: AppSize, port: number | undefined): AppReleaseConfig {
  return resolveAppReleaseConfig({ ...(port ? { port } : {}), always_on: false, resources: resources(app) });
}

/**
 * Resolve and validate the config a deploy asked for. Absent: derived from
 * the source port and the App row. The App's size is the default VM, and the
 * source port the primary service, unless the config names its own.
 */
export function resolveDeployConfig(
  input: AppReleaseConfigInput | undefined,
  app: AppSize,
  sourcePort: number | undefined,
): { config: AppReleaseConfig } | { issues: AppConfigIssue[] } {
  if (!input) return { config: derivedReleaseConfig(app, sourcePort) };
  const port = input.port ?? input.http_service?.internal_port ?? sourcePort;
  const config = resolveAppReleaseConfig({ resources: resources(app), ...input, ...(port ? { port } : {}) });
  const issues = appReleaseConfigIssues(config);
  return issues.length > 0 ? { issues } : { config };
}

/** The config a release runs: its own, or one derived for a release from before the model. */
export function releaseConfigOf(
  deployment: { config: unknown; runtimeSpec: unknown },
  app: AppSize,
): AppReleaseConfig {
  if (deployment.config) return deployment.config as AppReleaseConfig;
  const spec = (deployment.runtimeSpec ?? {}) as { target_port?: number };
  // Every release from before the model serves HTTP through the supervisor's
  // ingress, so it always has a service (never a worker group). The port is
  // nominal when the spec does not record one.
  return derivedReleaseConfig(app, spec.target_port ?? 8080);
}

/** The groups that serve the App's own host (the `http` service), else every group. */
export function servingGroups(config: AppReleaseConfig): string[] {
  const http = config.services.find((service) => service.name === 'http');
  return http ? http.processes : Object.keys(config.processes);
}

/**
 * Never idle-stopped: a group with no service (a worker; nothing would wake
 * it), any App with `always_on` (the App row is the live switch), or a group
 * whose service turns autostop off.
 */
export function groupAlwaysOn(app: { alwaysOn: boolean }, config: AppReleaseConfig, group: string): boolean {
  const services = appServicesFor(config, group);
  return services.length === 0 || app.alwaysOn || services.some((service) => service.auto_stop_machines === 'off');
}

/** Machines of the group the idle reaper leaves running (`min_machines_running`). */
export function groupMinRunning(config: AppReleaseConfig, group: string): number {
  return Math.max(0, ...appServicesFor(config, group).map((service) => service.min_machines_running));
}

/** Machines a group runs: `apps.scale[group]`, else one. */
export function groupScale(scale: unknown, group: string): number {
  const count = (scale as Record<string, unknown> | null)?.[group];
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 1;
}
