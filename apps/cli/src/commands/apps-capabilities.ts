import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { App, AppCapability, AppCredentials, AppDeployment, AppSnapshots } from '@kortix/sdk';
import { APP_CONNECT_TABS, type AppConnectTab, appConnectSnippets } from '@kortix/shared/app-connect';

import { openInBrowser } from '../browser.ts';
import { emitJson, fail, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, pad, status } from '../style.ts';
import { projectWebUrl } from '../web-url.ts';
import { type ContextOptions, context, resolveApp, scoped } from './apps-deploy.ts';

// The `kortix apps` subcommands that exist only for some Apps, each gated by
// one capability (snapshots, restore, admin_credentials, dashboard, logs,
// member_tokens), plus links (`uses`) and the deploy of an App whose kind
// deploys with its own client CLI. The CLI branches on capabilities, never on
// the kind.

type Ctx = NonNullable<Awaited<ReturnType<typeof context>>>;

const ENV_FORMATS = ['shell', 'dotenv', 'json'] as const;
type EnvFormat = (typeof ENV_FORMATS)[number];

/** Throws, in the words the API uses, when the App lacks `capability`. */
export function requireCapability(app: App, capability: AppCapability): void {
  if (app.capabilities?.includes(capability)) return;
  throw new Error(
    `App ${app.slug} (kind ${app.kind ?? 'web'}) does not support ${capability.replaceAll('_', ' ')}.`,
  );
}

/** Resolve the App named by `target` and check it has `capability`. */
async function capableApp(ctx: Ctx, target: string, capability: AppCapability): Promise<App> {
  const app = await scoped(ctx, () => resolveApp(ctx.apps, target));
  requireCapability(app, capability);
  return app;
}

/** POSIX single-quote escaping: `'` becomes `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single quotes keep a dotenv value literal. A value with `'` falls back to a JSON string. */
function dotenvQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
}

