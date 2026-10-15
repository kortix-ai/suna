import { appReleaseInputFromBlock } from '@kortix/manifest-schema';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { APP_TEMPLATES, appTemplate, type AppTemplateSecret } from '@kortix/shared/app-templates';
import { parseDocument } from 'yaml';
import { dirname, resolve } from 'node:path';
import type { App, AppDeployment, CreateAppInput, UpdateAppInput } from '@kortix/sdk';

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
import { addAppBlocks } from './apps-launch-yaml.ts';
import { authEnvCommand, execCommand, labelsCommand, machinesCommand, releasesCommand, scaleCommand, volumesCommand } from './apps-fleet.ts';
import { connectCommand, deployOrder, linkCommand, tokenCommand, usesList } from './apps-capabilities.ts';
import {
  type ContextOptions,
  commandArg,
  context,
  csv,
  deployFlags,
  loadManifestAppDefaults,
  matchingManifestApp,
  loadManifestApps,
  mergeManifestDefaults,
  positiveInteger,
  dropRetiredBudgetFlag,
  runModeLine,
  provisionDeployApp,
  resolveApp,
  scoped,
  slugFrom,
  stageArtifact,
  waitForDeployment,
} from './apps-deploy.ts';

// The archive/manifest helpers keep their historical home in the entry module

