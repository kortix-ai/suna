#!/usr/bin/env bun
/**
 * pnpm worktree — isolated multi-instance dev worktrees.
 *
 * Interactive: run `pnpm worktree` for a menu, or `pnpm worktree create` for a
 * guided wizard. Non-interactive (CI/scripts):
 *
 *   pnpm worktree create --name <feat> [--branch b] [--from HEAD] [--db] [--no-start] [--yes]
 *   pnpm worktree start|stop|nuke|status <feat>
 *   pnpm worktree list · doctor
 *
 * One command from a fresh clone sets up EVERYTHING (deps, git worktree, unique
 * ports, install, optional isolated Supabase, prereqs + node-pg-migrate) and boots the stack. Many
 * worktrees run at once with zero collisions; the primary `pnpm dev` is untouched except
 * when the default shared-DB mode deliberately uses its standard local Supabase.
 */
import {
  STRIDE, BASE, computePorts, loadRegistry, saveRegistry, withLock, sanitizeName,
  lowestFreeSlot, sh, run, which, portInUse, repoRoot, defaultWorktreePath, branchExists,
  renderSupabaseProject, runMigrate, supa, supaStatusEnv, slotCredsFromStatus, apiLaunchEnv, webLaunchEnv, gatewayLaunchEnv,
  writeMarker, ensureDeps, checkDeps, pnpmStore, supaWorkdir, slotDir, startTunnel, startStripeListen, WT_HOME, REGISTRY_PATH,
  startSupabaseDb, startSupabaseFullStack, hasKortixSchema, ensureRuntimeArtifacts, dbModeOf,
  ensurePrimarySupabase, primaryCredsFromStatus, SHARED_SUPABASE_PORTS,
  type Registry, type SlotEntry, type Ports, type Tunnel, type StripeListen,
  type DbMode,
} from './lib';
import { existsSync, rmSync } from 'node:fs';
import * as clack from '@clack/prompts';
import pc from 'picocolors';

const API_FILTER = 'kortix-api';
const WEB_FILTER = 'Kortix-Computer-Frontend';
const GATEWAY_FILTER = '@kortix/llm-gateway-server';

const step = (s: string) => console.log(`\n${pc.cyan('▸')} ${pc.bold(s)}`);
const sub = (s: string) => console.log(`  ${pc.dim(s)}`);
const ok = (s: string) => console.log(`${pc.green('✓')} ${s}`);
const warn = (s: string) => console.log(`${pc.yellow('!')} ${s}`);
const die = (s: string): never => { console.error(`\n${pc.red('✗')} ${s}`); process.exit(1); };
const url = (u: string) => pc.cyan(pc.underline(u));

// Free any stale process still holding this slot's ports — a previous `up` that
// didn't shut down cleanly, or a gateway that crashed but left the port bound.
// Without this the fresh gateway hits EADDRINUSE on its slot port; and because
// `bun --hot` stays alive after a startup throw (it keeps the reload watcher
// running), it would never actually listen, yet `Promise.race([...exited])`
// can't see it — so the API would silently fall back to the single-model
// passthrough. We only ever touch this worktree's own slot ports.
async function freeSlotPorts(ports: Ports): Promise<void> {
  let freed = 0;
  for (const [label, port] of [['web', ports.web], ['api', ports.api], ['gateway', ports.gateway]] as const) {
    const u = portInUse(port);
    if (u.inUse && u.pid) {
      sub(`freeing stale ${label} process on :${port} (pid ${u.pid})`);
      sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]);
      freed++;
    }
  }
  if (freed) await Bun.sleep(400);
}

// Gate on the gateway actually listening. The API proxies sandbox LLM traffic to
// it, so a dead gateway silently degrades sandboxes to the single-model
// passthrough (wrong catalog). `bun --hot` swallows a startup crash, so the
// exit-race never fires — poll the readiness endpoint and say so plainly.
async function waitForGateway(port: number, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      warn(`llm gateway exited (code ${proc.exitCode}) before it came up — the API will fall back to the single-model passthrough. See the gateway logs above.`);
      return;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { ok(`llm gateway ready on :${port}`); return; }
    } catch {}
    await Bun.sleep(500);
  }
  warn(`llm gateway never became healthy on :${port} (30s) — the API will fall back to the single-model passthrough (wrong catalog). Is :${port} already in use? Check the gateway logs above.`);
}
const dot = (up: boolean) => (up ? pc.green('●') : pc.dim('○'));

async function spin(label: string, cmd: string[]): Promise<void> {
  const s = clack.spinner();
  s.start(label);
  try {
    await Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exited;
    s.stop(`${label} ${pc.green('✓')}`);
  } catch {
    s.stop(`${label} ${pc.dim('(skipped)')}`);
  }
}