export function renderEnv(credentials: AppCredentials, format: EnvFormat): string {
  if (format === 'json') return `${JSON.stringify(credentials, null, 2)}\n`;
  const quote = format === 'shell' ? shellQuote : dotenvQuote;
  return Object.entries(credentials.env)
    .map(([key, value]) => (format === 'shell' ? `export ${key}=${quote(value)}` : `${key}=${quote(value)}`))
    .join('\n')
    .concat('\n');
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export const formatTime = (iso: string | null | undefined): string =>
  iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never';

/** The human `snapshots` output: automatic backup, schedule, then one row per snapshot. */
export function renderSnapshots(listed: AppSnapshots, slug: string): string {
  const { automatic, snapshots, snapshot_schedule: schedule } = listed;
  const every = automatic.interval_minutes ? ` · every ${automatic.interval_minutes} min` : '';
  const manual = snapshots.filter((row) => row.kind === 'manual').length;
  let out =
    `\n  ${C.bold}automatic${C.reset}  last ${formatTime(automatic.last_backup_at)} · ${formatBytes(automatic.size_bytes)}${every}\n` +
    `  ${C.bold}snapshots${C.reset}  ${snapshots.length} · ${manual} of ${listed.snapshot_limit} manual\n` +
    `  ${C.bold}schedule${C.reset}   daily snapshot every ${schedule.automatic_interval_hours} h, kept ${schedule.automatic_retention_days} days` +
    ` · last ${formatTime(schedule.last_automatic_at)} · resize snapshots kept ${schedule.resize_retention_hours} h\n`;
  if (snapshots.length === 0) {
    return `${out}\n  ${C.dim}No snapshots. Take one with kortix apps snapshot ${slug}.${C.reset}\n\n`;
  }
  const width = Math.max(11, ...snapshots.map((row) => row.snapshot_id.length));
  out += `\n  ${C.bold}${pad('SNAPSHOT', width)}  ${pad('KIND', 9)}  ${pad('CREATED', 20)}  ${pad('EXPIRES', 20)}  SIZE${C.reset}\n`;
  for (const row of snapshots) {
    const expires = row.expires_at ? formatTime(row.expires_at) : 'when deleted';
    out += `  ${pad(row.snapshot_id, width)}  ${pad(row.kind, 9)}  ${pad(formatTime(row.created_at), 20)}  ${pad(expires, 20)}  ${formatBytes(row.size_bytes)}\n`;
  }
  return `${out}\n`;
}

/** Ask unless `--yes` was passed. With no terminal the answer is no. */
async function confirmed(yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  const ok = await confirm(question, false, { onEndOfInput: false });
  if (!ok) process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
  return ok;
}

const firstArgs = (rest: string[]) => rest.filter((value) => !value.startsWith('-'));

export async function snapshotsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('snapshots needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'snapshots');
  const listed = await scoped(ctx, () => ctx.apps.snapshots.list(app.app_id));
  if (json) emitJson(listed);
  else process.stdout.write(renderSnapshots(listed, app.slug));
  return 0;
}

export async function snapshotCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('snapshot needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'snapshots');
  const snapshot = await scoped(ctx, () => ctx.apps.snapshots.create(app.app_id));
  if (json) emitJson(snapshot);
  else process.stdout.write(`\n  ${status.ok(`snapshot ${snapshot.snapshot_id} taken · kept until deleted`)}\n\n`);
  return 0;
}

export async function deleteSnapshotCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const [target, snapshotId] = firstArgs(rest);
  if (!target || !snapshotId) return fail('delete-snapshot needs an App id or slug and a snapshot id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'snapshots');
  if (!(await confirmed(yes, `Delete snapshot ${snapshotId} of ${C.bold}${app.slug}${C.reset}? This cannot be undone.`))) return 0;
  await scoped(ctx, () => ctx.apps.snapshots.delete(app.app_id, snapshotId));
  if (json) emitJson({ deleted: true, snapshot_id: snapshotId });
  else process.stdout.write(`\n  ${status.ok(`snapshot ${snapshotId} deleted`)}\n\n`);
  return 0;
}

export async function restoreCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const [target, snapshotId] = firstArgs(rest);
  if (!target || !snapshotId) return fail('restore needs an App id or slug and a snapshot id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'restore');
  const question = `Restore ${C.bold}${app.slug}${C.reset} to snapshot ${snapshotId}? Every change after the snapshot is lost.`;
  if (!(await confirmed(yes, question))) return 0;
  const restored = await scoped(ctx, () => ctx.apps.snapshots.restore(app.app_id, snapshotId));
  if (json) emitJson(restored);
  else process.stdout.write(`\n  ${status.ok(`restored ${restored.slug} to ${snapshotId}`)}\n\n`);
  return 0;
}

export async function credentialsCommand(rest: string[], options: ContextOptions): Promise<number> {
  const format = (takeFlagValue(rest, ['--format']) ?? 'shell') as EnvFormat;
  if (!ENV_FORMATS.includes(format)) return fail(`--format must be one of ${ENV_FORMATS.join(', ')}`);
  const [target] = firstArgs(rest);
  if (!target) return fail('credentials needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'admin_credentials');
  const credentials = await scoped(ctx, () => ctx.apps.credentials(app.app_id));
  process.stdout.write(renderEnv(credentials, format));
  return 0;
}

export async function rotateCredentialsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const [target] = firstArgs(rest);
  if (!target) return fail('rotate-credentials needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'admin_credentials');
  const question =
    `Rotate the admin key of ${C.bold}${app.slug}${C.reset}? Every key read before stops working ` +
    '(.env.local files, agent sessions). The App restarts for about 1 s.';
  if (!(await confirmed(yes, question))) return 0;
  const rotated = await scoped(ctx, () => ctx.apps.rotateCredentials(app.app_id));
  if (json) emitJson(rotated);
  else {
    process.stdout.write(
      `\n  ${status.ok(`rotated the admin key of ${rotated.slug}`)}\n  ${C.dim}Read the new key with kortix apps credentials ${rotated.slug}.${C.reset}\n\n`,
    );
  }
  return 0;
}

export async function tokenCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('token needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'member_tokens');
  const minted = await scoped(ctx, () => ctx.apps.token(app.app_id));
  if (json) emitJson(minted);
  else process.stdout.write(`${minted.token}\n`);
  return 0;
}

/** The process log of an App with the `logs` capability. */
export async function processLogCommand(ctx: Ctx, app: App, rest: string[], json: boolean): Promise<number> {
  const raw = takeFlagValue(rest, ['--lines', '-n']);
  const lines = raw === undefined ? 200 : Number(raw);
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) return fail('--lines must be a whole number from 1 to 1000');
  const log = await scoped(ctx, () => ctx.apps.log(app.app_id, { lines }));
  if (json) emitJson({ log });
  else process.stdout.write(log);
  return 0;
}

/** The Kortix Apps page with this App open: it frames the App's dashboard, signed in. */
export function appWebPage(projectUrl: string, appId: string): string {
  return `${projectUrl}/apps?app=${appId}`;
}

export async function dashboardCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const open = takeFlagBool(rest, ['--open']);
  const [target] = firstArgs(rest);
  if (!target) return fail('dashboard needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'dashboard');
  const url = appWebPage(projectWebUrl(ctx.auth.api_base, ctx.projectId, ctx.project.dashboard_url), app.app_id);
  if (json) {
    emitJson({ url, dashboard_available: !!app.instance?.dashboard_url, app });
    return 0;
  }
  process.stdout.write(`${url}\n`);
  if (!app.instance?.dashboard_url) {
    process.stderr.write(`${status.warn(`The dashboard opens when the App runs (now: ${app.instance?.status ?? 'unknown'}).`)}\n`);
  }
  if (open) openInBrowser(url);
  return 0;
}

const CONNECT_HEADINGS: Record<AppConnectTab, string> = {
  app: 'App: code of a Kortix App that uses this one',
  outside: 'From outside: scripts, services and your own servers',
  admin: 'CLI & admin: deploy and manage with the admin key',
};

/** The Connect dialog as text: per tab a heading, then each snippet's file and title, then its code as is. */
export function renderConnect(app: App): string {
  const snippets = appConnectSnippets(app);
  let out = '';
  for (const tab of APP_CONNECT_TABS) {
    const rows = snippets.filter((row) => row.tab === tab);
    if (rows.length === 0) continue;
    out += `\n${C.bold}${CONNECT_HEADINGS[tab]}${C.reset}\n`;
    for (const snippet of rows) out += `\n${C.dim}# ${snippet.file} · ${snippet.title}${C.reset}\n${snippet.code}\n`;
  }
  return `${out}\n`;
}

export async function connectCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('connect needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, () => resolveApp(ctx.apps, target));
  if (json) {
    emitJson({ app: { app_id: app.app_id, slug: app.slug, url: app.url, auth: app.auth ?? null }, snippets: appConnectSnippets(app) });
    return 0;
  }
  if (app.instance && app.instance.status !== 'running') {
    process.stderr.write(`${status.warn(`The App is ${app.instance.status}; its URLs appear when it runs.`)}\n`);
  }
  process.stdout.write(renderConnect(app));
  return 0;
}

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `--uses a,b`: trimmed, deduplicated App slugs; `--uses=` is the empty list. */
export function usesList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const slugs = [...new Set(value.split(',').map((slug) => slug.trim()).filter(Boolean))];
  const bad = slugs.find((slug) => !APP_SLUG.test(slug));
  if (bad) throw new Error(`--uses: "${bad}" is not an App slug (lowercase letters, numbers and single hyphens)`);
  return slugs;
}