const HELP = help`Usage: kortix apps <subcommand> [options]

Deploy and operate Kortix Apps: immutable releases,
replaceable machines, persistent volumes. Each App owns one stable URL: a site
or a server. A server App runs machines per process group; a machine may mount
a volume that outlives every release (a database, uploads, any backend). Configure it in kortix.yaml apps.<name>: processes,
http_service, services, mounts, vm, deploy (strategy, release_command), labels.
What an App supports is its capabilities (kortix apps show). <app> is an App id
or slug.

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
    --uses <slugs>                  Apps this App uses (it may bind to them and
                                    mint their sign-in tokens), comma-separated.
  launch --template <name>          Add a ready-made App to kortix.yaml and deploy it.
                                    Templates: convex (a self-hosted
                                    Convex backend: data on a volume, the client and
                                    HTTP-action services, an admins-only dashboard).
    --name <slug>                   Default: the template's default (convex: backend).
    --no-deploy                     Write kortix.yaml only.
  deploy [path]                     Deploy a directory or .tar.gz archive. With no
                                    path and a kortix.yaml of several apps,
                                    deploys every App in link order: each after
                                    the Apps it uses, then by name.
    --manifest-app <name>           Use one apps.<name> block from kortix.yaml.
                                    Default: the block named by --app, or the
                                    block whose path is the deployed path.
    --app <id|slug>                 Existing App. Omit to create one.
    --slug <slug> --name <name>     New App identity.
    --type static|bundle|dockerfile Source type. Auto-detected for directories.
    --image <oci-reference>         Deploy a public OCI image instead of a path.
    --command <json|string>         Process argv. JSON array is unambiguous.
    --port <port>                   The primary service port (or http_service.
                                    internal_port in kortix.yaml). Omit for a
                                    worker-only App (processes, no service).
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
                                    A machine change applies to the next
                                    deployment. A run-mode change applies within
                                    5 minutes.
    --name <name>
    --cpu <cores>
    --memory-gb <gb>                Alias: --memory.
    --disk-gb <gb>                  Alias: --disk.
    --idle-timeout <seconds>        120-86400.
    --always-on | --on-demand       Run 24/7, or stop when idle.
    --uses <slugs>                  Replace the Apps this App uses. Comma-
                                    separated; --uses= clears the list.
  link <id|slug> --uses <slugs>     Add Apps this App uses. Code in the App then
                                    reaches them with kortixBinding('<slug>') and
                                    mints their tokens with kortixToken().
  unlink <id|slug> --uses <slugs>   Remove Apps this App uses.
  show <id|slug>                    Show an App: capabilities, links and
                                    deployments. --json.
  logs <id|slug> [deployment-id]    Read runtime logs. --after N --limit N.
  start <id|slug>                   Permit requests and start the App.
  stop <id|slug>                    Suspend now. The next authorized request wakes it.
  rollback <id|slug> <id|vN>        Roll back: a NEW release from that release's artifact
                                    and config, rolled out like a deploy. Volumes keep their
                                    data. Waits unless --no-wait.
  releases <id|slug>                List releases (vN, status, strategy); marks the live one.
  machines [ls] <id|slug>           List machines: id, process group, state, release, size, volume.
  machines start|stop|restart <id|slug> <machine>
  machines destroy <id|slug> <machine>
                                    Destroy one machine. Its volume stays; its group runs
                                    one machine fewer.
  scale count <id|slug> <n>         Machines for a process group (0-20). --process <group>
                                    (default app). A group with a mount runs one machine:
                                    scale its machine size instead (apps set --cpu/--memory).
    --new-volumes                   Accept more: each new machine gets its own, EMPTY
                                    volume and serves different data behind the same URL.
  scale show <id|slug>              Machines per process group.
  exec <id|slug> -- <command…>      Run one command in a running machine and print its
                                    output (admins). --machine <id>, --timeout <s> (≤ 300).
  volumes [ls] <id|slug>            Volumes: name, group, used, size, attached, retention.
  volumes create <id|slug> <name> --size <gb> [--process <group>]
  volumes set <id|slug> <volume> --retention <days>
                                    Keep daily snapshots 1-60 days (default 5).
                                    A volume has a fixed size (100 GB on Platinum) and
                                    cannot grow: past that, keep files in object storage.
  volumes snapshots <id|slug> <volume>
                                    Daily snapshots (kept snapshot_retention_days), manual
                                    ones and the final one of a destroyed volume.
  volumes snapshot <id|slug> <volume>
  volumes restore <id|slug> <volume> <snapshot>
                                    Restore (admins): its machine stops and comes back on it.
  volumes fork <id|slug> <volume> <name> [--snapshot <id>]
                                    A new, unattached copy (instant).
  volumes destroy <id|slug> <volume> --yes
                                    Admins. A final snapshot is kept 7 days.
  labels <id|slug> [a,b]            Show or replace labels (e.g. backend). --clear.
  auth-env <id|slug>                What verifies the App's sign-in tokens offline, as
                                    dotenv lines: KORTIX_AUTH_ISSUER, _AUDIENCE, _JWKS
                                    (inline). Public values. --json.
  access <id|slug>                  Read or update access. --mode, --password, --members, --groups.
    --viewer off|identity|api       What the App is told about its viewer. api = a token
                                    that acts as them on the Kortix API (their role caps it).
  access-link <id|slug>             Create a short-lived authenticated browser URL.
  connect <id|slug>                 Print how to reach the App from code: its URL,
                                    the Apps it uses, and from an App that uses
                                    it or from outside (sign-in token, HTTP, your
                                    own server). The same snippets as Connect in
                                    Kortix web. No secret. --json.
  token <id|slug>                   Print a 15-minute Kortix sign-in token for the
                                    App, naming you. --json adds expires_at.
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

/**
 * The STATE column. A static App has no runtime: it serves while it has an
 * active deployment, whatever `desired_state` says, so it reads `static`.
 */
export function appStateLabel(
  app: Pick<App, 'desired_state' | 'hosting_type' | 'active_deployment_id'>,
): string {
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
  process.stdout.write(`\n  ${C.bold}${pad('SLUG', slugWidth)}  STATE        URL${C.reset}\n`);
  for (const app of apps) {
    process.stdout.write(
      `  ${pad(app.slug, slugWidth)}  ${pad(appStateLabel(app), 12)} ${app.url ?? '-'}\n`,
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
  // Everything after `--` is the command `exec` runs, never a kortix flag.
  const dashdash = argv.indexOf('--');
  const rest = dashdash === -1 ? argv.slice(1) : argv.slice(1, dashdash);
  const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);
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
      case 'launch':
        return await launchCommand(rest, common.options, common.json);
      case 'deploy':
        return await deployCommand(rest, common.options, common.json);
      case 'link':
      case 'unlink':
        return await linkCommand(subcommand, rest, common.options, common.json);
      case 'token':
        return await tokenCommand(rest, common.options, common.json);
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
      case 'releases':
        return await releasesCommand(rest, common.options, common.json);
      case 'machines':
      case 'machine':
        return await machinesCommand(rest, common.options, common.json);
      case 'scale':
        return await scaleCommand(rest, common.options, common.json);
      case 'exec':
        return await execCommand(rest, passthrough, common.options, common.json);
      case 'volumes':
      case 'volume':
        return await volumesCommand(rest, common.options, common.json);
      case 'auth-env':
        return await authEnvCommand(rest, common.options, common.json);
      case 'labels':
        return await labelsCommand(rest, common.options, common.json);
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
  dropRetiredBudgetFlag(rest);
  const uses = usesList(takeFlagValue(rest, ['--uses']));
  const name = takeFlagValue(rest, ['--name']);
  const slugInput = rest.find((value) => !value.startsWith('-'));
  if (!slugInput) return fail('create needs a slug');
  rest.splice(rest.indexOf(slugInput), 1);
  const slug = slugFrom(slugInput);
  const input: CreateAppInput = {
    slug,
    name: name ?? slugInput,
    cpu: positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu'),
    memory_gb: positiveInteger(takeFlagValue(rest, ['--memory']), '--memory'),
    disk_gb: positiveInteger(takeFlagValue(rest, ['--disk']), '--disk'),
    idle_timeout_seconds: positiveInteger(
      takeFlagValue(rest, ['--idle-timeout']),
      '--idle-timeout',
    ),
    ...(uses ? { uses } : {}),
    ...runMode(rest),
  };
  // Omitted flags stay off the wire: the server picks the defaults.
  for (const key of Object.keys(input) as Array<keyof CreateAppInput>) if (input[key] === undefined) delete input[key];
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, () => ctx.apps.create(input));
  printWarnings(app);
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`created ${app.slug}`)}\n${appLines(app)}\n`);
  return 0;
}

