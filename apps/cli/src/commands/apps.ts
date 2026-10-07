import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App, AppDeployment, UpdateAppInput } from '@kortix/sdk';

import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { accessCommand, accessLinkCommand } from './apps-access.ts';
import {
  type ContextOptions,
  commandArg,
  context,
  csv,
  deployFlags,
  loadManifestAppDefaults,
  mergeManifestDefaults,
  positiveInteger,
  positiveNumber,
  provisionDeployApp,
  resolveApp,
  scoped,
  slugFrom,
  stageArtifact,
  waitForDeployment,
} from './apps-deploy.ts';

// The archive/manifest helpers keep their historical home in the entry module

const HELP = help`Usage: kortix apps <subcommand> [options]

Deploy and operate serverless Kortix Apps. Each App owns one stable URL.
Deployments are immutable. A failed deployment never replaces live traffic.

Subcommands:
  list | ls                         List Apps. --json.
  create <slug>                     Create an App without deploying it.
    --name <name>                   Defaults to the slug.
    --cpu <cores>                   Default: 1.
    --memory <gb>                   Default: 2.
    --disk <gb>                     Default: 10.
    --idle-timeout <seconds>        Default: 300. Only for --on-demand.
    --always-on | --on-demand       Run 24/7, or stop when idle and wake on the
                                    next request. A static App has no runtime
                                    and ignores both.
    --budget <usd>                  Monthly compute budget. Default: 5.
  deploy [path]                     Deploy a directory or .tar.gz archive.
    --manifest-app <name>           Use one apps.<name> block from kortix.yaml.
    --app <id|slug>                 Existing App. Omit to create one.
    --slug <slug> --name <name>     New App identity.
    --type static|bundle|dockerfile Source type. Auto-detected for directories.
    --image <oci-reference>         Deploy a public OCI image instead of a path.
    --command <json|string>         Process argv. JSON array is unambiguous.
    --port <port>                   Required for Dockerfile and OCI deployments.
    --dockerfile <path>             Default: Dockerfile.
    --root <path>                   Static root inside the archive.
    --output-dir <path>             Bundle output. Default: dist.
    --install-command <command>     Bundle install command.
    --build-command <command>       Bundle build command.
    --readiness-path <path>         Default: /.
    --spa | --no-spa                Static/bundle history fallback.
    --provider <name>               daytona, platinum, or e2b.
    --access <mode>                 private (default), project, restricted, public, or password.
    --password <value>              Required for new password-protected Apps.
    --members <ids>                 Comma-separated member ids for restricted access.
    --groups <ids>                  Comma-separated group ids for restricted access.
    --always-on | --on-demand       Server Apps: run 24/7 (default), or stop when
                                    idle. Static Apps run no server.
    --no-wait                       Return after the deployment is queued.
    --wait-seconds <seconds>        Default: 1200.
  set <id|slug>                     Change an existing App. Only the flags you
                                    pass are sent. Needs project write access.
                                    A machine or budget change applies to the
                                    next deployment, not the running runtime.
    --name <name>
    --cpu <cores>
    --memory-gb <gb>                Alias: --memory.
    --disk-gb <gb>                  Alias: --disk.
    --idle-timeout <seconds>        120-86400.
    --always-on | --on-demand       Run 24/7, or stop when idle.
    --budget <usd>                  Monthly compute budget.
  show <id|slug>                    Show an App and its deployments. --json.
  logs <id|slug> [deployment-id]    Read runtime logs. --after N --limit N.
  start <id|slug>                   Permit requests and start the App.
  stop <id|slug>                    Suspend now. The next authorized request wakes it.
  rollback <id|slug> <deployment>   Move traffic to a ready deployment.
  access <id|slug>                  Read or update access. --mode, --password, --members, --groups.
    --viewer off|identity|api       What the App is told about its viewer. api = a token
                                    that acts as them on the Kortix API (their role caps it).
  access-link <id|slug>             Create a short-lived authenticated browser URL.
  delete <id|slug>                  Delete the App, its runtimes, and every deployment
                                    image it built. --yes.
    --deployment <id|vN>            Delete only this deployment and its image. The live
                                    deployment cannot be deleted: roll back first.

Global options:
  --project <id>     Operate on this project id.
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.
`;

/**
 * The deployment a user named: its full id, or its version as `v3` or `3` —
 * the form `kortix apps show` prints. Deleted deployments are never listed.
 */