interface Args { cmd: string; name?: string; flags: Record<string, string | boolean>; }
function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'help';
  const flags: Record<string, string | boolean> = {};
  let name: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else if (!name) name = a;
  }
  if (typeof flags.name === 'string') name = flags.name;
  return { cmd, name, flags };
}

function usage(): never {
  console.log(`
${pc.bgCyan(pc.black(' pnpm worktree '))}  ${pc.dim('isolated multi-instance dev worktrees')}

  ${pc.cyan('pnpm worktree')}                 ${pc.dim('interactive menu')}
  ${pc.cyan('pnpm worktree create')}          ${pc.dim('guided wizard (or --name <n> --from <branch> [--db] [--no-tunnel])')}
  ${pc.cyan('start')} ${pc.dim('<n> [--stripe] [--no-tunnel]')}   ${pc.cyan('stop')} ${pc.dim('<n>')}   ${pc.cyan('nuke')} ${pc.dim('<n> [--force]')}
  ${pc.cyan('pr')} ${pc.dim('<n> [--title … --base main --draft --web]')}
  ${pc.cyan('list')}        ${pc.cyan('status')} ${pc.dim('[n]')}   ${pc.cyan('doctor')} ${pc.dim('[--yes]')}

Each worktree gets a unique port block (base ${BASE.web}/${BASE.api}, +${STRIDE} per slot),
shares the primary Supabase DB by default, and gets its own node_modules. Pass ${pc.cyan('--db')}
to opt into a separate Supabase project. State in ${pc.dim(WT_HOME)}.
The primary ${pc.bold('pnpm dev')} (3000/8008) is never touched.`);
  process.exit(2);
}

function need(name: string | undefined): string {
  if (!name) die('a worktree <name> is required (or run `pnpm worktree` for the menu)');
  return sanitizeName(name!);
}

function portsLine(p: Ports): string {
  return `${pc.bold('web')} ${pc.green(String(p.web))} ${pc.dim('·')} ${pc.bold('api')} ${pc.green(String(p.api))} ` +
    `${pc.dim('·')} db ${pc.green(String(p.sbDb))} ${pc.dim('·')} studio ${pc.green(String(p.sbStudio))} ${pc.dim('·')} inbucket ${pc.green(String(p.sbInbucket))}`;
}
function dbModeFromFlags(flags: Record<string, string | boolean>): DbMode {
  if (flags.db || flags['with-db'] || flags['isolated-db']) return 'isolated';
  if (flags['no-db'] || flags['shared-db']) return 'shared';
  return 'shared';
}
function dbLabel(mode: DbMode): string {
  return mode === 'isolated' ? 'isolated Supabase' : 'shared primary Supabase';
}

