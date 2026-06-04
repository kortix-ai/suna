/**
 * pnpm worktree — core library
 *
 * Isolated, multi-instance dev worktrees. Each worktree gets a unique slot →
 * a deterministic block of ports for EVERY service (web, api, and the full
 * Supabase set), its own Supabase project (namespaced containers/volumes/
 * networks), its own node_modules + pnpm store, and explicit per-process env —
 * so any number of worktrees run at once without ever colliding, and the
 * primary `pnpm dev` (ports 3000/8008/5432x, project `kortix-local`) is never
 * touched.
 *
 * State lives entirely under $KORTIX_HOME (default ~/.kortix), OUTSIDE any
 * checkout, so the registry is shared across all worktrees and nothing dirties
 * a tracked tree. The only in-worktree artifact is the gitignored
 * `.kortix-worktree.json` marker.
 */
import { spawnSync, spawn } from 'bun';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  openSync, closeSync, statSync, symlinkSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

export const STRIDE = 100;
export const BASE = {
  web: 13000, api: 13008,
  sbApi: 13321, sbDb: 13322, sbStudio: 13323, sbInbucket: 13324,
  sbAnalytics: 13327, sbPooler: 13329,
} as const;
export type PortName = keyof typeof BASE;
export type Ports = Record<PortName, number>;

export function computePorts(slot: number): Ports {
  const out = {} as Ports;
  for (const k of Object.keys(BASE) as PortName[]) out[k] = BASE[k] + slot * STRIDE;
  return out;
}

export const KORTIX_HOME = process.env.KORTIX_HOME || join(homedir(), '.kortix');
export const WT_HOME = join(KORTIX_HOME, 'worktrees');
export const REGISTRY_PATH = join(WT_HOME, 'registry.json');
const LOCK_PATH = join(WT_HOME, 'registry.lock');

export interface SlotEntry {
  slot: number;
  projectId: string;
  path: string;
  branch: string;
  ports: Ports;
  createdAt: string;
  status: 'created' | 'running' | 'stopped';
}
export interface Registry {
  version: number;
  slots: Record<string, SlotEntry>;
}

function ensureHome() {
  if (!existsSync(WT_HOME)) mkdirSync(WT_HOME, { recursive: true, mode: 0o700 });
}

export function loadRegistry(): Registry {
  ensureHome();
  if (!existsSync(REGISTRY_PATH)) return { version: 1, slots: {} };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    throw new Error(`registry.json is corrupt: ${REGISTRY_PATH}`);
  }
}

export function saveRegistry(reg: Registry) {
  ensureHome();
  const tmp = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, REGISTRY_PATH); // atomic
}

export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  ensureHome();
  for (let i = 0; i < 120; i++) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      try { return await fn(); } finally { try { rmSync(LOCK_PATH); } catch {} }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > 60_000) { rmSync(LOCK_PATH); continue; }
      } catch {}
      await Bun.sleep(250);
    }
  }
  throw new Error(`could not acquire registry lock (${LOCK_PATH}); remove it if stale`);
}

export function sanitizeName(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s) throw new Error(`invalid worktree name: "${name}"`);
  return s.slice(0, 40);
}

export function lowestFreeSlot(reg: Registry): number {
  const used = new Set(Object.values(reg.slots).map((s) => s.slot));
  let n = 0; while (used.has(n)) n++;
  return n;
}

export interface ShResult { code: number; stdout: string; stderr: string; ok: boolean; }

export function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): ShResult {
  const r = spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe', stderr: 'pipe',
  });
  return {
    code: r.exitCode,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    ok: r.exitCode === 0,
  };
}

export async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<number> {
  const p = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
  });
  return await p.exited;
}

export function which(bin: string): string | null {
  const r = sh(['bash', '-lc', `command -v ${bin} || true`]);
  const out = r.stdout.trim();
  return out || null;
}