export function resolveDeploymentTarget(
  deployments: AppDeployment[],
  target: string,
): AppDeployment {
  const version = /^v?(\d+)$/i.exec(target.trim());
  const match = deployments.find(
    (deployment) =>
      deployment.deployment_id === target ||
      (version !== null && deployment.version === Number(version[1])),
  );
  if (match) return match;
  const known = deployments.map((deployment) => `v${deployment.version}`).join(', ');
  throw new Error(`Deployment ${target} not found${known ? ` (deployments: ${known})` : ''}`);
}

function renderApps(apps: App[]): number {
  if (apps.length === 0) {
    process.stdout.write(`\n  ${C.dim}No Apps deployed.${C.reset}\n\n`);
    return 0;
  }
  const slugWidth = Math.max(4, ...apps.map((app) => app.slug.length));
  process.stdout.write(`\n  ${C.bold}${pad('SLUG', slugWidth)}  STATE     URL${C.reset}\n`);
  for (const app of apps) {
    process.stdout.write(
      `  ${pad(app.slug, slugWidth)}  ${pad(app.desired_state, 9)} ${app.url}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

function takeCommon(rest: string[]) {
  const json = takeFlagBool(rest, ['--json']);
  return {
    json,
    options: {
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
    },
  };
}

export async function runApps(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const subcommand = argv[0];
  const rest = argv.slice(1);
  try {
    const common = takeCommon(rest);
    switch (subcommand) {
      case 'list':
      case 'ls':
        return await listCommand(common.options, common.json);
      case 'create':
      case 'new':
        return await createCommand(rest, common.options, common.json);
      case 'set':
      case 'update':
        return await setCommand(rest, common.options, common.json);
      case 'deploy':
        return await deployCommand(rest, common.options, common.json);
      case 'show':
      case 'get':
        return await showCommand(rest, common.options, common.json);
      case 'logs':
        return await logsCommand(rest, common.options, common.json);
      case 'start':
      case 'stop':
        return await stateCommand(subcommand, rest, common.options, common.json);
      case 'rollback':
        return await rollbackCommand(rest, common.options, common.json);
      case 'access':
        return await accessCommand(rest, common.options, common.json);
      case 'access-link':
        return await accessLinkCommand(rest, common.options, common.json);
      case 'delete':
      case 'rm':
      case 'remove':
        return await deleteCommand(rest, common.options, common.json);
      default:
        return fail(`unknown Apps subcommand "${subcommand}"`);
    }
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function listCommand(options: ContextOptions, json: boolean): Promise<number> {
  const ctx = await context(options);
  if (!ctx) return 1;
  const apps = await scoped(ctx, () => ctx.apps.list());
  if (json) {
    emitJson({ apps });
    return 0;
  }
  return renderApps(apps);
}

async function createCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const slugInput = rest.find((value) => !value.startsWith('-'));
  if (!slugInput) return fail('create needs a slug');
  rest.splice(rest.indexOf(slugInput), 1);
  const slug = slugFrom(slugInput);
  const input = {
    slug,
    name: takeFlagValue(rest, ['--name']) ?? slugInput,
    cpu: positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu'),
    memory_gb: positiveInteger(takeFlagValue(rest, ['--memory']), '--memory'),
    disk_gb: positiveInteger(takeFlagValue(rest, ['--disk']), '--disk'),
    idle_timeout_seconds: positiveInteger(
      takeFlagValue(rest, ['--idle-timeout']),
      '--idle-timeout',
    ),
    monthly_budget_usd: positiveNumber(takeFlagValue(rest, ['--budget']), '--budget'),
    ...runMode(rest),
  };
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, () => ctx.apps.create(input));
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`created ${app.slug}`)}\n  ${app.url}\n\n`);
  return 0;
}

/** `--always-on` / `--on-demand`, consumed from `rest`; neither → the server decides. */
function runMode(rest: string[]): { always_on?: boolean } {
  const alwaysOn = takeFlagBool(rest, ['--always-on']);
  const onDemand = takeFlagBool(rest, ['--on-demand']);
  if (alwaysOn && onDemand) throw new Error('Pass --always-on or --on-demand, not both');
  return alwaysOn ? { always_on: true } : onDemand ? { always_on: false } : {};
}

/**
 * PATCH /projects/:id/apps/:appId with `UpdateAppInput`.
 *
 * The route's zod body marks every field optional and the handler only writes
 * the keys that are present, so an omitted flag must NOT be sent as
 * `undefined` — the object is built from the flags that were actually passed.
 */
async function setCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  // Flags are consumed BEFORE the positional is picked, so a flag VALUE
  // (`--cpu 2`) is never mistaken for the App id when the id is missing.
  const input: UpdateAppInput = {};
  const name = takeFlagValue(rest, ['--name']);
  const cpu = positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu');
  const memory = positiveInteger(takeFlagValue(rest, ['--memory-gb', '--memory']), '--memory-gb');
  const disk = positiveInteger(takeFlagValue(rest, ['--disk-gb', '--disk']), '--disk-gb');
  const idle = positiveInteger(takeFlagValue(rest, ['--idle-timeout']), '--idle-timeout');
  const budget = positiveNumber(takeFlagValue(rest, ['--budget']), '--budget');
  Object.assign(input, runMode(rest));
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('set needs an App id or slug');
  if (name !== undefined) input.name = name;
  if (cpu !== undefined) input.cpu = cpu;
  if (memory !== undefined) input.memory_gb = memory;
  if (disk !== undefined) input.disk_gb = disk;
  if (idle !== undefined) input.idle_timeout_seconds = idle;
  if (budget !== undefined) input.monthly_budget_usd = budget;
  if (Object.keys(input).length === 0) {
    return fail(
      'set needs at least one of --name, --cpu, --memory-gb, --disk-gb, --idle-timeout, --always-on, --on-demand, --budget',
    );
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    return ctx.apps.update(found.app_id, input);
  });
  if (json) emitJson(app);
  else {
    process.stdout.write(`\n  ${status.ok(`updated ${app.slug}`)}\n`);
    process.stdout.write(
      `  ${C.dim}${pad('machine', 14)}${C.reset}${app.machine.cpu} vCPU · ${app.machine.memory_gb} GB · ${app.machine.disk_gb} GB disk\n`,
    );
    process.stdout.write(
      `  ${C.dim}${pad('idle timeout', 14)}${C.reset}${app.idle_timeout_seconds}s\n`,
    );
    process.stdout.write(
      `  ${C.dim}${pad('budget', 14)}${C.reset}$${app.monthly_budget_usd}/mo\n\n`,
    );
  }
  return 0;
}