function currentBranch(): string { return sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'main'; }
function recentBranches(limit = 12): string[] {
  return sh(['git', 'for-each-ref', `--count=${limit}`, '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
function branchConflict(root: string, branch: string): string | null {
  if (!sh(['git', '-C', root, 'check-ref-format', `refs/heads/${branch}`]).ok)
    return `"${branch}" is not a valid git branch name`;
  const kids = sh(['git', '-C', root, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}/`]).stdout.trim();
  if (kids) return `a branch namespace "${branch}/…" already exists (e.g. "${kids.split('\n')[0]}") — git can't also have a branch literally named "${branch}"`;
  const parts = branch.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (branchExists(root, parent)) return `branch "${parent}" already exists, so "${branch}" can't be created beneath it`;
  }
  return null;
}

function cancelled(v: unknown): boolean { if (clack.isCancel(v)) { clack.cancel('Cancelled.'); return true; } return false; }

async function confirmStripe(): Promise<boolean> {
  const v = await clack.confirm({ message: 'Enable Stripe? (billing on + webhook forwarding to this worktree)', initialValue: false });
  return clack.isCancel(v) ? false : v;
}

async function promptCreate(): Promise<Args | null> {
  const name = await clack.text({
    message: 'Name for the worktree',
    placeholder: 'sandbox-core',
    validate: (v) => { const t = (v ?? '').trim(); if (!t) return 'Required'; if (!/^[a-zA-Z0-9-]+$/.test(t)) return 'letters, numbers and dashes only'; },
  });
  if (cancelled(name)) return null;
  const cur = currentBranch();
  const seen = new Set<string>();
  const ordered = ['main', cur, ...recentBranches(12)].filter((b) => b && !seen.has(b) && (seen.add(b), true));
  const OTHER = ' other';
  const sel = await clack.select({
    message: 'Base branch to fork from',
    initialValue: 'main',
    maxItems: 8,
    options: [
      ...ordered.map((b) => ({ value: b, label: b === 'main' ? `${b} ${pc.dim('(default)')}` : b === cur ? `${b} ${pc.dim('(current)')}` : b })),
      { value: OTHER, label: pc.dim('✎ type a branch name…') },
    ],
  });
  if (cancelled(sel)) return null;
  let from = String(sel);
  if (from === OTHER) {
    const typed = await clack.text({
      message: 'Branch name',
      placeholder: cur,
      validate: (v) => { const t = (v ?? '').trim(); if (!t) return 'Required'; if (!branchExists(repoRoot(), t)) return `branch "${t}" not found`; },
    });
    if (cancelled(typed)) return null;
    from = String(typed);
  }
  const start = await clack.confirm({ message: 'Boot the dev servers when it’s ready?', initialValue: true });
  if (cancelled(start)) return null;
  const isolatedDb = await clack.confirm({ message: 'Create a separate Supabase database for this worktree?', initialValue: false });
  if (cancelled(isolatedDb)) return null;
  const stripe = start ? await confirmStripe() : false;
  return { cmd: 'create', name: String(name), flags: { from: String(from), yes: true, ...(isolatedDb ? { db: true } : {}), ...(start ? {} : { 'no-start': true }), ...(stripe ? { stripe: true } : {}) } };
}

async function pickWorktree(action: string): Promise<string | null> {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { clack.cancel('No worktrees yet — create one first.'); return null; }
  const sel = await clack.select({
    message: `Which worktree to ${pc.bold(action)}?`,
    options: names.sort((x, y) => reg.slots[x].slot - reg.slots[y].slot).map((n) => {
      const e = reg.slots[n];
      return { value: n, label: `${dot(e.status === 'running')} ${n}`, hint: `slot ${e.slot} · ${e.status} · web ${e.ports.web}` };
    }),
  });
  if (cancelled(sel)) return null;
  return String(sel);
}

async function menu(): Promise<Args | null> {
  const action = await clack.select({
    message: 'What would you like to do?',
    options: [
      { value: 'create', label: `${pc.green('✦')} create`, hint: 'set up a new isolated worktree' },
      { value: 'start', label: `${pc.cyan('▶')} start`, hint: 'boot an existing worktree' },
      { value: 'stop', label: `${pc.yellow('■')} stop`, hint: 'stop a worktree (keeps data)' },
      { value: 'list', label: `${pc.blue('≡')} list`, hint: 'all worktrees + ports' },
      { value: 'status', label: `${pc.magenta('◇')} status`, hint: 'live health' },
      { value: 'pr', label: `${pc.green('⇡')} pr`, hint: 'push the branch + open a PR' },
      { value: 'nuke', label: `${pc.red('✗')} nuke`, hint: 'tear down + free the slot' },
      { value: 'doctor', label: `${pc.dim('✚')} doctor`, hint: 'check the toolchain' },
    ],
  });
  if (cancelled(action)) return null;
  const cmd = String(action);
  if (cmd === 'create') return promptCreate();
  if (['start', 'stop', 'nuke', 'status', 'pr'].includes(cmd)) {
    const name = await pickWorktree(cmd);
    if (!name) return null;
    const flags: Record<string, string | boolean> = cmd === 'nuke' ? { force: true } : {};
    if (cmd === 'start' && await confirmStripe()) flags.stripe = true;
    return { cmd, name, flags };
  }
  return { cmd, name: undefined, flags: {} };
}

async function cmdCreate(a: Args) {
  const name = need(a.name);
  const tunnel = !a.flags['no-tunnel'];
  const install = !!a.flags.yes;
  const requestedDbMode = dbModeFromFlags(a.flags);
  const startsNow = !a.flags['no-start'];
  const needsDatabaseTooling = requestedDbMode === 'isolated' || startsNow;
  const needsIsolatedDatabaseTooling = requestedDbMode === 'isolated';

  step('Preflight: toolchain');
  if (!(await ensureDeps({ database: needsDatabaseTooling, isolatedDatabase: needsIsolatedDatabaseTooling, tunnel, install }))) {
    die('Missing dependencies above. Re-run with --yes to auto-install, or install them and retry.');
  }

  const root = repoRoot();
  const wtPath = defaultWorktreePath(root, name);
  const branch = (typeof a.flags.branch === 'string' && a.flags.branch) || name;
  const from = (typeof a.flags.from === 'string' && a.flags.from) || 'HEAD';

  if (!branchExists(root, branch)) {
    const conflict = branchConflict(root, branch);
    if (conflict) die(`can't create branch "${branch}": ${conflict}.\n  Pick another name: pnpm worktree create --name ${name} --branch <branch>`);
  }

  let isNew = false;
  const entry = await withLock<SlotEntry>(() => {
    const reg = loadRegistry();
    if (reg.slots[name]) {
      const existing = reg.slots[name];
      const existingMode = dbModeOf(existing);
      if (existingMode !== requestedDbMode && (a.flags.db || a.flags['with-db'] || a.flags['isolated-db'] || a.flags['no-db'] || a.flags['shared-db'])) {
        throw new Error(`worktree "${name}" already uses ${dbLabel(existingMode)}; nuke/recreate it to switch database modes`);
      }
      sub(`resuming existing worktree "${name}" (slot ${existing.slot}, ${dbLabel(existingMode)})`);
      return existing;
    }
    isNew = true;
    let slot = lowestFreeSlot(reg);
    for (let tries = 0; tries < 6; tries++) {
      const ports = computePorts(slot);
      const clash = (Object.entries(ports) as [string, number][]).map(([k, p]) => ({ k, p, ...portInUse(p) })).find((x) => x.inUse);
      if (!clash) break;
      sub(`port ${clash.p} (${clash.k}) in use by ${clash.cmd ?? '?'} (pid ${clash.pid ?? '?'}) — trying next slot`);
      slot++;
      if (tries === 5) die('could not find a free port block after 6 slots');
    }
    const ports = computePorts(slot);
    const e: SlotEntry = { slot, projectId: `kortix-wt-${name}`, path: wtPath, branch, ports, dbMode: requestedDbMode, createdAt: new Date().toISOString(), status: 'created' };
    reg.slots[name] = e; saveRegistry(reg);
    return e;
  });

  const dbMode = dbModeOf(entry);
  if (dbMode === 'isolated' && !needsDatabaseTooling) {
    step('Preflight: database tooling');
    if (!(await ensureDeps({ database: true, isolatedDatabase: true, install }))) {
      die('Missing database dependencies above. Re-run with --yes to auto-install, or install them and retry.');
    }
  }
  step(`Slot ${entry.slot} — ${portsLine(entry.ports)} — ${dbLabel(dbMode)}`);

  const failCreate = async (msg: string): Promise<never> => {
    if (isNew) await withLock(() => { const r = loadRegistry(); delete r.slots[name]; saveRegistry(r); });
    return die(msg);
  };

  step(`Git worktree ${pc.dim('→')} ${wtPath}`);
  const existing = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  if (existing.includes(`worktree ${wtPath}`)) {
    sub('already exists — reusing');
  } else if (branchExists(root, branch)) {
    const r = sh(['git', '-C', root, 'worktree', 'add', wtPath, branch]);
    if (!r.ok) await failCreate(`git worktree add failed: ${r.stderr}`);
    sub(`checked out existing branch "${branch}"`);
  } else {
    const r = sh(['git', '-C', root, 'worktree', 'add', '-b', branch, wtPath, from]);
    if (!r.ok) await failCreate(`git worktree add -b failed: ${r.stderr}`);
    sub(`created branch "${branch}" from ${from}`);
  }

  step('Installing dependencies (own pnpm store)');
  if (await run(['pnpm', 'install', '--store-dir', pnpmStore(name)], { cwd: wtPath }) !== 0) die(`pnpm install failed — fix and re-run \`pnpm worktree create --name ${name}\``);

  if (dbMode === 'isolated') {
    step(`Rendering isolated Supabase project ${pc.dim('('+entry.projectId+')')}`);
    renderSupabaseProject(name, wtPath, entry.projectId, entry.ports);

    step(`Starting isolated Postgres on db ${entry.ports.sbDb}`);
    if (await startSupabaseDb(name) !== 0) die('supabase db start failed');

    step('Building schema (prereqs + pnpm migrate)');
    if (await runMigrate(wtPath, entry.ports) !== 0) die(`migrate failed — fix and re-run \`pnpm worktree create --name ${name}\``);
    if (!hasKortixSchema(entry.ports)) die(`schema not built — \`pnpm migrate\` produced no kortix schema on branch "${branch}".\n  Check packages/db/migrations/*.sql exist on this branch and the Supabase prereqs applied (psql + Basejump).`);

    step(`Starting isolated Supabase on api ${entry.ports.sbApi}`);
    if (await startSupabaseFullStack(name, entry.ports) !== 0) die('supabase start failed');
  } else {
    sub(`database mode: shared — skips Supabase project creation; start uses the primary checkout's standard local Supabase`);
  }

  step('Building runtime artifacts');
  if (await ensureRuntimeArtifacts(wtPath) !== 0) die('runtime artifact build failed');

  writeMarker(wtPath, entry);
  await withLock(() => { const reg = loadRegistry(); if (reg.slots[name]) { reg.slots[name].status = 'created'; saveRegistry(reg); } });

  clack.note(
    `${pc.dim('path')}    ${wtPath}\n` +
    `${pc.dim('web')}     ${url('http://localhost:' + entry.ports.web)}\n` +
    `${pc.dim('api')}     http://localhost:${entry.ports.api}\n` +
    (dbMode === 'isolated'
      ? `${pc.dim('studio')}  http://localhost:${entry.ports.sbStudio}`
      : `${pc.dim('db')}      shared primary Supabase (${SHARED_SUPABASE_PORTS.sbApi}/${SHARED_SUPABASE_PORTS.sbDb})`),
    pc.green(`✓ worktree "${name}" ready`),
  );
  if (a.flags['no-start']) { ok(`start it:  ${pc.cyan('pnpm worktree start ' + name)}`); }
  else { await cmdStart({ cmd: 'start', name, flags: { ...(a.flags['no-tunnel'] ? { 'no-tunnel': true } : {}), ...(a.flags.stripe ? { stripe: true } : {}) } }); }
}

async function cmdStart(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const entry = reg.slots[name];
  if (!entry) die(`unknown worktree "${name}" — create it first`);
  if (!existsSync(entry!.path)) die(`worktree dir missing (${entry!.path}); run \`pnpm worktree nuke ${name}\` then recreate`);
  if (!(await ensureDeps({ database: true, isolatedDatabase: dbModeOf(entry) === 'isolated', tunnel: !a.flags['no-tunnel'], install: false }))) {
    die('Missing dependencies above. Install them and retry.');
  }
  if (!sh(['docker', 'info']).ok) die('Docker daemon not running — start Docker and retry');
  const e = entry!;
  const dbMode = dbModeOf(e);

  // Heal a stale ports cache. The registry stores a denormalized copy of
  // computePorts(slot), so a worktree created before a port was added to BASE
  // (e.g. the standalone gateway) has that field missing — String(undefined)
  // then makes the gateway fall back to its default 8090 and the API lose its
  // proxy (LLM_GATEWAY_PROXY_PORT="undefined"). The slot is the source of truth:
  // recompute every port from it, and persist so the entry is fixed for good.
  const freshPorts = computePorts(e.slot);
  if (JSON.stringify(freshPorts) !== JSON.stringify(e.ports)) {
    const added = (Object.keys(freshPorts) as (keyof typeof freshPorts)[]).filter((k) => e.ports[k] !== freshPorts[k]);
    e.ports = freshPorts;
    await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].ports = freshPorts; saveRegistry(r); } });
    sub(`refreshed slot ${e.slot} ports from BASE (${added.join(', ')}) → gateway :${freshPorts.gateway}`);
  }

  let creds;
  if (dbMode === 'isolated') {
    renderSupabaseProject(name, e.path, e.projectId, e.ports);
    step(`Starting Postgres for "${name}"`);
    if (await startSupabaseDb(name) !== 0) die('supabase db start failed');
    step('Applying pending migrations (pnpm migrate)');
    if (await runMigrate(e.path, e.ports) !== 0) die('migrate failed');
    if (!hasKortixSchema(e.ports)) die(`schema not built for "${name}"`);
    if (!sh(['supabase', '--workdir', supaWorkdir(name), 'status']).ok) {
      step(`Starting Supabase for "${name}"`);
      if (await startSupabaseFullStack(name, e.ports) !== 0) die('supabase start failed');
    } else if (!portInUse(e.ports.sbApi).inUse) {
      step(`Starting Supabase services for "${name}"`);
      if (await startSupabaseFullStack(name, e.ports) !== 0) die('supabase start failed');
    }
    creds = slotCredsFromStatus(e.ports, supaStatusEnv(name));
  } else {
    step('Using shared primary Supabase');
    const env = await ensurePrimarySupabase(repoRoot());
    creds = primaryCredsFromStatus(env);
    if (!creds.supabaseUrl || !creds.dbUrl || !creds.serviceRoleKey || !creds.anonKey) {
      die('primary Supabase credentials are unavailable. Start the primary local stack once with `pnpm dev`, or recreate this worktree with `--db` for an isolated database.');
    }
    const sharedSchemaPorts = { ...e.ports, ...SHARED_SUPABASE_PORTS };
    if (!hasKortixSchema(sharedSchemaPorts)) {
      die('the shared primary Supabase DB does not have the kortix schema. Run the primary stack once to initialize it, or recreate this worktree with `--db` for an isolated database.');
    }
    sub(`${creds.supabaseUrl} · ${creds.dbUrl}`);
  }
  step('Building runtime artifacts');
  if (await ensureRuntimeArtifacts(e.path) !== 0) die('runtime artifact build failed');

  for (const port of [e.ports.web, e.ports.api]) { const u = portInUse(port); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]); }
  await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'running'; saveRegistry(r); } });

  let tunnel: Tunnel | null = null;
  if (!a.flags['no-tunnel']) {
    step('Cloudflare tunnel (cloud sandbox callback)');
    tunnel = await startTunnel(e.ports.api);
    if (tunnel) sub(`KORTIX_URL → ${tunnel.url}`);
    else warn('no tunnel (cloudflared missing or timed out) — cloud sandboxes won’t be reachable; `brew install cloudflared` and restart, or pass --no-tunnel to silence');
  }

  let stripe: StripeListen | null = null;
  if (a.flags.stripe) {
    step('Stripe webhook forwarding (billing on)');
    stripe = await startStripeListen(e.ports.api);
    if (stripe) sub(`stripe listen → http://localhost:${e.ports.api}/v1/billing/webhooks/stripe  ${pc.dim('(whsec injected)')}`);
    else warn('stripe CLI missing or not logged in — billing NOT enabled. Install it and run `stripe login`, then restart with --stripe.');
  }

  await freeSlotPorts(e.ports);

  console.log(`\n${pc.green('🚀')} ${pc.bold(name)}   web ${url('http://localhost:' + e.ports.web)}  ${pc.dim('·')}  api http://localhost:${e.ports.api}  ${pc.dim('·')}  ${dbMode === 'isolated' ? `studio http://localhost:${e.ports.sbStudio}` : `db ${pc.dim('shared primary Supabase')}`}`);
  console.log(`${pc.dim('   llm gateway')} http://localhost:${e.ports.gateway} ${pc.dim('(standalone · slot port · API proxies /v1/llm-gateway/*)')}`);
  if (tunnel) console.log(`${pc.dim('   sandbox callback')} ${url(tunnel.url)}`);
  if (stripe) console.log(`${pc.dim('   billing')} ${pc.green('on')} ${pc.dim('· stripe webhooks → :' + e.ports.api)}`);
  console.log(pc.dim('   (Ctrl+C stops the dev servers cleanly)\n'));

  const api = Bun.spawn(['pnpm', '--filter', API_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...apiLaunchEnv(e.ports, creds, { kortixUrl: tunnel?.url, stripeWebhookSecret: stripe?.secret }) }, stdout: 'inherit', stderr: 'inherit' });
  const gateway = Bun.spawn(['pnpm', '--filter', GATEWAY_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...gatewayLaunchEnv(e.ports) }, stdout: 'inherit', stderr: 'inherit' });
  const web = Bun.spawn(['pnpm', '--filter', WEB_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...webLaunchEnv(e.ports, creds, { billing: !!stripe }) }, stdout: 'inherit', stderr: 'inherit' });
  void waitForGateway(e.ports.gateway, gateway);
  const killListeners = (sig: string) => { for (const port of [e.ports.web, e.ports.api, e.ports.gateway]) { const u = portInUse(port); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${sig} ${u.pid} 2>/dev/null || true`]); } };
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    console.log(`\n${pc.yellow('▸')} stopping…`);
    try { api.kill(); } catch {} try { gateway.kill(); } catch {} try { web.kill(); } catch {} try { tunnel?.proc.kill(); } catch {} try { stripe?.proc.kill(); } catch {}
    killListeners('');
    await Promise.race([Promise.all([api.exited, gateway.exited, web.exited]), Bun.sleep(6000)]);
    killListeners('-9');
    await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'stopped'; saveRegistry(r); } });
    ok('stopped.');
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await Promise.race([api.exited, gateway.exited, web.exited]);
  await shutdown();
}

async function cmdStop(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const e = reg.slots[name];
  if (!e) die(`unknown worktree "${name}"`);
  step(`Stopping "${name}"`);
  for (const port of [e!.ports.web, e!.ports.api, e!.ports.gateway]) { const u = portInUse(port); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]); }
  if (dbModeOf(e!) === 'isolated') sh(['supabase', '--workdir', supaWorkdir(name), 'stop']);
  else sub('shared primary Supabase left running');
  await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'stopped'; saveRegistry(r); } });
  ok(`stopped (data preserved). Restart with ${pc.cyan('pnpm worktree start ' + name)}.`);
}

async function cmdNuke(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const e = reg.slots[name];
  if (!e) die(`unknown worktree "${name}"`);
  const pid = e!.projectId;
  const dbMode = dbModeOf(e!);
  step(`Nuking "${name}" ${pc.dim(dbMode === 'isolated' ? '(project ' + pid + ')' : '(shared DB mode)')}`);
  for (const port of [e!.ports.web, e!.ports.api, e!.ports.gateway]) { const u = portInUse(port); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]); }
  if (dbMode === 'isolated') {
    await spin('Stopping Supabase containers', ['supabase', '--workdir', supaWorkdir(name), 'stop', '--no-backup']);
    await spin('Removing Docker containers', ['bash', '-lc', `docker rm -f $(docker ps -aq --filter "name=_${pid}$") 2>/dev/null || true`]);
    await spin('Removing volumes & network', ['bash', '-lc', `docker volume rm $(docker volume ls -q --filter "name=_${pid}$") 2>/dev/null; docker network rm supabase_network_${pid} 2>/dev/null || true`]);
  } else {
    sub('shared primary Supabase left untouched');
  }
  const root = repoRoot();
  const force = a.flags.force ? ['--force'] : [];
  if (existsSync(e!.path)) { sub('removing git worktree…'); sh(['git', '-C', root, 'worktree', 'remove', ...force, e!.path]); }
  sh(['git', '-C', root, 'worktree', 'prune']);
  if (e!.branch) {
    const del = sh(['git', '-C', root, 'branch', '-d', e!.branch]);
    if (del.ok) sub(`deleted branch "${e!.branch}"`);
    else if (a.flags.force) { sh(['git', '-C', root, 'branch', '-D', e!.branch]); sub(`force-deleted branch "${e!.branch}" (had unmerged commits)`); }
    else sub(`kept branch "${e!.branch}" (unmerged commits) — \`git branch -D ${e!.branch}\` or \`nuke --force\` to drop it`);
  }
  try { rmSync(slotDir(name), { recursive: true, force: true }); } catch {}
  await withLock(() => { const r = loadRegistry(); delete r.slots[name]; saveRegistry(r); });
  ok(`removed "${name}" — slot ${e!.slot} freed.`);
}

