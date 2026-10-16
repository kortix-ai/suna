/**
 * Machines, scale, exec and volumes of an App:
 *
 *   GET    /projects/:projectId/apps/:appId/machines                         read
 *   POST   /projects/:projectId/apps/:appId/machines/:machineId/{start|stop|restart}  deploy
 *   DELETE /projects/:projectId/apps/:appId/machines/:machineId              deploy
 *   PUT    /projects/:projectId/apps/:appId/scale                            deploy
 *   POST   /projects/:projectId/apps/:appId/exec                             admin
 *   GET    /projects/:projectId/apps/:appId/volumes                          read
 *   POST   /projects/:projectId/apps/:appId/volumes                          deploy
 *   PATCH  /projects/:projectId/apps/:appId/volumes/:volumeId                deploy
 *   DELETE /projects/:projectId/apps/:appId/volumes/:volumeId?confirm=<name> admin
 *   GET    /projects/:projectId/apps/:appId/volumes/:volumeId/snapshots      read
 *   POST   /projects/:projectId/apps/:appId/volumes/:volumeId/snapshots      deploy
 *   POST   /projects/:projectId/apps/:appId/volumes/:volumeId/restore        admin
 *   POST   /projects/:projectId/apps/:appId/volumes/:volumeId/fork           deploy
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { auth, errors, json } from '../openapi';
import { projectsApp } from '../projects/surface';
import {
  AppFleetError,
  MAX_GROUP_SCALE,
  destroyMachine,
  execInMachine,
  listAppMachines,
  restartMachine,
  setAppScale,
  startMachine,
  stopMachine,
  restoreAppVolume,
} from './fleet';
import { authorizedProject, visibleApp, type AppPermission } from './route-access';
import {
  AppVolumeError,
  createAppVolume,
  createVolumeSnapshot,
  destroyVolume,
  forkVolume,
  getAppVolume,
  listAppVolumes,
  listVolumeSnapshots,
  updateAppVolume,
  volumeInfo,
  type AppVolumeRow,
} from './volumes';
import type { AppVolumeInfo } from './volume-store';
import { AppLimitError, AppAccountUnfundedError } from './limits';

const AppParams = z.object({ projectId: z.string().uuid(), appId: z.string().uuid() });
const MachineParams = AppParams.extend({ machineId: z.string().uuid() });
const VolumeParams = AppParams.extend({ volumeId: z.string().uuid() });
const Open = z.object({}).passthrough();
/** A handler's context, for the shared helpers below (each route keeps its own typed context). */
type RouteContext = Context<AppEnv, string, any>;

function volumeJson(volume: AppVolumeRow, live: AppVolumeInfo | null = null) {
  return {
    volume_id: volume.volumeId,
    name: volume.name,
    process_group: volume.processGroup,
    machine_id: volume.machineId,
    size_gb: live?.size_gb ?? volume.sizeGb,
    /** Bytes in use and the last commit, read live from the provider; null when unknown. */
    used_bytes: live?.used_bytes ?? null,
    last_commit_at: live?.last_commit_at ?? null,
    status: volume.status,
    attached: Boolean(volume.attachedRuntimeId),
    snapshot_retention_days: volume.snapshotRetentionDays,
    created_at: volume.createdAt.toISOString(),
  };
}

/** The documented answer of a fleet or volume refusal, or null. */
function refusal(c: RouteContext, error: unknown): Response | null {
  if (error instanceof AppFleetError || error instanceof AppVolumeError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof AppLimitError) return c.json({ error: error.message, code: error.code, ...error.detail }, error.status);
  if (error instanceof AppAccountUnfundedError) return c.json({ error: error.message, code: error.reason, ...error.detail }, 402);
  return null;
}

async function gate(c: RouteContext, permission: AppPermission) {
  const { projectId, appId } = c.req.param() as { projectId: string; appId: string };
  const loaded = await authorizedProject(c, projectId, permission);
  if (loaded instanceof Response) return loaded;
  const app = await visibleApp(projectId, appId, loaded.userId);
  if (!app) return c.json({ error: 'Not found' }, 404);
  return { loaded, app };
}

/** Run a route body; a documented refusal becomes its answer. */
async function answer(c: RouteContext, body: () => Promise<Response>): Promise<never> {
  try {
    return (await body()) as never;
  } catch (error) {
    const refused = refusal(c, error);
    if (refused) return refused as never;
    throw error;
  }
}