/** `link <app> --uses a,b` adds to the Apps it uses; `unlink` removes them. */
export async function linkCommand(
  action: 'link' | 'unlink',
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const given = usesList(takeFlagValue(rest, ['--uses']));
  const [target] = firstArgs(rest);
  if (!target || !given?.length) return fail(`${action} needs an App and --uses <slugs>`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    const current = found.uses ?? [];
    const uses = action === 'link'
      ? [...new Set([...current, ...given])]
      : current.filter((slug) => !given.includes(slug));
    return ctx.apps.update(found.app_id, { uses });
  });
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`${app.slug} uses ${app.uses?.length ? app.uses.join(', ') : 'no App'}`)}\n\n`);
  return 0;
}

/**
 * The order to deploy a manifest's Apps in: every App after the Apps it uses
 * (`uses` within the manifest), `convex` before `web`, then by name. A use of
 * an App outside the manifest does not constrain the order. A cycle throws.
 */
export function deployOrder(blocks: Record<string, { kind?: string; uses?: string[] }>): string[] {
  const rank = (name: string) => `${blocks[name]!.kind === 'convex' ? 0 : 1}${name}`;
  const pending = new Set(Object.keys(blocks));
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((name) => (blocks[name]!.uses ?? []).every((used) => !pending.has(used) || used === name))
      .sort((a, b) => rank(a).localeCompare(rank(b)));
    if (ready.length === 0) {
      throw new Error(`kortix.yaml apps use each other in a cycle: ${[...pending].sort().join(', ')}`);
    }
    order.push(ready[0]!);
    pending.delete(ready[0]!);
  }
  return order;
}

/** A directory the Convex CLI deploys: it holds `convex/` or `convex.json`. */
export function isConvexProject(dir: string): boolean {
  return existsSync(join(dir, 'convex')) || existsSync(join(dir, 'convex.json'));
}

/** The child env for `convex deploy`: the App's credentials, minus every variable that selects another deployment. */
export function convexDeployEnv(base: NodeJS.ProcessEnv, credentials: AppCredentials): NodeJS.ProcessEnv {
  const env = { ...base, ...credentials.env };
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_DEPLOYMENT;
  return env;
}

/**
 * The command that runs `convex deploy`. The project's own CLI wins: it is the
 * version its code was written against. Otherwise npx runs the version the
 * App pins (`instance.client_version`), never `latest`: a newer CLI can need
 * APIs the App's machine does not have.
 */
export function convexDeployCommand(dir: string, version: string | undefined): [string, string[]] {
  const local = join(dir, 'node_modules', '.bin', 'convex');
  if (existsSync(local)) return [local, ['deploy']];
  return ['npx', ['--yes', version ? `convex@${version}` : 'convex', 'deploy']];
}

function runChild(dir: string, command: [string, string[]], extra: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command[0], [...command[1], ...extra], { cwd: dir, env, stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`${status.err(`could not run ${command[0]} ${command[1].join(' ')}: ${error.message}`)}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/** The commit `dir` is at, when it is a git checkout. */
function gitRevision(dir: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
}