/** How a server App runs: 24/7, or on demand. None for a static App (no machine). */
function runModeRows(app: App): string {
  if (app.hosting_type === 'static') return '';
  const value = app.always_on === false ? `on demand (stops after ${app.idle_timeout_seconds}s idle)` : '24/7';
  return `  ${C.dim}${pad('runs', 14)}${C.reset}${value}\n`;
}

/** Where Kortix shows the App, when not the defaults (`kortix.yaml` `display`). */
function displaySummary(app: App): string | null {
  const display = app.display ?? {};
  const parts = [
    display.parent ? `tab in ${display.parent}` : display.listed === false ? 'not in the Apps grid' : null,
    display.preview === 'none' ? 'icon card' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The facts `show`, `create` and `set` print about an App. */
function appLines(app: App): string {
  const row = (label: string, value: string | null | undefined) =>
    value ? `  ${C.dim}${pad(label, 14)}${C.reset}${value}\n` : '';
  return (
    row('url', app.url) +
    row('capabilities', app.capabilities?.join(', ')) +
    row('uses', app.uses?.length ? app.uses.join(', ') : 'none') +
    row('used by', app.used_by?.length ? app.used_by.join(', ') : null) +
    row('shown', displaySummary(app)) +
    row('machine', `${app.machine.cpu} vCPU · ${app.machine.memory_gb} GB · ${app.machine.disk_gb} GB disk`) +
    runModeRows(app)
  );
}

/** The run-mode line for a server App, indented under the result; empty when none applies. */
function costBlock(app: App): string {
  const line = runModeLine(app);
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
  dropRetiredBudgetFlag(rest);
  const name = takeFlagValue(rest, ['--name']);
  const cpu = positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu');
  const memory = positiveInteger(takeFlagValue(rest, ['--memory-gb', '--memory']), '--memory-gb');
  const disk = positiveInteger(takeFlagValue(rest, ['--disk-gb', '--disk']), '--disk-gb');
  const idle = positiveInteger(takeFlagValue(rest, ['--idle-timeout']), '--idle-timeout');
  const uses = usesList(takeFlagValue(rest, ['--uses']));
  Object.assign(input, runMode(rest));
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('set needs an App id or slug');
  if (name !== undefined) input.name = name;
  if (cpu !== undefined) input.cpu = cpu;
  if (memory !== undefined) input.memory_gb = memory;
  if (disk !== undefined) input.disk_gb = disk;
  if (idle !== undefined) input.idle_timeout_seconds = idle;
  if (uses !== undefined) input.uses = uses;
  if (Object.keys(input).length === 0) {
    return fail(
      'set needs at least one of --name, --cpu, --memory-gb, --disk-gb, --idle-timeout, --always-on, --on-demand, --uses',
    );
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    return ctx.apps.update(found.app_id, input);
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
    process.stdout.write(runModeRows(app));
    process.stdout.write(`  ${C.dim}${pad('uses', 14)}${C.reset}${app.uses?.length ? app.uses.join(', ') : 'none'}\n\n`);
  }
  return 0;
}

/** ./kortix.yaml, or a new manifest when there is none. One read, no exists-then-read race. */
function readManifestOrNew(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'kortix_version: 2\n';
    throw error;
  }
}

/**
 * `kortix apps launch --template <name> [--name <slug>] [--no-deploy]`:
 * write a template's `apps` blocks into ./kortix.yaml (comments
 * kept; a slug already there is refused), deploy them in order, and print the
 * commands that finish the setup.
 */
async function launchCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const templateName = takeFlagValue(rest, ['--template']);
  const slugFlag = takeFlagValue(rest, ['--name', '--slug']);
  const noDeploy = takeFlagBool(rest, ['--no-deploy']);
  const provider = takeFlagValue(rest, ['--provider']);
  if (!templateName) return fail(`launch needs --template (${Object.keys(APP_TEMPLATES).join(', ')})`);
  const template = appTemplate(templateName);
  if (!template) return fail(`no template "${templateName}"; there is ${Object.keys(APP_TEMPLATES).join(', ')}`);
  const slug = slugFrom(slugFlag ?? template.defaultName);
  const path = resolve(process.cwd(), 'kortix.yaml');
  const text = readManifestOrNew(path);
  const doc = parseDocument(text);
  const blocks = template.blocks(slug);
  const taken = Object.keys(blocks).filter((name) => doc.hasIn(['apps', name]));
  if (taken.length > 0) return fail(`kortix.yaml already has apps.${taken.join(', apps.')}; pick another --name`);
  writeFileSync(path, addAppBlocks(text, blocks));
  if (!json) process.stdout.write(`\n  ${status.ok(`added ${Object.keys(blocks).map((name) => `apps.${name}`).join(', ')} to kortix.yaml`)}\n`);
  // The files the Apps build from (a Dockerfile, a start script). One that exists is the user's: kept.
  for (const [file, content] of Object.entries(template.files?.(slug) ?? {})) {
    const target = resolve(process.cwd(), file);
    mkdirSync(dirname(target), { recursive: true });
    // `wx` creates only: no check-then-write window in which a user's file could be replaced.
    try {
      writeFileSync(target, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    if (!json) process.stdout.write(`  ${status.ok(`wrote ${file}`)}\n`);
  }
  if (!noDeploy) {
    const secrets = template.secrets?.(slug) ?? [];
    const ctx = secrets.length > 0 ? await context(options) : null;
    if (secrets.length > 0 && !ctx) return 1;
    for (const name of template.deployOrder(slug)) {
      const code = await deployCommand(['--manifest-app', name, ...(provider ? ['--provider', provider] : [])], options, json);
      if (code !== 0) return code;
      for (const secret of secrets.filter((entry) => entry.app === name)) {
        const failed = await ensureTemplateSecret(ctx!, secret, json);
        if (failed) return fail(failed);
      }
    }
  }
  if (json) emitJson({ template: template.name, apps: Object.keys(blocks), next_steps: template.nextSteps(slug) });
  else {
    process.stdout.write(`\n  Next:\n${template.nextSteps(slug).map((line) => `    ${line}\n`).join('')}\n`);
  }
  return 0;
}

/**
 * Write a template's project secret from the last line its command prints on
 * the App's machine. It belongs to the App just launched, so it is always
 * rewritten: a value left by an earlier App of the same name is stale. The
 * value is never printed. Returns an error message, or null.
 */
async function ensureTemplateSecret(ctx: Ctx, secret: AppTemplateSecret, json: boolean): Promise<string | null> {
  return scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, secret.app);
    const result = await ctx.apps.exec(app.app_id, { command: secret.command });
    const value = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).pop();
    if (result.exit_code !== 0 || !value) return `could not create the project secret ${secret.name}: \`${secret.command.join(' ')}\` on ${secret.app} exited ${result.exit_code}`;
    await ctx.secrets.upsert({ name: secret.name, value });
    if (!json) process.stdout.write(`  ${status.ok(`wrote the project secret ${secret.name}`)}\n`);
    return null;
  });
}

