import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Ports } from './ports';
import { portInUse, run, sh, type ShResult } from './exec';
import { supaWorkdir } from './registry';

export const SHARED_SUPABASE_PORTS = {
  sbApi: 54321,
  sbDb: 54322,
  sbStudio: 54323,
  sbInbucket: 54324,
} as const;

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

export function renderSupabaseProject(name: string, worktreePath: string, projectId: string, ports: Ports) {
  const wd = supaWorkdir(name);
  const sbDir = join(wd, 'supabase');
  mkdirSync(sbDir, { recursive: true });

  const srcToml = readFileSync(join(worktreePath, 'supabase', 'config.toml'), 'utf8');
  const rewritten = rewriteConfigToml(srcToml, projectId, ports);
  writeFileSync(join(sbDir, 'config.toml'), rewritten);

  for (const sub of ['seed.sql', 'functions']) {
    const target = join(worktreePath, 'supabase', sub);
    const link = join(sbDir, sub);
    if (existsSync(target) && !existsSync(link)) {
      try { symlinkSync(target, link); } catch {}
    }
  }
  return wd;
}

export async function startSupabaseDb(name: string): Promise<number> {
  return run(['supabase', '--workdir', supaWorkdir(name), 'db', 'start']);
}

export async function startSupabaseFullStack(name: string, ports: Ports): Promise<number> {
  if (!portInUse(ports.sbApi).inUse) {
    await run(['supabase', '--workdir', supaWorkdir(name), 'stop']);
  }
  return run(['supabase', '--workdir', supaWorkdir(name), 'start']);
}

export function hasKortixSchema(ports: Ports): boolean {
  const sql = "select 1 from information_schema.tables where table_schema='kortix' limit 1";
  return sh([
    'bash',
    '-lc',
    `psql "postgresql://postgres:postgres@127.0.0.1:${ports.sbDb}/postgres" -tAc ${JSON.stringify(sql)} 2>/dev/null`,
  ]).stdout.trim() === '1';
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

export function primarySupabaseStatusEnv(root: string): Record<string, string> {
  const r = sh(['supabase', 'status', '-o', 'env'], { cwd: root });
  if (!r.ok) return {};
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export async function ensurePrimarySupabase(root: string): Promise<Record<string, string>> {
  let env = primarySupabaseStatusEnv(root);
  if (env.API_URL && env.DB_URL && env.SERVICE_ROLE_KEY && env.ANON_KEY) return env;
  const started = await run(['supabase', 'start'], { cwd: root });
  if (started !== 0) return {};
  env = primarySupabaseStatusEnv(root);
  return env;
}

export function primaryCredsFromStatus(st: Record<string, string>): SlotCreds {
  return {
    dbUrl: st.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${SHARED_SUPABASE_PORTS.sbDb}/postgres`,
    supabaseUrl: st.API_URL || `http://127.0.0.1:${SHARED_SUPABASE_PORTS.sbApi}`,
    serviceRoleKey: st.SERVICE_ROLE_KEY || '',
    anonKey: st.ANON_KEY || '',
  };
}