export function portInUse(port: number): { inUse: boolean; pid?: string; cmd?: string } {
  const r = sh(['bash', '-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpcn 2>/dev/null || true`]);
  if (!r.stdout.trim()) return { inUse: false };
  const pid = r.stdout.match(/^p(\d+)/m)?.[1];
  const cmd = r.stdout.match(/^c(.+)$/m)?.[1];
  return { inUse: true, pid, cmd };
}

export function repoRoot(): string {
  const r = sh(['git', 'rev-parse', '--show-toplevel']);
  if (!r.ok) throw new Error('not inside a git repository');
  return r.stdout.trim();
}
export function defaultWorktreePath(root: string, name: string): string {
  return join(dirname(root), `suna-${name}`);
}
export function branchExists(root: string, branch: string): boolean {
  return sh(['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export function slotDir(name: string): string { return join(WT_HOME, name); }
export function supaWorkdir(name: string): string { return join(slotDir(name), 'sb'); }
export function pnpmStore(name: string): string { return join(slotDir(name), 'pnpm-store'); }

export function renderSupabaseProject(name: string, worktreePath: string, projectId: string, ports: Ports) {
  const wd = supaWorkdir(name);
  const sbDir = join(wd, 'supabase');
  mkdirSync(sbDir, { recursive: true });

  const srcToml = readFileSync(join(worktreePath, 'supabase', 'config.toml'), 'utf8');
  const rewritten = rewriteConfigToml(srcToml, projectId, ports);
  writeFileSync(join(sbDir, 'config.toml'), rewritten);

  for (const sub of ['migrations', 'seed.sql', 'functions']) {
    const target = join(worktreePath, 'supabase', sub);
    const link = join(sbDir, sub);
    if (existsSync(target) && !existsSync(link)) {
      try { symlinkSync(target, link); } catch {}
    }
  }
  return wd;
}

export function rewriteConfigToml(toml: string, projectId: string, ports: Ports): string {
  const sectionPort: Record<string, number> = {
    '[api]': ports.sbApi, '[db]': ports.sbDb, '[db.pooler]': ports.sbPooler,
    '[studio]': ports.sbStudio, '[inbucket]': ports.sbInbucket, '[analytics]': ports.sbAnalytics,
  };
  const lines = toml.split('\n');
  let section = '';
  const out = lines.map((line) => {
    const secMatch = line.match(/^\s*(\[[^\]]+\])\s*$/);
    if (secMatch) { section = secMatch[1]; return line; }
    if (/^\s*project_id\s*=/.test(line)) return `project_id = "${projectId}"`;
    if (/^\s*port\s*=/.test(line) && section in sectionPort) {
      return line.replace(/port\s*=\s*\d+/, `port = ${sectionPort[section]}`);
    }
    return line.replace(/127\.0\.0\.1:54321/g, `127.0.0.1:${ports.sbApi}`)
               .replace(/localhost:54321/g, `localhost:${ports.sbApi}`)
               .replace(/127\.0\.0\.1:3000/g, `127.0.0.1:${ports.web}`)
               .replace(/localhost:3000/g, `localhost:${ports.web}`);
  });
  return out.join('\n');
}

export function supa(name: string, args: string[], opts: { stream?: boolean } = {}): ShResult | Promise<number> {
  const cmd = ['supabase', '--workdir', supaWorkdir(name), ...args];
  return opts.stream ? run(cmd) : sh(cmd);
}

export function supaStatusEnv(name: string): Record<string, string> {
  const r = sh(['supabase', '--workdir', supaWorkdir(name), 'status', '-o', 'env']);
  if (!r.ok) return {};
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export interface SlotCreds { dbUrl: string; supabaseUrl: string; serviceRoleKey: string; anonKey: string; }

export function slotCredsFromStatus(ports: Ports, st: Record<string, string>): SlotCreds {
  return {
    dbUrl: st.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${ports.sbDb}/postgres`,
    supabaseUrl: st.API_URL || `http://127.0.0.1:${ports.sbApi}`,
    serviceRoleKey: st.SERVICE_ROLE_KEY || '',
    anonKey: st.ANON_KEY || '',
  };
}

export function apiLaunchEnv(ports: Ports, c: SlotCreds): Record<string, string> {
  return {
    ENV_MODE: 'local', KORTIX_LOCAL_DEV: '1',
    PORT: String(ports.api),
    KORTIX_URL: `http://localhost:${ports.api}`,
    NEXT_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    KORTIX_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    BACKEND_URL: `http://localhost:${ports.api}/v1`,
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    KORTIX_SKIP_ENSURE_SCHEMA: '1',
    DATABASE_URL: c.dbUrl,
    SUPABASE_URL: c.supabaseUrl,
    ...(c.serviceRoleKey ? { SUPABASE_SERVICE_ROLE_KEY: c.serviceRoleKey } : {}),
    SCHEDULER_ENABLED: 'false',
    KORTIX_BILLING_INTERNAL_ENABLED: 'false',
  };
}

export function webLaunchEnv(ports: Ports, c: SlotCreds): Record<string, string> {
  return {
    WEB_PORT: String(ports.web),
    KORTIX_API_PROXY_TARGET: `http://localhost:${ports.api}`,
    NEXT_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    BACKEND_URL: `http://localhost:${ports.api}/v1`,
    NEXT_PUBLIC_SUPABASE_URL: c.supabaseUrl,
    ...(c.anonKey ? { NEXT_PUBLIC_SUPABASE_ANON_KEY: c.anonKey } : {}),
    NEXT_PUBLIC_APP_URL: `http://localhost:${ports.web}`,
    NEXT_PUBLIC_URL: `http://localhost:${ports.web}`,
    NEXT_PUBLIC_BILLING_ENABLED: 'false',
  };
}

export function writeMarker(worktreePath: string, entry: SlotEntry) {
  writeFileSync(join(worktreePath, '.kortix-worktree.json'), JSON.stringify(entry, null, 2));
}

export interface Dep { name: string; bin: string; check: () => boolean; installMac: string; installLinux: string; needed: 'always' | 'tunnel'; }

const isMac = process.platform === 'darwin';

export const DEPS: Dep[] = [
  { name: 'bun', bin: 'bun', check: () => !!which('bun'), needed: 'always',
    installMac: 'brew install oven-sh/bun/bun', installLinux: 'curl -fsSL https://bun.sh/install | bash' },
  { name: 'node>=22', bin: 'node', needed: 'always',
    check: () => { const v = sh(['node', '-v']).stdout.match(/v(\d+)/)?.[1]; return !!v && Number(v) >= 22; },
    installMac: 'brew install node@22', installLinux: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs' },
  { name: 'pnpm', bin: 'pnpm', check: () => !!which('pnpm'), needed: 'always',
    installMac: 'corepack enable && corepack install', installLinux: 'corepack enable && corepack install' },
  { name: 'supabase', bin: 'supabase', check: () => !!which('supabase'), needed: 'always',
    installMac: 'brew install supabase/tap/supabase', installLinux: 'see https://supabase.com/docs/guides/cli (brew or release tarball)' },
  { name: 'dotenvx', bin: 'dotenvx', needed: 'always',
    check: () => existsSync(join(repoRootSafe(), 'node_modules/.bin/dotenvx')) || !!which('dotenvx'),
    installMac: '(installed by root `pnpm install`)', installLinux: '(installed by root `pnpm install`)' },
  { name: 'docker', bin: 'docker', needed: 'always',
    check: () => sh(['docker', 'info']).ok,
    installMac: 'start Docker Desktop (or `colima start`)', installLinux: 'sudo systemctl start docker' },
  { name: 'cloudflared', bin: 'cloudflared', check: () => !!which('cloudflared'), needed: 'tunnel',
    installMac: 'brew install cloudflared', installLinux: 'see https://github.com/cloudflare/cloudflared/releases' },
];

function repoRootSafe(): string { try { return repoRoot(); } catch { return process.cwd(); } }

export interface DepStatus { dep: Dep; ok: boolean; }
export function checkDeps(opts: { tunnel?: boolean } = {}): DepStatus[] {
  return DEPS.filter((d) => d.needed === 'always' || (d.needed === 'tunnel' && opts.tunnel))
    .map((d) => ({ dep: d, ok: d.check() }));
}

export async function ensureDeps(opts: { tunnel?: boolean; install?: boolean } = {}): Promise<boolean> {
  let allOk = true;
  for (const { dep, ok } of checkDeps(opts)) {
    if (ok) { console.log(`  ✓ ${dep.name}`); continue; }
    console.log(`  ✗ ${dep.name} — missing`);
    const cmd = isMac ? dep.installMac : dep.installLinux;
    if (dep.name === 'docker') { console.log(`      Docker daemon not reachable. Fix: ${cmd}`); allOk = false; continue; }
    if (dep.installMac.startsWith('(')) { console.log(`      ${cmd}`); allOk = false; continue; }
    if (!opts.install) { console.log(`      install with: ${cmd}`); allOk = false; continue; }
    console.log(`      installing: ${cmd}`);
    const code = await run(['bash', '-lc', cmd]);
    if (code !== 0 || !dep.check()) { console.log(`      ✗ install failed for ${dep.name}`); allOk = false; }
    else console.log(`      ✓ ${dep.name} installed`);
  }
  return allOk;
}
