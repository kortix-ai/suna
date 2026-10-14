// `kortix apps releases|machines|scale|exec|volumes|labels` —
// releases are immutable, machines are replaceable, volumes persist.

import type { App, AppDeployment, AppMachine, AppVolume } from '@kortix/sdk';
import { emitJson, fail, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import { type ContextOptions, context, positiveInteger, resolveApp, scoped } from './apps-deploy.ts';

const positionals = (rest: string[]) => rest.filter((value) => !value.startsWith('-'));
const row = (cells: Array<[string, number]>) => `  ${cells.map(([text, width]) => pad(text, width)).join('')}\n`;
const dim = (text: string) => `${C.dim}${text}${C.reset}`;

/** `kortix apps releases <app>`: every release, newest first, the live one marked. */
export async function releasesCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = positionals(rest);
  if (!target) return fail('releases needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const { app, releases } = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    return { app: found, releases: await ctx.apps.deployments.list(found.app_id) };
  });
  if (json) {
    emitJson(releases);
    return 0;
  }
  process.stdout.write(`\n${row([['VERSION', 10], ['STATUS', 12], ['STRATEGY', 12], ['CREATED', 26], ['', 4]])}`);
  for (const release of releases as Array<AppDeployment & { strategy?: string | null }>) {
    const live = release.deployment_id === app.active_deployment_id ? status.ok('live') : '';
    process.stdout.write(row([[`v${release.version}`, 10], [release.status, 12], [release.strategy ?? '-', 12], [release.created_at, 26], [live, 4]]));
  }
  process.stdout.write('\n');
  return 0;
}

function machineLines(machines: AppMachine[]): string {
  if (machines.length === 0) return `  ${dim('No machines.')}\n`;
  let out = row([['MACHINE', 10], ['GROUP', 10], ['STATE', 10], ['RELEASE', 9], ['SIZE', 16], ['VOLUME', 12]]);
  for (const machine of machines) {
    out += row([
      [machine.machine_id.slice(0, 8), 10],
      [machine.process_group, 10],
      [machine.state, 10],
      [`v${machine.release.version}`, 9],
      [`${machine.vm.cpu} vCPU · ${machine.vm.memory_gb} GB`, 16],
      [machine.volume?.name ?? '-', 12],
    ]);
  }
  return out;
}

/** A machine by id or unique id prefix (the list shows 8 characters). */
function pickMachine(machines: AppMachine[], id: string): AppMachine {
  const matches = machines.filter((machine) => machine.machine_id === id || machine.machine_id.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length === 0 ? `No machine "${id}"` : `"${id}" matches ${matches.length} machines; use more characters`);
}

/** `kortix apps machines ls|start|stop|restart|destroy <app> [machine]`. */
export async function machinesCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [first, ...others] = positionals(rest);
  const actions = ['ls', 'list', 'start', 'stop', 'restart', 'destroy', 'rm'];
  const action = first && actions.includes(first) ? first : 'ls';
  const [target, machineArg] = first && actions.includes(first) ? others : [first, ...others];
  if (!target) return fail('machines needs an App id or slug');
  if (action !== 'ls' && action !== 'list' && !machineArg) return fail(`machines ${action} needs a machine id`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const machines = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    const list = await ctx.apps.machines.list(app.app_id);
    if (action === 'ls' || action === 'list') return list;
    const machineId = pickMachine(list, machineArg!).machine_id;
    if (action === 'start') return ctx.apps.machines.start(app.app_id, machineId);
    if (action === 'stop') return ctx.apps.machines.stop(app.app_id, machineId);
    if (action === 'restart') return ctx.apps.machines.restart(app.app_id, machineId);
    return ctx.apps.machines.destroy(app.app_id, machineId);
  });
  if (json) emitJson(machines);
  else process.stdout.write(`\n${machineLines(machines)}\n`);
  return 0;
}

/** `kortix apps scale count <app> <n> [--process <group>] [--new-volumes]` · `kortix apps scale show <app>`. */
export async function scaleCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const group = takeFlagValue(rest, ['--process', '--group']) ?? 'app';
  const newVolumes = takeFlagBool(rest, ['--new-volumes']);
  const [action, target, countArg] = positionals(rest);
  if (action !== 'count' && action !== 'show') return fail('scale needs "count <app> <n>" or "show <app>"');
  if (!target) return fail(`scale ${action} needs an App id or slug`);
  const count = action === 'count' ? Number(countArg) : undefined;
  if (action === 'count' && (countArg === undefined || !Number.isInteger(count) || count! < 0 || count! > 20)) {
    return fail('scale count needs a number of machines from 0 to 20');
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    if (action === 'show') return { scale: app.scale ?? {}, machines: await ctx.apps.machines.list(app.app_id) };
    return ctx.apps.scale(app.app_id, { [group]: count! }, { newVolumes });
  });
  if (json) {
    emitJson(result);
    return 0;
  }
  const groups = Object.entries(result.scale);
  process.stdout.write(`\n  ${action === 'count' ? status.ok(`${group}: ${count} machine${count === 1 ? '' : 's'} (applying)`) : 'Machines per process group'}\n`);
  for (const [name, n] of groups) process.stdout.write(`  ${pad(name, 12)}${n}\n`);
  process.stdout.write(`\n${machineLines(result.machines)}\n`);
  return 0;
}