function cmdList() {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { console.log(`\n  ${pc.dim('No worktrees.')} Create one: ${pc.cyan('pnpm worktree create')}`); return; }
  const statusColor: Record<string, (s: string) => string> = { running: pc.green, stopped: pc.dim, created: pc.yellow };
  console.log('\n  ' + pc.dim('NAME'.padEnd(20) + 'SLOT  STATUS    DB MODE     BRANCH'.padEnd(42) + 'WEB    API    DB     STUDIO'));
  for (const n of names.sort((x, y) => reg.slots[x].slot - reg.slots[y].slot)) {
    const e = reg.slots[n];
    const col = statusColor[e.status] ?? ((s: string) => s);
    const dbMode = dbModeOf(e);
    console.log('  ' +
      pc.bold(n.padEnd(20)) + pc.dim(String(e.slot).padEnd(6)) + col(e.status.padEnd(10)) + dbMode.padEnd(12) + e.branch.slice(0, 20).padEnd(22) +
      pc.green(String(e.ports.web).padEnd(7)) + pc.green(String(e.ports.api).padEnd(7)) +
      String(dbMode === 'isolated' ? e.ports.sbDb : SHARED_SUPABASE_PORTS.sbDb).padEnd(7) +
      String(dbMode === 'isolated' ? e.ports.sbStudio : SHARED_SUPABASE_PORTS.sbStudio));
  }
  console.log('');
}