async function deployCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  let flags = deployFlags(rest);
  const pathArgument = rest.find((value) => !value.startsWith('-'));
  if (rest.some((value) => value.startsWith('-'))) {
    throw new Error(`Unknown deploy option ${rest.find((value) => value.startsWith('-'))}`);
  }
  const manifestDefaults = loadManifestAppDefaults(
    process.cwd(),
    flags.manifestApp,
    !pathArgument && !flags.image,
  );
  const manifestBlock = manifestDefaults?.block;
  flags = mergeManifestDefaults(flags, manifestBlock);
  if (flags.image && pathArgument) throw new Error('Use a source path or --image, not both');
  const sourcePath = flags.image
    ? undefined
    : pathArgument
      ? resolve(pathArgument)
      : resolve(manifestDefaults?.root ?? process.cwd(), manifestBlock?.path ?? '.');
  if (sourcePath && !existsSync(sourcePath))
    throw new Error(`Source path does not exist: ${sourcePath}`);

  const ctx = await context(options);
  if (!ctx) return 1;
  return scoped(ctx, async () => {
    let app = await provisionDeployApp(ctx.apps, flags, manifestDefaults, sourcePath);

    if (flags.accessMode) {
      await ctx.apps.access.update(app.app_id, {
        mode: flags.accessMode,
        ...(flags.password ? { password: flags.password } : {}),
        ...(flags.memberIds ? { member_ids: flags.memberIds } : {}),
        ...(flags.groupIds ? { group_ids: flags.groupIds } : {}),
      });
      app = await ctx.apps.get(app.app_id);
    }

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const staged = await stageArtifact(ctx.apps, flags, sourcePath, json);
      cleanup = staged.cleanup;
      let deployment = await ctx.apps.deployments.create(app.app_id, {
        artifact_id: staged.artifactId,
        source: staged.source,
        ...(flags.provider ? { provider: flags.provider } : {}),
        ...(manifestBlock?.env ? { environment: manifestBlock.env } : {}),
        ...(manifestBlock?.secrets ? { secrets: manifestBlock.secrets } : {}),
      });
      if (flags.wait)
        deployment = await waitForDeployment(ctx.apps, app.app_id, deployment, flags.waitSeconds);
      const currentApp = flags.wait ? await ctx.apps.get(app.app_id) : app;
      if (json) emitJson({ app: currentApp, deployment });
      else {
        process.stdout.write(
          `\n  ${status.ok(`deployment ${deployment.status}`)}\n  ${currentApp.url}\n\n`,
        );
      }
      return 0;
    } finally {
      await cleanup?.();
    }
  });
}

