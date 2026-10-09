import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { App, AppDeployment, AppKind, CreateAppInput, UpdateAppInput } from '@kortix/sdk';

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
  connectCommand,
  credentialsCommand,
  dashboardCommand,
  deleteSnapshotCommand,
  deployOrder,
  deployWithClientCli,
  formatTime,
  isConvexProject,
  linkCommand,
  processLogCommand,
  restoreCommand,
  rotateCredentialsCommand,
  snapshotCommand,
  snapshotsCommand,
  tokenCommand,
  usesList,
} from './apps-capabilities.ts';
import {
  type ContextOptions,
  commandArg,
  context,
  csv,
  deployFlags,
  loadManifestAppDefaults,
  loadManifestApps,
  mergeManifestDefaults,
  positiveInteger,
  positiveNumber,
  alwaysOnBudgetNotice,
  runCostLine,
  provisionDeployApp,
  resolveApp,
  scoped,
  slugFrom,
  stageArtifact,
  waitForDeployment,
} from './apps-deploy.ts';

// The archive/manifest helpers keep their historical home in the entry module

const HELP = help`Usage: kortix apps <subcommand> [options]

Deploy and operate Kortix Apps. Each App owns one stable URL and one kind,
fixed at create: web (a site or a server built from its deployments) or convex
(a self-hosted Convex backend in its own always-on machine). What an App
supports is its capabilities (kortix apps show). <app> is an App id or slug.

Subcommands:
  list | ls                         List Apps with their kind. --json.
  create <slug>                     Create an App without deploying it.
    --kind web|convex               Default: web. A convex App boots its machine
                                    (seconds; minutes on a region's first image
                                    build) and the command waits for it.
    --name <name>                   Defaults to the slug.
    --cpu <cores>                   Default: 1.
    --memory <gb>                   Default: 2 (convex: 1).
    --disk <gb>                     Default: 10. A convex disk never shrinks.
    --idle-timeout <seconds>        Default: 300. Only for --on-demand.
    --always-on | --on-demand       Run 24/7, or stop when idle and wake on the
                                    next request. A static App has no runtime
                                    and ignores both. A convex App always runs.
    --budget <usd>                  Monthly compute budget. Default: the 24/7
                                    estimate for an always-on App, 5 on demand.
                                    A convex App alerts at 80 % and 100 %; it
                                    never stops.
    --uses <slugs>                  Apps this App uses (it may bind to them and
                                    mint their sign-in tokens), comma-separated.
    --no-wait                       Return before a convex App runs.
  deploy [path] [-- <client args>]  Deploy a directory or .tar.gz archive. The
                                    target App's kind decides how: a convex App
                                    runs convex deploy with its credentials (the
                                    project's own node_modules/.bin/convex, else
                                    npx convex@<the App's version>), then records
                                    the deployment with the git commit. Args
                                    after -- go to convex deploy. A directory with
                                    convex/ or convex.json and no App of its name
                                    is refused: create it with --kind convex.
                                    With no path and a kortix.yaml of several
                                    apps, deploys every App in link order: each
                                    after the Apps it uses, convex first.
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
    --budget <usd>                  Monthly compute budget. A server App stops at
                                    it. Default for a new always-on App: its 24/7
                                    estimate (about $73/month on the default
                                    machine). Deploy warns when it is lower.
    --no-wait                       Return after the deployment is queued.
    --wait-seconds <seconds>        Default: 1200.
  set <id|slug>                     Change an existing App. Only the flags you
                                    pass are sent. Needs project write access.
                                    A web machine change applies to the next
                                    deployment; a convex App resizes now (seconds
                                    of downtime) and the command waits. A run-mode
                                    or budget change applies within 5 minutes.
    --name <name>
    --cpu <cores>
    --memory-gb <gb>                Alias: --memory.
    --disk-gb <gb>                  Alias: --disk.
    --idle-timeout <seconds>        120-86400.
    --always-on | --on-demand       Run 24/7, or stop when idle.
    --budget <usd>                  Monthly compute budget.
    --uses <slugs>                  Replace the Apps this App uses. Comma-
                                    separated; --uses= clears the list.
    --no-wait                       Return before a resize ends.
  link <id|slug> --uses <slugs>     Add Apps this App uses. Code in the App then
                                    reaches them with kortixBinding('<slug>') and
                                    mints their tokens with kortixToken().
  unlink <id|slug> --uses <slugs>   Remove Apps this App uses.
  show <id|slug>                    Show an App: kind, capabilities, links,
                                    instance and deployments. --json.
  logs <id|slug> [deployment-id]    Read runtime logs. --after N --limit N. An App
                                    with the logs capability prints its process
                                    log instead: --lines 1-1000 (default 200).
  start <id|slug>                   Permit requests and start the App.
  stop <id|slug>                    Suspend now. The next authorized request wakes it.
  rollback <id|slug> <id|vN>        Move traffic to a ready deployment.
  access <id|slug>                  Read or update access. --mode, --password, --members, --groups.
    --viewer off|identity|api       What the App is told about its viewer. api = a token
                                    that acts as them on the Kortix API (their role caps it).
  access-link <id|slug>             Create a short-lived authenticated browser URL.
  connect <id|slug>                 Print how to reach the App from code: from an
                                    App that uses it, from outside (sign-in token,
                                    HTTP, your own server) and from the CLI. The
                                    same snippets as Connect in Kortix web. No
                                    secret. --json.
  token <id|slug>                   Print a 15-minute Kortix sign-in token for the
                                    App, naming you. --json adds expires_at.
  dashboard <id|slug>               Capability dashboard: print the Kortix page
                                    that opens the App's dashboard, signed in.
    --open                          Also open it in the browser.
  credentials <id|slug>             Capability admin_credentials: print the
                                    client CLI credentials. Every read is audited.
    --format shell|dotenv|json      shell (default): export lines for
                                    eval "$(kortix apps credentials db)".
  rotate-credentials <id|slug>      Replace the admin key. Every key read before
                                    stops working; the App restarts (about 1 s).
    --yes                           Skip the confirmation.
  snapshots <id|slug>               Capability snapshots: the automatic backup,
                                    the schedule and the snapshots, newest first,
                                    with kind and expiry. --json. Kinds: manual
                                    (kept until deleted, at most 10), automatic
                                    (daily, kept 7 days), resize (kept 24 hours),
                                    final (taken at delete, kept 7 days).
  snapshot <id|slug>                Take a manual snapshot now. --json.
  delete-snapshot <id|slug> <snapshot-id>
                                    Delete one snapshot. --yes skips the question.
  restore <id|slug> <snapshot-id>   Capability restore: roll the App back to a
                                    snapshot. Every change after it is lost.
                                    --yes skips the question.
  delete <id|slug>                  Delete the App, its runtimes, and every deployment
                                    image it built. --yes.
    --confirm <slug>                Required for an App with snapshots (it holds
                                    data): its slug, typed. Kortix keeps a final
                                    snapshot and the stopped machine 7 days.
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

/**
 * The STATE column. A static App has no runtime: it serves while it has an
 * active deployment, whatever `desired_state` says, so it reads `static`.
 */
export function appStateLabel(
  app: Pick<App, 'desired_state' | 'hosting_type' | 'active_deployment_id'> & Pick<Partial<App>, 'instance'>,
): string {
  // An App with its own machine reads its machine: provisioning, running, an operation, error.
  if (app.instance) return app.instance.operation ?? app.instance.status;
  if (!app.active_deployment_id) return 'undeployed';
  if (app.hosting_type === 'static') return 'static';
  return app.desired_state;
}

function renderApps(apps: App[]): number {
  if (apps.length === 0) {
    process.stdout.write(`\n  ${C.dim}No Apps deployed.${C.reset}\n\n`);
    return 0;
  }
  const slugWidth = Math.max(4, ...apps.map((app) => app.slug.length));
  process.stdout.write(`\n  ${C.bold}${pad('SLUG', slugWidth)}  KIND    STATE        URL${C.reset}\n`);
  for (const app of apps) {
    process.stdout.write(
      `  ${pad(app.slug, slugWidth)}  ${pad(app.kind ?? 'web', 6)}  ${pad(appStateLabel(app), 12)} ${app.url ?? '-'}\n`,
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
  // Everything after `--` belongs to the client CLI a deploy runs; flags there must not be taken.
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const extra = separator === -1 ? [] : argv.slice(separator + 1);
  const helpCode = splitHelp(own, HELP);
  if (helpCode !== null) return helpCode;
  const subcommand = own[0];
  const rest = own.slice(1);
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
        return await deployCommand(rest, extra, common.options, common.json);
      case 'link':
      case 'unlink':
        return await linkCommand(subcommand, rest, common.options, common.json);
      case 'snapshots':
        return await snapshotsCommand(rest, common.options, common.json);
      case 'snapshot':
        return await snapshotCommand(rest, common.options, common.json);
      case 'delete-snapshot':
        return await deleteSnapshotCommand(rest, common.options, common.json);
      case 'restore':
        return await restoreCommand(rest, common.options, common.json);
      case 'credentials':
        return await credentialsCommand(rest, common.options);
      case 'rotate-credentials':
        return await rotateCredentialsCommand(rest, common.options, common.json);
      case 'token':
        return await tokenCommand(rest, common.options, common.json);
      case 'dashboard':
        return await dashboardCommand(rest, common.options, common.json);
      case 'connect':
        return await connectCommand(rest, common.options, common.json);
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
  const kind = takeFlagValue(rest, ['--kind']);
  if (kind !== undefined && kind !== 'web' && kind !== 'convex') return fail('--kind must be web or convex');
  const wait = !takeFlagBool(rest, ['--no-wait']);
  const uses = usesList(takeFlagValue(rest, ['--uses']));
  const name = takeFlagValue(rest, ['--name']);
  const slugInput = rest.find((value) => !value.startsWith('-'));
  if (!slugInput) return fail('create needs a slug');
  rest.splice(rest.indexOf(slugInput), 1);
  const slug = slugFrom(slugInput);
  const input: CreateAppInput = {
    slug,
    name: name ?? slugInput,
    ...(kind ? { kind: kind as AppKind } : {}),
    cpu: positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu'),
    memory_gb: positiveInteger(takeFlagValue(rest, ['--memory']), '--memory'),
    disk_gb: positiveInteger(takeFlagValue(rest, ['--disk']), '--disk'),
    idle_timeout_seconds: positiveInteger(
      takeFlagValue(rest, ['--idle-timeout']),
      '--idle-timeout',
    ),
    monthly_budget_usd: positiveNumber(takeFlagValue(rest, ['--budget']), '--budget'),
    ...(uses ? { uses } : {}),
    ...runMode(rest),
  };
  // Omitted flags stay off the wire: the server picks each kind's defaults.
  for (const key of Object.keys(input) as Array<keyof CreateAppInput>) if (input[key] === undefined) delete input[key];
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const created = await ctx.apps.create(input);
    if (!wait || !created.instance) return created;
    if (!json) process.stderr.write(`${C.dim}Starting ${created.slug}. This takes seconds, or minutes on a region's first image build.${C.reset}\n`);
    return ctx.apps.waitUntilReady(created.app_id);
  });
  printWarnings(app);
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`created ${app.slug}`)}\n${appLines(app)}${costBlock(app)}\n`);
  return 0;
}

/** The facts `show`, `create` and `set` print about an App. */
function appLines(app: App): string {
  const row = (label: string, value: string | null | undefined) =>
    value ? `  ${C.dim}${pad(label, 14)}${C.reset}${value}\n` : '';
  const instance = app.instance;
  return (
    row('url', app.url) +
    row('kind', app.kind ?? 'web') +
    row('capabilities', app.capabilities?.join(', ')) +
    row('uses', app.uses?.length ? app.uses.join(', ') : 'none') +
    row('used by', app.used_by?.length ? app.used_by.join(', ') : null) +
    row('machine', `${app.machine.cpu} vCPU · ${app.machine.memory_gb} GB · ${app.machine.disk_gb} GB disk`) +
    (instance
      ? row('site url', instance.site_url) +
        row('health', instance.health ? (instance.health.ok ? 'ok' : `unhealthy: ${instance.health.error ?? instance.health.machine_state ?? 'unknown'}`) : null) +
        row('operation', instance.operation) +
        row('last error', instance.last_operation_error) +
        row('error', instance.error) +
        row('budget alert', instance.budget_alert ? `${instance.budget_alert.percent} % of $${instance.budget_alert.budget_usd} in ${instance.budget_alert.month}` : null) +
        row('purge after', instance.purge_after ? formatTime(instance.purge_after) : null)
      : '')
  );
}

/** The run-cost line for a server App, indented under the result; empty when none applies. */
function costBlock(app: App): string {
  const line = runCostLine(app);
  return line ? `  ${C.dim}${line}${C.reset}\n` : '';
}

/** The server's warnings for a create or update, on stderr so `--json` stdout stays clean. */
function printWarnings(app: App): void {
  for (const warning of app.warnings ?? []) process.stderr.write(`${status.warn(warning.message)}\n`);
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
  const uses = usesList(takeFlagValue(rest, ['--uses']));
  const wait = !takeFlagBool(rest, ['--no-wait']);
  Object.assign(input, runMode(rest));
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('set needs an App id or slug');
  if (name !== undefined) input.name = name;
  if (cpu !== undefined) input.cpu = cpu;
  if (memory !== undefined) input.memory_gb = memory;
  if (disk !== undefined) input.disk_gb = disk;
  if (idle !== undefined) input.idle_timeout_seconds = idle;
  if (budget !== undefined) input.monthly_budget_usd = budget;
  if (uses !== undefined) input.uses = uses;
  if (Object.keys(input).length === 0) {
    return fail(
      'set needs at least one of --name, --cpu, --memory-gb, --disk-gb, --idle-timeout, --always-on, --on-demand, --budget, --uses',
    );
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    const updated = await ctx.apps.update(found.app_id, input);
    // A convex App resizes in the background; wait for the new size unless told not to.
    if (!wait || !updated.instance?.operation) return updated;
    if (!json) process.stderr.write(`${C.dim}Resizing ${updated.slug}. It restarts on the new size.${C.reset}\n`);
    return ctx.apps.waitUntilReady(updated.app_id);
  });
  printWarnings(app);
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
      `  ${C.dim}${pad('budget', 14)}${C.reset}$${app.monthly_budget_usd}/mo\n${costBlock(app)}`,
    );
    process.stdout.write(`  ${C.dim}${pad('uses', 14)}${C.reset}${app.uses?.length ? app.uses.join(', ') : 'none'}\n\n`);
  }
  return 0;
}

async function deployCommand(
  rest: string[],
  extra: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const flags = deployFlags(rest);
  const pathArgument = rest.find((value) => !value.startsWith('-'));
  if (rest.some((value) => value.startsWith('-'))) {
    throw new Error(`Unknown deploy option ${rest.find((value) => value.startsWith('-'))}`);
  }
  // No target at all and a kortix.yaml of several Apps: deploy them all, in link order.
  const manifestApps = !pathArgument && !flags.image && !flags.app && !flags.manifestApp && !flags.slug
    ? loadManifestApps(process.cwd())
    : null;
  if (manifestApps && Object.keys(manifestApps.blocks).length > 1) {
    const order = deployOrder(manifestApps.blocks);
    const ctx = await context(options);
    if (!ctx) return 1;
    const results: unknown[] = [];
    for (const name of order) {
      if (!json) process.stderr.write(`${C.dim}Deploying apps.${name}${C.reset}\n`);
      const code = await deployOne(ctx, { ...flags, manifestApp: name }, undefined, extra, json, results);
      if (code !== 0) return code;
    }
    if (json) emitJson({ deployed: results });
    return 0;
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const results: unknown[] = [];
  const code = await deployOne(ctx, flags, pathArgument, extra, json, results);
  if (code === 0 && json) emitJson(results[0]);
  return code;
}

type Ctx = NonNullable<Awaited<ReturnType<typeof context>>>;

/**
 * Deploy one App. Its kind decides how: an App with `admin_credentials`
 * (convex) runs its client CLI on the source directory; any other builds an
 * uploaded artifact. Pushes `{ app, deployment }` to `results`.
 */
async function deployOne(
  ctx: Ctx,
  parsed: ReturnType<typeof deployFlags>,
  pathArgument: string | undefined,
  extra: string[],
  json: boolean,
  results: unknown[],
): Promise<number> {
  const manifestDefaults = loadManifestAppDefaults(process.cwd(), parsed.manifestApp, !pathArgument && !parsed.image);
  const manifestBlock = manifestDefaults?.block;
  const flags = mergeManifestDefaults(parsed, manifestBlock);
  if (flags.image && pathArgument) throw new Error('Use a source path or --image, not both');
  const sourcePath = flags.image
    ? undefined
    : pathArgument
      ? resolve(pathArgument)
      : resolve(manifestDefaults?.root ?? process.cwd(), manifestBlock?.path ?? '.');
  if (sourcePath && !existsSync(sourcePath))
    throw new Error(`Source path does not exist: ${sourcePath}`);

  return scoped(ctx, async () => {
    // A Convex project with no manifest block and no --app must name an existing
    // App: a typo must never start a new always-on machine.
    if (!flags.app && !manifestDefaults && !flags.type && sourcePath && isConvexProject(sourcePath)) {
      const slug = slugFrom(flags.slug ?? basename(sourcePath));
      const existing = (await ctx.apps.list()).find((row) => row.slug === slug);
      if (!existing) {
        throw new Error(
          `${sourcePath} is a Convex project and no App is named ${slug}. Create it: kortix apps create ${slug} --kind convex. ` +
            'Or deploy it as a web App with --type.',
        );
      }
      if (existing.capabilities?.includes('admin_credentials')) flags.app = existing.app_id;
    }
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

    if (app.capabilities?.includes('admin_credentials')) {
      if (!sourcePath) throw new Error(`App ${app.slug} deploys a directory, not an image`);
      const deployed = await deployWithClientCli(ctx, app, sourcePath, extra);
      if (deployed.code !== 0) return deployed.code;
      results.push({ app: deployed.app, deployment: deployed.deployment });
      if (!json) {
        process.stdout.write(`\n  ${status.ok(`deployed ${deployed.app.slug} · v${deployed.deployment!.version}`)}\n  ${deployed.app.url}\n\n`);
      }
      return 0;
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
      const budgetNotice = staged.source.kind === 'static' ? null : alwaysOnBudgetNotice(currentApp);
      if (budgetNotice) process.stderr.write(`${status.warn(budgetNotice)}\n`);
      results.push({ app: currentApp, deployment });
      if (!json) {
        process.stdout.write(
          `\n  ${status.ok(`deployment ${deployment.status}`)}\n  ${currentApp.url}\n${staged.source.kind === 'static' ? '' : costBlock(currentApp)}\n`,
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
    const app = result.app;
    const hosting = app.instance
      ? `${app.kind} · ${app.instance.operation ?? app.instance.status} · always on · budget $${app.monthly_budget_usd}/mo`
      : app.hosting_type === 'static'
        ? 'static · served from storage, no runtime'
        : app.hosting_type === 'sandbox'
          ? `server · ${app.always_on ? 'always on' : 'on demand'} · ${app.desired_state} · budget $${app.monthly_budget_usd}/mo`
          : 'not deployed';
    process.stdout.write(`\n  ${C.bold}${app.name}${C.reset}\n  ${C.dim}${hosting}${C.reset}\n${appLines(app)}`);
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
  const lines = takeFlagValue(rest, ['--lines', '-n']);
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0]) return fail('logs needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const target = await scoped(ctx, () => resolveApp(ctx.apps, positional[0]!));
  // An App with a process log of its own prints it; every other App reads its deployment's runtime log.
  if (target.capabilities?.includes('logs')) {
    return processLogCommand(ctx, target, lines === undefined ? [] : ['--lines', lines], json);
  }
  const logs = await scoped(ctx, async () => {
    const app = target;
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
    const deployment = resolveDeploymentTarget(await ctx.apps.deployments.list(found.app_id), positional[1]!);
    return ctx.apps.rollback(found.app_id, deployment.deployment_id);
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
  const typed = takeFlagValue(rest, ['--confirm']);
  const yes = takeFlagBool(rest, ['--yes', '-y']) || typed !== undefined;
  const deploymentTarget = takeFlagValue(rest, ['--deployment']);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('delete needs an App id or slug');
  if (!yes)
    return fail(
      deploymentTarget
        ? 'deleting a deployment is destructive; pass --yes'
        : 'delete is destructive; pass --yes (an App that holds data needs --confirm <slug> instead)',
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

  const app = await scoped(ctx, () => resolveApp(ctx.apps, target));
  // An App with snapshots holds data: the delete needs its slug, typed.
  if (app.capabilities?.includes('snapshots') && typed !== app.slug) {
    return fail(`${app.slug} holds data. Type its slug to delete it: --confirm ${app.slug}`);
  }
  const deleted = await scoped(ctx, () =>
    ctx.apps.remove(app.app_id, typed === undefined ? undefined : { confirm: typed }),
  );
  const result = {
    ok: true,
    app_id: app.app_id,
    slug: app.slug,
    images: deleted.images ?? { released: 0, pending: 0 },
    ...(deleted.retained_until ? { retained_until: deleted.retained_until, final_snapshot_id: deleted.final_snapshot_id ?? null } : {}),
  };
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${status.ok(`deleted ${result.slug}`)}\n`);
    process.stdout.write(imageLines(result.images.released, result.images.pending));
    if (deleted.retained_until) {
      const kept = deleted.final_snapshot_id ? `final snapshot ${deleted.final_snapshot_id}` : 'the stopped machine';
      process.stdout.write(`  ${C.dim}${kept} kept until ${formatTime(deleted.retained_until)}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}
