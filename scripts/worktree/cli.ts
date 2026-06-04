#!/usr/bin/env bun
/**
 * pnpm worktree — isolated multi-instance dev worktrees.
 *
 *   pnpm worktree create --name <feat> [--branch b] [--from main] [--no-start] [--yes]
 *   pnpm worktree new <feat>                 # alias of create (positional name)
 *   pnpm worktree start  <feat>
 *   pnpm worktree stop   <feat>
 *   pnpm worktree nuke   <feat>              # alias: rm  (tears down everything)
 *   pnpm worktree list
 *   pnpm worktree status [feat]
 *   pnpm worktree doctor
 *
 * One command from a fresh clone sets up EVERYTHING (deps, git worktree, unique
 * ports, isolated Supabase, install) and boots the stack. Many worktrees run at
 * once with zero collisions; the primary `pnpm dev` is never touched. See lib.ts.
 */
import {
  STRIDE, BASE, computePorts, loadRegistry, saveRegistry, withLock, sanitizeName,
  lowestFreeSlot, sh, run, which, portInUse, repoRoot, defaultWorktreePath, branchExists,
  renderSupabaseProject, runMigrate, supa, supaStatusEnv, slotCredsFromStatus, apiLaunchEnv, webLaunchEnv,
  writeMarker, ensureDeps, checkDeps, pnpmStore, supaWorkdir, slotDir, WT_HOME, REGISTRY_PATH,
  type Registry, type SlotEntry, type Ports,
} from './lib';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const API_FILTER = 'kortix-api';
const WEB_FILTER = 'Kortix-Computer-Frontend';

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
  console.log(`pnpm worktree — isolated multi-instance dev worktrees

  create --name <n> [--branch b] [--from main] [--no-start] [--yes]   set up + boot a worktree
  new <n>                                                             alias of create
  start <n>                                                           boot an existing worktree
  stop <n>                                                            stop services (keeps data)
  nuke <n> [--force]                                                  tear down everything, free the slot
  list                                                               all worktrees + ports
  status [n]                                                         live health of services
  doctor [--yes]                                                     check/install the toolchain

Each worktree gets a unique port block (base ${BASE.web}/${BASE.api}, +${STRIDE} per slot),
its own Supabase project (namespaced containers/volumes), and its own node_modules.
State lives in ${WT_HOME}. The primary 'pnpm dev' (3000/8008) is never touched.`);
  process.exit(2);
}

function need(name: string | undefined): string {
  if (!name) { console.error('error: a worktree <name> is required'); process.exit(2); }
  return sanitizeName(name);
}

function portsLine(p: Ports): string {
  return `web ${p.web} · api ${p.api} · db ${p.sbDb} · studio ${p.sbStudio} · inbucket ${p.sbInbucket}`;
}