/** `kortix apps exec <app> [--machine id] [--timeout s] -- <command…>`. Admins only. */
export async function execCommand(rest: string[], command: string[], options: ContextOptions, json: boolean): Promise<number> {
  const machineArg = takeFlagValue(rest, ['--machine']);
  const timeout = positiveInteger(takeFlagValue(rest, ['--timeout']), '--timeout');
  const [target] = positionals(rest);
  if (!target) return fail('exec needs an App id or slug');
  if (command.length === 0) return fail('exec needs a command after --, e.g. kortix apps exec db -- ls /data');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    const machineId = machineArg ? pickMachine(await ctx.apps.machines.list(app.app_id), machineArg).machine_id : undefined;
    return ctx.apps.exec(app.app_id, { command, ...(machineId ? { machine_id: machineId } : {}), ...(timeout ? { timeout_s: timeout } : {}) });
  });
  if (json) {
    emitJson(result);
    return result.exit_code === 0 ? 0 : 1;
  }
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  if (result.truncated) process.stderr.write(dim('  (output truncated at 1 MiB)\n'));
  return result.exit_code === 0 ? 0 : Math.min(255, Math.max(1, result.exit_code));
}

function volumeLines(volumes: AppVolume[]): string {
  if (volumes.length === 0) return `  ${dim('No volumes.')}\n`;
  let out = row([['VOLUME', 10], ['NAME', 14], ['GROUP', 10], ['USED', 10], ['SIZE', 8], ['ATTACHED', 10], ['STATUS', 10], ['SNAPSHOTS', 10]]);
  for (const volume of volumes) {
    out += row([
      [volume.volume_id.slice(0, 8), 10],
      [volume.name, 14],
      [volume.process_group, 10],
      [volume.used_bytes == null ? '-' : `${(volume.used_bytes / 1024 ** 3).toFixed(1)} GB`, 10],
      [`${volume.size_gb} GB`, 8],
      [volume.attached ? 'yes' : 'no', 10],
      [volume.status, 10],
      [`${volume.snapshot_retention_days} days`, 10],
    ]);
  }
  return out;
}

function pickVolume(volumes: AppVolume[], id: string): AppVolume {
  const matches = volumes.filter((volume) => volume.volume_id === id || volume.volume_id.startsWith(id) || volume.name === id);
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length === 0 ? `No volume "${id}"` : `"${id}" matches ${matches.length} volumes; use the volume id`);
}

/**
 * `kortix apps volumes ls|create|set|destroy|fork|snapshots|snapshot|restore`:
 *   ls <app> · create <app> <name> --size <gb> [--process g] · set <app> <vol> --retention <days>
 *   destroy <app> <vol> --yes · fork <app> <vol> <new-name> [--snapshot id]
 *   snapshots <app> <vol> · snapshot <app> <vol> · restore <app> <vol> <snapshot-id>
 */