/**
 * Deploy `dir` to an App with `admin_credentials` by running its kind's client
 * CLI (`convex deploy`) with the App's credentials, then record the deployment
 * (with the git commit as its revision) so the App's history shows who
 * deployed what. A failed run returns its exit code and records nothing.
 */
export async function deployWithClientCli(
  ctx: Ctx,
  target: App,
  dir: string,
  extra: string[],
): Promise<{ code: number; app: App; deployment?: AppDeployment }> {
  requireCapability(target, 'admin_credentials');
  const { app, credentials } = await scoped(ctx, async () => {
    const ready = await ctx.apps.waitUntilReady(target.app_id);
    return { app: ready, credentials: await ctx.apps.credentials(ready.app_id) };
  });
  const command = convexDeployCommand(dir, app.instance?.client_version);
  process.stderr.write(
    `${C.dim}Deploying ${dir} to ${app.slug} (${credentials.url}) with ${command[0] === 'npx' ? `npx ${command[1][1]}` : command[0]}${C.reset}\n`,
  );
  const code = await runChild(dir, command, extra, convexDeployEnv(process.env, credentials));
  if (code !== 0) return { code, app };
  const revision = gitRevision(dir);
  const deployment = await scoped(ctx, () =>
    ctx.apps.deployments.create(app.app_id, { source: { kind: 'convex', ...(revision ? { revision } : {}) } }),
  );
  return { code: 0, app, deployment };
}