async function cmdCreate(a: Args) {
  const name = need(a.name);
  const tunnel = !!a.flags.tunnel;
  const install = !!a.flags.yes;

  console.log(`\n▸ Preflight: toolchain`);
  if (!(await ensureDeps({ tunnel, install }))) {
    console.error(`\n✗ Missing dependencies above. Re-run with --yes to auto-install, or install them and retry.`);
    process.exit(1);
  }

  const root = repoRoot();
  const wtPath = defaultWorktreePath(root, name);
  const branch = (typeof a.flags.branch === 'string' && a.flags.branch) || name;
  const from = (typeof a.flags.from === 'string' && a.flags.from) || 'HEAD';

  const entry = await withLock<SlotEntry>(() => {
    const reg = loadRegistry();
    if (reg.slots[name]) { console.log(`▸ Resuming existing worktree "${name}" (slot ${reg.slots[name].slot})`); return reg.slots[name]; }
    let slot = lowestFreeSlot(reg);
    for (let tries = 0; tries < 6; tries++) {
      const ports = computePorts(slot);
      const clash = (Object.entries(ports) as [string, number][]).map(([k, p]) => ({ k, p, ...portInUse(p) })).find((x) => x.inUse);
      if (!clash) break;
      console.log(`  port ${clash.p} (${clash.k}) in use by ${clash.cmd ?? '?'} (pid ${clash.pid ?? '?'}) — trying next slot`);
      slot++;
      if (tries === 5) { console.error('✗ could not find a free port block after 6 slots'); process.exit(1); }
    }
    const ports = computePorts(slot);
    const e: SlotEntry = {
      slot, projectId: `kortix-wt-${name}`, path: wtPath, branch, ports,
      createdAt: new Date().toISOString(),
      status: 'created',
    };
    reg.slots[name] = e; saveRegistry(reg);
    return e;
  });

  console.log(`\n▸ Slot ${entry.slot} — ${portsLine(entry.ports)}`);

  console.log(`\n▸ Git worktree → ${wtPath}`);
  const existing = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  if (existing.includes(`worktree ${wtPath}`)) {
    console.log(`  already exists — reusing`);
  } else if (branchExists(root, branch)) {
    const r = sh(['git', '-C', root, 'worktree', 'add', wtPath, branch]);
    if (!r.ok) { console.error(`✗ git worktree add failed: ${r.stderr}`); process.exit(1); }
  } else {
    const r = sh(['git', '-C', root, 'worktree', 'add', '-b', branch, wtPath, from]);
    if (!r.ok) { console.error(`✗ git worktree add -b failed: ${r.stderr}`); process.exit(1); }
  }

  console.log(`\n▸ Rendering isolated Supabase project (id ${entry.projectId})`);
  renderSupabaseProject(name, wtPath, entry.projectId, entry.ports);

  console.log(`\n▸ Installing dependencies (own pnpm store)`);
  const inst = await run(['pnpm', 'install', '--store-dir', pnpmStore(name)], { cwd: wtPath });
  if (inst !== 0) { console.error(`✗ pnpm install failed — fix and re-run 'pnpm worktree create --name ${name}'`); process.exit(1); }

  console.log(`\n▸ Starting isolated Supabase on db ${entry.ports.sbDb} / api ${entry.ports.sbApi}`);
  const upCode = await (supa(name, ['start'], { stream: true }) as Promise<number>);
  if (upCode !== 0) { console.error('✗ supabase start failed'); process.exit(1); }
  console.log(`\n▸ Building schema (pnpm db:migrate)`);
  const migCode = await runMigrate(wtPath, entry.ports);
  if (migCode !== 0) { console.error(`✗ db:migrate failed — fix and re-run 'pnpm worktree create --name ${name}'`); process.exit(1); }
  // Verify the schema actually built — a base branch WITHOUT the Drizzle
  // migrations (e.g. an un-migrated `main`) would otherwise leave an empty DB
  // and a silently-broken worktree. Fail loud instead.
  const built = sh(['bash', '-lc', `psql "postgresql://postgres:postgres@127.0.0.1:${entry.ports.sbDb}/postgres" -tAc "select 1 from information_schema.tables where table_schema='kortix' limit 1" 2>/dev/null`]).stdout.trim();
  if (built !== '1') {
    console.error(`\n✗ schema not built — branch "${branch}" has no Drizzle migrations (packages/db/drizzle).`);
    console.error(`  Recreate from a branch that has them: --from migrations/drizzle-rebuild (or merge it into main).`);
    process.exit(1);
  }

  writeMarker(wtPath, entry);
  await withLock(() => { const reg = loadRegistry(); if (reg.slots[name]) { reg.slots[name].status = 'created'; saveRegistry(reg); } });

  console.log(`\n✅ Worktree "${name}" ready.`);
  console.log(`   path:   ${wtPath}`);
  console.log(`   ${portsLine(entry.ports)}`);
  if (a.flags['no-start']) {
    console.log(`\n   start it:  pnpm worktree start ${name}`);
  } else {
    await cmdStart({ cmd: 'start', name, flags: {} });
  }
}

