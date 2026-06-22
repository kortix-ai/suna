import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, sh, which } from './exec';
import { repoRoot } from './git';

export interface Dep { name: string; bin: string; check: () => boolean; installMac: string; installLinux: string; needed: 'always' | 'tunnel'; }

const isMac = process.platform === 'darwin';

function repoRootSafe(): string { try { return repoRoot(); } catch { return process.cwd(); } }

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
  { name: 'psql', bin: 'psql', check: () => !!which('psql'), needed: 'always',
    installMac: 'brew install libpq && brew link --force libpq', installLinux: 'sudo apt-get install -y postgresql-client' },
  { name: 'dotenvx', bin: 'dotenvx', needed: 'always',
    check: () => existsSync(join(repoRootSafe(), 'node_modules/.bin/dotenvx')) || !!which('dotenvx'),
    installMac: '(installed by root `pnpm install`)', installLinux: '(installed by root `pnpm install`)' },
  { name: 'docker', bin: 'docker', needed: 'always',
    check: () => sh(['docker', 'info']).ok,
    installMac: 'start Docker Desktop (or `colima start`)', installLinux: 'sudo systemctl start docker' },
  { name: 'cloudflared', bin: 'cloudflared', check: () => !!which('cloudflared'), needed: 'tunnel',
    installMac: 'brew install cloudflared', installLinux: 'see https://github.com/cloudflare/cloudflared/releases' },
];

export interface DepStatus { dep: Dep; ok: boolean; }
export function checkDeps(opts: { tunnel?: boolean } = {}): DepStatus[] {
  return DEPS.filter((d) => d.needed === 'always' || (d.needed === 'tunnel' && opts.tunnel))
    .map((d) => ({ dep: d, ok: d.check() }));
}

export async function ensureDeps(opts: { tunnel?: boolean; install?: boolean } = {}): Promise<boolean> {
  let allOk = true;
  for (const { dep, ok } of checkDeps(opts)) {
    if (ok) { console.log(`  ✓ ${dep.name}`); continue; }
    const optional = dep.needed === 'tunnel';
    const fail = () => { if (!optional) allOk = false; };
    console.log(`  ${optional ? '!' : '✗'} ${dep.name} — missing${optional ? ' (optional — cloud sandboxes only)' : ''}`);
    const cmd = isMac ? dep.installMac : dep.installLinux;
    if (dep.name === 'docker') { console.log(`      Docker daemon not reachable. Fix: ${cmd}`); allOk = false; continue; }
    if (dep.installMac.startsWith('(')) { console.log(`      ${cmd}`); fail(); continue; }
    if (!opts.install) { console.log(`      install with: ${cmd}`); fail(); continue; }
    console.log(`      installing: ${cmd}`);
    const code = await run(['bash', '-lc', cmd]);
    if (code !== 0 || !dep.check()) { console.log(`      ✗ install failed for ${dep.name}`); fail(); }
    else console.log(`      ✓ ${dep.name} installed`);
  }
  return allOk;
}