function cmdStatus(a: Args) {
  const reg = loadRegistry();
  const names = a.name ? [sanitizeName(a.name)] : Object.keys(reg.slots);
  if (!names.length) { console.log(`\n  ${pc.dim('No worktrees.')}`); return; }
  for (const n of names) {
    const e = reg.slots[n];
    if (!e) { warn(`${n}: unknown`); continue; }
    const dbMode = dbModeOf(e);
    const sb = dbMode === 'isolated'
      ? sh(['supabase', '--workdir', supaWorkdir(n), 'status']).ok
      : portInUse(SHARED_SUPABASE_PORTS.sbApi).inUse;
    console.log(`\n${pc.bold(n)}  ${pc.dim(`(slot ${e.slot} · ${e.status} · ${dbMode})`)}  ${pc.dim(e.path)}`);
    console.log(`  web    ${dot(portInUse(e.ports.web).inUse)} :${e.ports.web}    api ${dot(portInUse(e.ports.api).inUse)} :${e.ports.api}`);
    if (dbMode === 'isolated') console.log(`  supa   ${dot(sb)} db :${e.ports.sbDb}  studio :${e.ports.sbStudio}  inbucket :${e.ports.sbInbucket}`);
    else console.log(`  supa   ${dot(sb)} shared db :${SHARED_SUPABASE_PORTS.sbDb}  studio :${SHARED_SUPABASE_PORTS.sbStudio}  inbucket :${SHARED_SUPABASE_PORTS.sbInbucket}`);
  }
  console.log('');
}