async function cmdStart(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const entry = reg.slots[name];
  if (!entry) { console.error(`✗ unknown worktree "${name}" — create it first`); process.exit(1); }
  if (!existsSync(entry.path)) { console.error(`✗ worktree dir missing (${entry.path}); run 'pnpm worktree nuke ${name}' then recreate`); process.exit(1); }
  if (!sh(['docker', 'info']).ok) { console.error('✗ Docker daemon not running — start Docker and retry'); process.exit(1); }

  renderSupabaseProject(name, entry.path, entry.projectId, entry.ports);

  const st0 = sh(['supabase', '--workdir', supaWorkdir(name), 'status']);
  if (!st0.ok) {
    console.log(`▸ Starting Supabase for "${name}"…`);
    await (supa(name, ['start'], { stream: true }) as Promise<number>);
  }
  console.log(`▸ Applying pending migrations (pnpm db:migrate)`);
  await runMigrate(entry.path, entry.ports);
  const creds = slotCredsFromStatus(entry.ports, supaStatusEnv(name));

  for (const p of [entry.ports.web, entry.ports.api]) {
    const u = portInUse(p);
    if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]);
  }

  await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'running'; saveRegistry(r); } });

  console.log(`\n🚀 "${name}"  web http://localhost:${entry.ports.web}  ·  api http://localhost:${entry.ports.api}  ·  studio http://localhost:${entry.ports.sbStudio}\n`);

  const api = Bun.spawn(['pnpm', '--filter', API_FILTER, 'dev'], {
    cwd: entry.path, env: { ...process.env, ...apiLaunchEnv(entry.ports, creds) },
    stdout: 'inherit', stderr: 'inherit',
  });
  const web = Bun.spawn(['pnpm', '--filter', WEB_FILTER, 'dev'], {
    cwd: entry.path, env: { ...process.env, ...webLaunchEnv(entry.ports, creds) },
    stdout: 'inherit', stderr: 'inherit',
  });
  // Graceful shutdown: signal the wrappers AND the real port listeners (pnpm →
  // bun → next, so killing the wrapper alone orphans the server), then WAIT for
  // them to exit before returning — otherwise Ctrl+C drops you back to the prompt
  // while the servers are still closing (the "hang"), and can leave ports held.
  const killListeners = (sig: string) => {
    for (const p of [entry.ports.web, entry.ports.api]) {
      const u = portInUse(p);
      if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${sig} ${u.pid} 2>/dev/null || true`]);
    }
  };
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    console.log('\n▸ stopping…');
    try { api.kill(); } catch {} try { web.kill(); } catch {}
    killListeners('');                                   // SIGTERM the listeners
    await Promise.race([Promise.all([api.exited, web.exited]), Bun.sleep(6000)]);
    killListeners('-9');                                 // force anything still bound
    await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'stopped'; saveRegistry(r); } });
    console.log('✓ stopped.');
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await Promise.race([api.exited, web.exited]);          // a server died on its own
  await shutdown();
}

async function cmdStop(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const entry = reg.slots[name];
  if (!entry) { console.error(`✗ unknown worktree "${name}"`); process.exit(1); }
  console.log(`▸ Stopping "${name}"…`);
  for (const p of [entry.ports.web, entry.ports.api]) {
    const u = portInUse(p);
    if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]);
  }
  sh(['supabase', '--workdir', supaWorkdir(name), 'stop']);
  await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'stopped'; saveRegistry(r); } });
  console.log(`✓ stopped (data preserved). Restart with 'pnpm worktree start ${name}'.`);
}

async function cmdNuke(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const entry = reg.slots[name];
  if (!entry) { console.error(`✗ unknown worktree "${name}"`); process.exit(1); }
  const pid = entry.projectId;
  console.log(`▸ Nuking "${name}" (project ${pid})…`);
  for (const p of [entry.ports.web, entry.ports.api]) {
    const u = portInUse(p); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]);
  }
  sh(['supabase', '--workdir', supaWorkdir(name), 'stop', '--no-backup']);
  sh(['bash', '-lc', `docker rm -f $(docker ps -aq --filter "name=_${pid}$") 2>/dev/null || true`]);
  sh(['bash', '-lc', `docker volume rm $(docker volume ls -q --filter "name=_${pid}$") 2>/dev/null || true`]);
  sh(['bash', '-lc', `docker network rm supabase_network_${pid} 2>/dev/null || true`]);
  const root = repoRoot();
  const force = a.flags.force ? ['--force'] : [];
  if (existsSync(entry.path)) sh(['git', '-C', root, 'worktree', 'remove', ...force, entry.path]);
  sh(['git', '-C', root, 'worktree', 'prune']);
  if (entry.branch) {
    const del = sh(['git', '-C', root, 'branch', '-d', entry.branch]);
    if (del.ok) console.log(`  deleted branch "${entry.branch}"`);
    else if (a.flags.force) { sh(['git', '-C', root, 'branch', '-D', entry.branch]); console.log(`  force-deleted branch "${entry.branch}" (had unmerged commits)`); }
    else console.log(`  kept branch "${entry.branch}" (unmerged commits) — \`git branch -D ${entry.branch}\` or \`nuke --force\` to drop it`);
  }
  try { rmSync(slotDir(name), { recursive: true, force: true }); } catch {}
  await withLock(() => { const r = loadRegistry(); delete r.slots[name]; saveRegistry(r); });
  console.log(`✓ removed "${name}" — slot ${entry.slot} freed.`);
}