async function deployCommand(
  rest: string[],
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
      const code = await deployOne(ctx, { ...flags, manifestApp: name }, undefined, json, results);
      if (code !== 0) return code;
    }
    if (json) emitJson({ deployed: results });
    return 0;
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const results: unknown[] = [];
  const code = await deployOne(ctx, flags, pathArgument, json, results);
  if (code === 0 && json) emitJson(results[0]);
  return code;
}

type Ctx = NonNullable<Awaited<ReturnType<typeof context>>>;

/** Deploy one App: build an uploaded artifact. Pushes `{ app, deployment }` to `results`. */
async function deployOne(
  ctx: Ctx,
  parsed: ReturnType<typeof deployFlags>,
  pathArgument: string | undefined,
  json: boolean,
  results: unknown[],
): Promise<number> {
  // `--manifest-app`, else the block named by `--app` or declaring this path, else the only block.
  const manifestName = parsed.manifestApp ?? matchingManifestApp(process.cwd(), { app: parsed.app, path: pathArgument });
  const manifestDefaults = loadManifestAppDefaults(process.cwd(), manifestName, !pathArgument && !parsed.image);
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

    // kortix.yaml owns labels (when listed) and display (absent = the defaults).
    const sync = {
      ...(manifestBlock?.labels && JSON.stringify(manifestBlock.labels) !== JSON.stringify(app.labels ?? []) ? { labels: manifestBlock.labels } : {}),
      ...(manifestBlock && JSON.stringify(manifestBlock.display ?? {}) !== JSON.stringify(app.display ?? {}) ? { display: manifestBlock.display ?? {} } : {}),
    };
    if (Object.keys(sync).length > 0) app = await ctx.apps.update(app.app_id, sync);
    const releaseConfig = appReleaseInputFromBlock(manifestBlock);

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
        // The release config: processes, services, mounts, vm, deploy.
        ...(releaseConfig ? { config: releaseConfig } : {}),
      });
      if (flags.wait)
        deployment = await waitForDeployment(ctx.apps, app.app_id, deployment, flags.waitSeconds);
      const currentApp = flags.wait ? await ctx.apps.get(app.app_id) : app;
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
    const hosting = app.hosting_type === 'static'
        ? 'static · served from storage, no runtime'
        : app.hosting_type === 'sandbox'
          ? `server · ${app.always_on ? 'always on' : 'on demand'} · ${app.desired_state}`
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
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0]) return fail('logs needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const target = await scoped(ctx, () => resolveApp(ctx.apps, positional[0]!));
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
  const wait = !takeFlagBool(rest, ['--no-wait']);
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0] || !positional[1]) return fail('rollback needs an App and a release (vN or its id)');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, positional[0]!);
    const target = resolveDeploymentTarget(await ctx.apps.deployments.list(found.app_id), positional[1]!);
    // A NEW release from the target's artifact and config. A server
    // from before this answered the App alone, with traffic already moved.
    const app = (await ctx.apps.rollback(found.app_id, target.deployment_id)) as App & { deployment?: AppDeployment };
    const release = app.deployment && wait
      ? await waitForDeployment(ctx.apps, found.app_id, app.deployment, 1200)
      : app.deployment;
    return { app, target, release };
  });
  if (json) emitJson(result);
  else if (result.release) {
    process.stdout.write(
      `\n  ${status.ok(`v${result.release.version} ${result.release.status}: a rollback to v${result.target.version}`)}\n  ${result.app.url}\n\n`,
    );
  } else process.stdout.write(`\n  ${status.ok(`traffic moved to v${result.target.version}`)}\n  ${result.app.url}\n\n`);
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
      deploymentTarget
        ? 'deleting a deployment is destructive; pass --yes'
        : 'delete is destructive; pass --yes',
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
  const deleted = await scoped(ctx, () => ctx.apps.remove(app.app_id));
  const result = {
    ok: true,
    app_id: app.app_id,
    slug: app.slug,
    images: deleted.images ?? { released: 0, pending: 0 },
  };
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${status.ok(`deleted ${result.slug}`)}\n`);
    process.stdout.write(imageLines(result.images.released, result.images.pending));
    process.stdout.write('\n');
  }
  return 0;
}