export function registerAppFleetRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/machines', tags: ['apps'], summary: 'List an App\'s machines', ...auth,
      description: 'Every machine of the App: its process group, state (started, starting, stopped, stopping), release, VM and volume.',
      request: { params: AppParams },
      responses: { 200: json(Open, 'Machines'), ...errors(403, 404) },
    }),
    async (c) => {
      const gated = await gate(c, 'read');
      if (gated instanceof Response) return gated as never;
      return c.json({ machines: await listAppMachines(gated.app) }, 200) as never;
    },
  );

  for (const action of ['start', 'stop', 'restart'] as const) {
    projectsApp.openapi(
      createRoute({
        method: 'post', path: `/{projectId}/apps/{appId}/machines/{machineId}/${action}`, tags: ['apps'],
        summary: `${action[0]!.toUpperCase()}${action.slice(1)} an App machine`, ...auth,
        request: { params: MachineParams },
        responses: { 200: json(Open, 'Machines'), ...errors(402, 403, 404, 409, 429) },
      }),
      async (c) => {
        const gated = await gate(c, 'deploy');
        if (gated instanceof Response) return gated as never;
        const { machineId } = c.req.valid('param');
        return answer(c, async () => {
          if (action === 'start') await startMachine(gated.app, machineId);
          else if (action === 'stop') await stopMachine(gated.app, machineId);
          else await restartMachine(gated.app, machineId);
          return c.json({ machines: await listAppMachines(gated.app) }, 200);
        });
      },
    );
  }

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}/machines/{machineId}', tags: ['apps'], summary: 'Destroy an App machine', ...auth,
      description: 'Destroys the machine. Its volume stays (a later machine of the group takes it), and its group runs one machine fewer.',
      request: { params: MachineParams },
      responses: { 200: json(Open, 'Machines'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      return answer(c, async () => {
        await destroyMachine(gated.app, c.req.valid('param').machineId);
        return c.json({ machines: await listAppMachines(gated.app) }, 200);
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put', path: '/{projectId}/apps/{appId}/scale', tags: ['apps'], summary: 'Scale an App', ...auth,
      description:
        `Machines per process group (0 to ${MAX_GROUP_SCALE}). Applied in the background: answers 202 with the new ` +
        'scale. A group that mounts a volume runs one machine (409 `volume_single_machine`) unless `new_volumes` ' +
        'is true: each new machine then gets its own, empty volume and serves different data. A scaled-down machine ' +
        'keeps its volume for the next one.',
      request: { params: AppParams, body: { content: { 'application/json': { schema: z.object({
        count: z.record(z.string().max(32), z.number().int()),
        new_volumes: z.boolean().optional(),
      }) } } } },
      responses: { 202: json(Open, 'Scale'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      return answer(c, async () => {
        const body = c.req.valid('json');
        const scale = await setAppScale(gated.app, body.count, { newVolumes: body.new_volumes });
        return c.json({ scale, machines: await listAppMachines(gated.app) }, 202);
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/exec', tags: ['apps'], summary: 'Run a command in an App machine', ...auth,
      description:
        'Runs one command in a machine (a running machine of the active release unless `machine_id` names one) and ' +
        'answers with its exit code and output (each stream up to 1 MiB; `truncated` says when it was cut). ' +
        'Project admins only; audited.',
      request: {
        params: AppParams,
        body: { content: { 'application/json': { schema: z.object({
          command: z.array(z.string().max(8192)).min(1).max(256),
          machine_id: z.string().uuid().optional(),
          timeout_s: z.number().int().min(1).max(300).optional(),
        }) } } },
      },
      responses: { 200: json(Open, 'Result'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'admin');
      if (gated instanceof Response) return gated as never;
      const body = c.req.valid('json');
      return answer(c, async () => c.json(await execInMachine(gated.app, {
        command: body.command,
        machineId: body.machine_id,
        timeoutS: body.timeout_s,
      }), 200));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/volumes', tags: ['apps'], summary: 'List an App\'s volumes', ...auth,
      request: { params: AppParams },
      responses: { 200: json(Open, 'Volumes'), ...errors(403, 404) },
    }),
    async (c) => {
      const gated = await gate(c, 'read');
      if (gated instanceof Response) return gated as never;
      const volumes = await listAppVolumes(gated.app.appId);
      const live = await Promise.all(volumes.map(volumeInfo));
      return c.json({ volumes: volumes.map((volume, index) => volumeJson(volume, live[index])) }, 200) as never;
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/volumes', tags: ['apps'], summary: 'Create an App volume', ...auth,
      description: 'Pre-creates a volume. A machine of its process group whose mount names it takes it. Volumes need Platinum.',
      request: {
        params: AppParams,
        body: { content: { 'application/json': { schema: z.object({
          name: z.string().max(30),
          size_gb: z.number().int(),
          process_group: z.string().max(32).optional(),
          snapshot_retention_days: z.number().int().optional(),
        }) } } },
      },
      responses: { 201: json(Open, 'Volume'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      const body = c.req.valid('json');
      return answer(c, async () => c.json(volumeJson(await createAppVolume({
        appId: gated.app.appId,
        accountId: gated.app.accountId,
        name: body.name,
        sizeGb: body.size_gb,
        group: body.process_group,
        retentionDays: body.snapshot_retention_days,
      })), 201));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch', path: '/{projectId}/apps/{appId}/volumes/{volumeId}', tags: ['apps'], summary: 'Update an App volume', ...auth,
      description:
        '`snapshot_retention_days` is 1 to 60. A volume has the fixed size the provider allots at create (100 GB on ' +
        'Platinum today): a `size_gb` above it is refused with 400 `volume_fixed_size`.',
      request: {
        params: VolumeParams,
        body: { content: { 'application/json': { schema: z.object({
          size_gb: z.number().int().optional(),
          snapshot_retention_days: z.number().int().optional(),
        }) } } },
      },
      responses: { 200: json(Open, 'Volume'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      const body = c.req.valid('json');
      return answer(c, async () => c.json(volumeJson(await updateAppVolume(gated.app.appId, c.req.valid('param').volumeId, {
        sizeGb: body.size_gb,
        retentionDays: body.snapshot_retention_days,
      })), 200));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}/volumes/{volumeId}', tags: ['apps'], summary: 'Destroy an App volume', ...auth,
      description:
        'Needs `?confirm=<volume name>`. Refused with 409 `volume_attached` while a machine mounts it. A final ' +
        'snapshot is taken; the data is purged after 7 days. Project admins only.',
      request: { params: VolumeParams, query: z.object({ confirm: z.string().optional() }) },
      responses: { 200: json(Open, 'Destroyed'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'admin');
      if (gated instanceof Response) return gated as never;
      const { volumeId } = c.req.valid('param');
      return answer(c, async () => {
        const volume = await getAppVolume(gated.app.appId, volumeId);
        if (c.req.valid('query').confirm !== volume.name) {
          return c.json({ error: `Destroying a volume deletes its data: pass confirm=${volume.name}.`, code: 'confirmation_required' }, 400);
        }
        await destroyVolume(gated.app.appId, volumeId);
        return c.json({ volume_id: volumeId, status: 'destroying', purge_after_days: 7 }, 200);
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/volumes/{volumeId}/snapshots', tags: ['apps'], summary: 'List a volume\'s snapshots', ...auth,
      description: 'Daily automatic snapshots (kept `snapshot_retention_days`), manual ones, and the final one of a destroyed volume.',
      request: { params: VolumeParams },
      responses: { 200: json(Open, 'Snapshots'), ...errors(403, 404) },
    }),
    async (c) => {
      const gated = await gate(c, 'read');
      if (gated instanceof Response) return gated as never;
      return answer(c, async () => c.json({ snapshots: await listVolumeSnapshots(gated.app.appId, c.req.valid('param').volumeId) }, 200));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/volumes/{volumeId}/snapshots', tags: ['apps'], summary: 'Snapshot a volume', ...auth,
      request: { params: VolumeParams },
      responses: { 201: json(Open, 'Snapshot'), ...errors(403, 404) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      return answer(c, async () => c.json(await createVolumeSnapshot(gated.app.appId, c.req.valid('param').volumeId), 201));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/volumes/{volumeId}/restore', tags: ['apps'], summary: 'Restore a volume', ...auth,
      description:
        'Makes a snapshot the volume\'s contents again (nothing is lost: it is a new version). The machine that mounts ' +
        'the volume is stopped first and comes back on it in the background (202). Project admins only.',
      request: { params: VolumeParams, body: { content: { 'application/json': { schema: z.object({ snapshot_id: z.string().max(64) }) } } } },
      responses: { 202: json(Open, 'Restoring'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'admin');
      if (gated instanceof Response) return gated as never;
      const { volumeId } = c.req.valid('param');
      return answer(c, async () => {
        await restoreAppVolume(gated.app, volumeId, c.req.valid('json').snapshot_id);
        return c.json(volumeJson(await getAppVolume(gated.app.appId, volumeId)), 202);
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/volumes/{volumeId}/fork', tags: ['apps'], summary: 'Fork a volume', ...auth,
      description: 'A new, unattached volume of the App from a snapshot (or the current contents): instant, whatever the size.',
      request: { params: VolumeParams, body: { content: { 'application/json': { schema: z.object({ name: z.string().max(30), snapshot_id: z.string().max(64).optional() }) } } } },
      responses: { 201: json(Open, 'Volume'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const gated = await gate(c, 'deploy');
      if (gated instanceof Response) return gated as never;
      const body = c.req.valid('json');
      return answer(c, async () => c.json(volumeJson(await forkVolume(gated.app.appId, c.req.valid('param').volumeId, {
        name: body.name,
        snapshotId: body.snapshot_id,
      })), 201));
    },
  );
}