function cmdList() {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { console.log('No worktrees. Create one: pnpm worktree create --name <feat>'); return; }
  console.log(`NAME                 SLOT  STATUS    BRANCH               WEB    API    DB     STUDIO`);
  for (const n of names.sort((a, b) => reg.slots[a].slot - reg.slots[b].slot)) {
    const e = reg.slots[n];
    console.log(
      `${n.padEnd(20)} ${String(e.slot).padEnd(5)} ${(e.status).padEnd(9)} ${e.branch.slice(0, 20).padEnd(20)} ` +
      `${String(e.ports.web).padEnd(6)} ${String(e.ports.api).padEnd(6)} ${String(e.ports.sbDb).padEnd(6)} ${e.ports.sbStudio}`,
    );
  }
}

function probe(port: number): string { return portInUse(port).inUse ? '🟢' : '⚪'; }
function cmdStatus(a: Args) {
  const reg = loadRegistry();
  const names = a.name ? [sanitizeName(a.name)] : Object.keys(reg.slots);
  if (!names.length) { console.log('No worktrees.'); return; }
  for (const n of names) {
    const e = reg.slots[n];
    if (!e) { console.log(`${n}: unknown`); continue; }
    const sb = sh(['supabase', '--workdir', supaWorkdir(n), 'status']).ok ? '🟢' : '⚪';
    console.log(`\n${n}  (slot ${e.slot}, ${e.status})  ${e.path}`);
    console.log(`  web    ${probe(e.ports.web)} :${e.ports.web}   api ${probe(e.ports.api)} :${e.ports.api}`);
    console.log(`  supa   ${sb}   db :${e.ports.sbDb}  studio :${e.ports.sbStudio}  inbucket :${e.ports.sbInbucket}`);
  }
}

async function cmdDoctor(a: Args) {
  console.log('▸ Toolchain:');
  await ensureDeps({ tunnel: false, install: !!a.flags.yes });
  console.log('\n▸ Worktree integrity:');
  const reg = loadRegistry();
  const root = repoRoot();
  const wts = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  for (const [n, e] of Object.entries(reg.slots)) {
    const issues: string[] = [];
    if (!existsSync(e.path)) issues.push('worktree dir missing');
    else if (!wts.includes(`worktree ${e.path}`)) issues.push('not a registered git worktree');
    const orphan = sh(['bash', '-lc', `docker ps -aq --filter "name=_${e.projectId}$" | head -1`]).stdout.trim();
    console.log(`  ${n}: ${issues.length ? '✗ ' + issues.join('; ') : '✓ ok'}${orphan ? ' (containers present)' : ''}`);
  }
  console.log(`\n  registry: ${REGISTRY_PATH}`);
}

const a = parseArgs(process.argv.slice(2));
try {
  switch (a.cmd) {
    case 'create': case 'new': await cmdCreate(a); break;
    case 'start': await cmdStart(a); break;
    case 'stop': await cmdStop(a); break;
    case 'nuke': case 'rm': await cmdNuke(a); break;
    case 'list': case 'ls': cmdList(); break;
    case 'status': cmdStatus(a); break;
    case 'doctor': await cmdDoctor(a); break;
    default: usage();
  }
} catch (e: any) {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
}