async function cmdDoctor(a: Args) {
  step('Toolchain');
  await ensureDeps({ database: true, isolatedDatabase: true, tunnel: true, install: !!a.flags.yes });
  step('Worktree integrity');
  const reg = loadRegistry();
  const root = repoRoot();
  const wts = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  for (const [n, e] of Object.entries(reg.slots)) {
    const issues: string[] = [];
    if (!existsSync(e.path)) issues.push('worktree dir missing');
    else if (!wts.includes(`worktree ${e.path}`)) issues.push('not a registered git worktree');
    const dbMode = dbModeOf(e);
    const orphan = dbMode === 'isolated'
      ? sh(['bash', '-lc', `docker ps -aq --filter "name=_${e.projectId}$" | head -1`]).stdout.trim()
      : '';
    console.log(`  ${issues.length ? pc.red('✗') : pc.green('✓')} ${n} ${pc.dim('(' + dbMode + ')')}${issues.length ? ' ' + pc.red(issues.join('; ')) : ''}${orphan ? pc.dim(' (containers present)') : ''}`);
  }
  console.log(`\n  ${pc.dim('registry: ' + REGISTRY_PATH)}`);
}

function repoSlug(path: string, remote = 'origin'): string | null {
  const u = sh(['git', '-C', path, 'remote', 'get-url', remote]).stdout.trim();
  return u.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

async function cmdPr(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const e = reg.slots[name];
  if (!e) die(`unknown worktree "${name}" — create it first`);
  if (!existsSync(e.path)) die(`worktree dir missing (${e.path})`);
  const { path, branch } = e;
  const base = (typeof a.flags.base === 'string' && a.flags.base) || 'main';

  const ahead = sh(['git', '-C', path, 'rev-list', '--count', `${base}..${branch}`]).stdout.trim();
  if (!ahead || ahead === '0') die(`"${branch}" has no commits ahead of ${base} — commit something first`);
  if (sh(['git', '-C', path, 'status', '--porcelain']).stdout.trim())
    warn(`uncommitted changes in "${name}" won't be in the PR — commit them first if you want them included`);

  step(`Pushing ${pc.bold(branch)} → origin ${pc.dim(`(${ahead} commit${ahead === '1' ? '' : 's'} ahead of ${base})`)}`);
  if (await run(['git', '-C', path, 'push', '-u', 'origin', branch]) !== 0)
    die('git push failed — check your remote auth and retry');

  if (!which('gh')) {
    const slug = repoSlug(path);
    warn('gh CLI not found — branch pushed. Open the PR here:');
    sub(slug ? url(`https://github.com/${slug}/compare/${base}...${branch}?expand=1`) : `compare ${base}...${branch} on GitHub`);
    sub(`or install it (${pc.cyan('brew install gh')}) and re-run ${pc.cyan('pnpm worktree pr ' + name)}`);
    return;
  }

  step('Opening pull request');
  const gh = ['gh', 'pr', 'create', '--head', branch, '--base', base];
  if (typeof a.flags.repo === 'string') gh.push('--repo', a.flags.repo);
  if (typeof a.flags.title === 'string') gh.push('--title', a.flags.title, '--body', typeof a.flags.body === 'string' ? a.flags.body : '');
  else gh.push('--fill');
  if (a.flags.draft) gh.push('--draft');
  if (a.flags.web) gh.push('--web');
  if (await run(gh, { cwd: path }) !== 0)
    die(`gh pr create failed — a PR may already exist, or the base repo needs selecting. Retry with ${pc.cyan('pnpm worktree pr ' + name + ' --web')}`);
  ok(`PR opened for ${pc.bold(branch)}.`);
}

let a = parseArgs(process.argv.slice(2));
const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
try {
  if (tty && a.cmd === 'help' && !a.flags.help && process.argv.length <= 2) {
    clack.intro(pc.bgCyan(pc.black(' pnpm worktree ')));
    const r = await menu();
    if (!r) process.exit(0);
    a = r;
  } else if (tty && (a.cmd === 'create' || a.cmd === 'new') && !a.name) {
    clack.intro(pc.bgCyan(pc.black(' pnpm worktree · create ')));
    const r = await promptCreate();
    if (!r) process.exit(0);
    a = r;
  } else if (tty && ['start', 'stop', 'nuke', 'rm', 'status', 'pr'].includes(a.cmd) && !a.name) {
    clack.intro(pc.bgCyan(pc.black(` pnpm worktree · ${a.cmd} `)));
    const n = await pickWorktree(a.cmd);
    if (!n) process.exit(0);
    a.name = n;
    if (a.cmd === 'start' && !a.flags.stripe && await confirmStripe()) a.flags.stripe = true;
  }

  switch (a.cmd) {
    case 'create': case 'new': await cmdCreate(a); break;
    case 'start': await cmdStart(a); break;
    case 'stop': await cmdStop(a); break;
    case 'nuke': case 'rm': await cmdNuke(a); break;
    case 'list': case 'ls': cmdList(); break;
    case 'status': cmdStatus(a); break;
    case 'pr': await cmdPr(a); break;
    case 'doctor': await cmdDoctor(a); break;
    default: usage();
  }
} catch (e: any) {
  console.error(`\n${pc.red('✗')} ${e?.message ?? e}`);
  process.exit(1);
}