async function showCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('show needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    return { app, deployments: await ctx.apps.deployments.list(app.app_id) };
  });
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${C.bold}${result.app.name}${C.reset}\n  ${result.app.url}\n`);
    for (const deployment of result.deployments) {
      const live =
        deployment.deployment_id === result.app.active_deployment_id
          ? `  ${C.bold}live${C.reset}`
          : '';
      process.stdout.write(
        `  v${deployment.version}  ${deployment.status}  ${deployment.deployment_id}${live}\n`,
      );
    }
    process.stdout.write('\n');
  }
  return 0;
}

async function logsCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const after = positiveInteger(takeFlagValue(rest, ['--after']), '--after') ?? 0;
  const limit = positiveInteger(takeFlagValue(rest, ['--limit']), '--limit') ?? 200;
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0]) return fail('logs needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const logs = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, positional[0]!);
    const deploymentId =
      positional[1] ??
      app.active_deployment_id ??
      (await ctx.apps.deployments.list(app.app_id))[0]?.deployment_id;
    if (!deploymentId) throw new Error('App has no deployment');
    return ctx.apps.deployments.logs(app.app_id, deploymentId, { after, limit });
  });
  if (json) emitJson(logs);
  else
    for (const entry of logs.entries)
      process.stdout.write(`${entry.time} ${entry.source}  ${entry.line}\n`);
  return 0;
}

async function stateCommand(
  action: 'start' | 'stop',
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail(`${action} needs an App id or slug`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    return action === 'start' ? ctx.apps.start(found.app_id) : ctx.apps.stop(found.app_id);
  });
  if (json) emitJson(app);
  else
    process.stdout.write(`\n  ${status.ok(`${app.slug} ${app.desired_state}`)}\n  ${app.url}\n\n`);
  return 0;
}

async function rollbackCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0] || !positional[1]) return fail('rollback needs an App and deployment id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, positional[0]!);
    return ctx.apps.rollback(found.app_id, positional[1]!);
  });
  if (json) emitJson(app);
  else
    process.stdout.write(`\n  ${status.ok(`traffic moved to ${positional[1]}`)}\n  ${app.url}\n\n`);
  return 0;
}

function imageLines(released: number, pending: number): string {
  const lines: string[] = [];
  if (released > 0) lines.push(`  freed ${released} deployment image${released === 1 ? '' : 's'}`);
  if (pending > 0) {
    lines.push(
      `  ${pending} deployment image${pending === 1 ? '' : 's'} not released yet; Kortix retries automatically`,
    );
  }
  return lines.map((line) => `${C.dim}${line}${C.reset}\n`).join('');
}

async function deleteCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const deploymentTarget = takeFlagValue(rest, ['--deployment']);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('delete needs an App id or slug');
  if (!yes)
    return fail(
      `${deploymentTarget ? 'deleting a deployment' : 'delete'} is destructive; pass --yes`,
    );
  const ctx = await context(options);
  if (!ctx) return 1;

  if (deploymentTarget) {
    const result = await scoped(ctx, async () => {
      const app = await resolveApp(ctx.apps, target);
      const deployment = resolveDeploymentTarget(
        await ctx.apps.deployments.list(app.app_id),
        deploymentTarget,
      );
      const deleted = await ctx.apps.deployments.remove(app.app_id, deployment.deployment_id);
      return { ...deleted, app_id: app.app_id, slug: app.slug, version: deployment.version };
    });
    if (json) emitJson(result);
    else {
      process.stdout.write(`\n  ${status.ok(`deleted v${result.version} of ${result.slug}`)}\n`);
      process.stdout.write(
        imageLines(result.image === 'released' ? 1 : 0, result.image === 'pending' ? 1 : 0),
      );
      process.stdout.write('\n');
    }
    return 0;
  }

  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    const deleted = await ctx.apps.remove(app.app_id);
    return {
      ok: true,
      app_id: app.app_id,
      slug: app.slug,
      images: deleted.images ?? { released: 0, pending: 0 },
    };
  });
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${status.ok(`deleted ${result.slug}`)}\n`);
    process.stdout.write(imageLines(result.images.released, result.images.pending));
    process.stdout.write('\n');
  }
  return 0;
}