export async function volumesCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const size = positiveInteger(takeFlagValue(rest, ['--size', '--size-gb']), '--size');
  const retention = positiveInteger(takeFlagValue(rest, ['--retention']), '--retention');
  const group = takeFlagValue(rest, ['--process', '--group']);
  const snapshotFlag = takeFlagValue(rest, ['--snapshot']);
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const VOLUME_ACTIONS = ['ls', 'list', 'create', 'set', 'extend', 'destroy', 'rm', 'fork', 'snapshots', 'snapshot', 'restore'];
  const words = positionals(rest);
  // `kortix apps volumes <app>` lists, like `machines`.
  const [action, target, third, fourth] = words[0] && VOLUME_ACTIONS.includes(words[0]) ? words : ['ls', ...words];
  if (!target) return fail(`volumes ${action} needs an App id or slug`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const output = await scoped(ctx, async (): Promise<{ data: unknown; text: string }> => {
    const app: App = await resolveApp(ctx.apps, target);
    const volumes = await ctx.apps.volumes.list(app.app_id);
    switch (action) {
      case 'ls':
      case 'list':
        return { data: volumes, text: volumeLines(volumes) };
      case 'create': {
        if (!third || !size) throw new Error('volumes create needs a name and --size <gb>');
        const volume = await ctx.apps.volumes.create(app.app_id, { name: third, size_gb: size, ...(group ? { process_group: group } : {}) });
        return { data: volume, text: `  ${status.ok(`created ${volume.name} (${volume.size_gb} GB)`)}\n` };
      }
      case 'set': {
        if (!third || !retention) throw new Error('volumes set needs a volume and --retention <days>');
        const volume = await ctx.apps.volumes.update(app.app_id, pickVolume(volumes, third).volume_id, { snapshot_retention_days: retention });
        return { data: volume, text: `  ${status.ok(`${volume.name} keeps daily snapshots ${volume.snapshot_retention_days} days`)}\n` };
      }
      case 'extend': {
        // A volume has the fixed size Platinum allots; the API refuses more (volume_fixed_size).
        if (!third || !size) throw new Error('volumes extend needs a volume and --size <gb>');
        const volume = await ctx.apps.volumes.update(app.app_id, pickVolume(volumes, third).volume_id, { size_gb: size });
        return { data: volume, text: `  ${status.ok(`${volume.name} is ${volume.size_gb} GB`)}\n` };
      }
      case 'destroy':
      case 'rm': {
        if (!third) throw new Error('volumes destroy needs a volume');
        const volume = pickVolume(volumes, third);
        if (!yes) throw new Error(`Destroying ${volume.name} deletes its data (a final snapshot is kept 7 days). Pass --yes.`);
        await ctx.apps.volumes.destroy(app.app_id, volume.volume_id, volume.name);
        return { data: { volume_id: volume.volume_id, status: 'destroying' }, text: `  ${status.ok(`destroyed ${volume.name}; its final snapshot is kept 7 days`)}\n` };
      }
      case 'fork': {
        if (!third || !fourth) throw new Error('volumes fork needs a volume and a name for the copy');
        const volume = await ctx.apps.volumes.fork(app.app_id, pickVolume(volumes, third).volume_id, { name: fourth, ...(snapshotFlag ? { snapshot_id: snapshotFlag } : {}) });
        return { data: volume, text: `  ${status.ok(`forked into ${volume.name} (unattached)`)}\n` };
      }
      case 'snapshots': {
        if (!third) throw new Error('volumes snapshots needs a volume');
        const snapshots = await ctx.apps.volumes.snapshots(app.app_id, pickVolume(volumes, third).volume_id);
        const text = snapshots.length === 0
          ? `  ${dim('No snapshots yet: the first daily snapshot is taken within a day.')}\n`
          : row([['SNAPSHOT', 26], ['KIND', 8], ['CREATED', 26]]) + snapshots.map((snapshot) => row([[snapshot.snapshot_id, 26], [snapshot.kind, 8], [snapshot.created_at, 26]])).join('');
        return { data: snapshots, text };
      }
      case 'snapshot': {
        if (!third) throw new Error('volumes snapshot needs a volume');
        const snapshot = await ctx.apps.volumes.snapshot(app.app_id, pickVolume(volumes, third).volume_id);
        return { data: snapshot, text: `  ${status.ok(`snapshot ${snapshot.snapshot_id}`)}\n` };
      }
      case 'restore': {
        if (!third || !fourth) throw new Error('volumes restore needs a volume and a snapshot id');
        const volume = await ctx.apps.volumes.restore(app.app_id, pickVolume(volumes, third).volume_id, fourth);
        return { data: volume, text: `  ${status.ok(`restoring ${volume.name} to ${fourth}; its machine restarts on it`)}\n` };
      }
      default:
        throw new Error(`unknown volumes action "${action}"`);
    }
  });
  if (json) emitJson(output.data);
  else process.stdout.write(`\n${output.text}\n`);
  return 0;
}

/** `kortix apps labels <app> [a,b]`: show, or replace (`--clear` removes all). */
export async function labelsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const clear = takeFlagBool(rest, ['--clear']);
  const [target, list] = positionals(rest);
  if (!target) return fail('labels needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    if (!clear && list === undefined) return found;
    const labels = clear ? [] : [...new Set(list!.split(',').map((label) => label.trim()).filter(Boolean))];
    return ctx.apps.update(found.app_id, { labels });
  });
  if (json) emitJson({ labels: app.labels ?? [] });
  else process.stdout.write(`\n  ${(app.labels ?? []).length ? (app.labels ?? []).join(', ') : dim('No labels.')}\n\n`);
  return 0;
}

/**
 * `kortix apps auth-env <app> [--json]`: what verifies the App's Kortix sign-in
 * tokens offline, as dotenv lines (public values, no secret): the project
 * issuer, the audience (the App id) and the key set inline (a `data:` URL). A backend that
 * fetches nothing (self-hosted Convex) takes them as deployment env:
 *   kortix apps auth-env db | while IFS='=' read -r k v; do printf '%s' "$v" | npx convex env set "$k"; done
 */
export async function authEnvCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = positionals(rest);
  if (!target) return fail('auth-env needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const env = await scoped(ctx, async () => ctx.apps.authEnv((await resolveApp(ctx.apps, target)).app_id));
  if (json) emitJson(env);
  else process.stdout.write(Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(''));
  return 0;
}
