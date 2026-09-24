/**
 * The in-box script, run for real: bash, GNU find, a scratch directory as /tmp.
 * Migration needs root and a loop device, so it is proven on a live Platinum
 * guest (see the PR), not here. Every sandbox image ships GNU findutils; a host
 * without it (macOS) cannot run this file, and says so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTmpMaintenanceScript, type TmpMaintenanceReport } from './tmp-maintenance';

const gnuFind = spawnSync('find', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU findutils') ?? false;
const onLinux = process.platform === 'linux';
const runnable = gnuFind && onLinux;
if (!runnable) console.warn('[tmp-maintenance-script.test] needs Linux with GNU findutils; CI runs it');
const it = runnable ? test : test.skip;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'kx-tmp-maint-'));
  dirs.push(d);
  return d;
}

function write(path: string, bytes: number, ageHours = 0): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  if (ageHours > 0) {
    const t = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(path, t, t);
  }
}

function run(dir: string, mode: 'report' | 'clean'): TmpMaintenanceReport {
  const script = renderTmpMaintenanceScript({ mode, allowMigrate: false, tmpDir: dir });
  const r = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8' });
  expect(r.status).toBe(0);
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(last) as TmpMaintenanceReport;
}

describe('tmp-maintenance.sh', () => {
  it('clean deletes abandoned legacy uploads and nothing else', () => {
    const d = scratch();
    const legacy = join(d, 'kortix-legacy-00000000-0000-4000-8000-000000000001');
    write(join(legacy, 'workspace.tar.gz.transfer-aaaa'), 256 * 1024, 48);
    write(join(legacy, 'workspace.tar.gz.transfer-aaaa.part'), 64 * 1024, 48);
    write(join(legacy, 'workspace.tar.gz.transfer-bbbb'), 64 * 1024); // an upload still running
    write(join(legacy, 'manifest.json'), 100, 48);
    write(join(d, 'venv', 'lib', 'site.py'), 100, 24 * 30); // old mtime, changed today
    const r = run(d, 'clean');
    expect(r).toMatchObject({ ok: true, mode: 'clean', gnu: true, partials: 2, migrated: false, error: '' });
    expect(r.partials_kb).toBeGreaterThanOrEqual(320);
    expect(existsSync(join(legacy, 'workspace.tar.gz.transfer-aaaa'))).toBe(false);
    expect(existsSync(join(legacy, 'workspace.tar.gz.transfer-aaaa.part'))).toBe(false);
    expect(existsSync(join(legacy, 'workspace.tar.gz.transfer-bbbb'))).toBe(true);
    expect(existsSync(join(legacy, 'manifest.json'))).toBe(true);
    // ctime is today: an archive just extracted with its original mtimes stays.
    expect(existsSync(join(d, 'venv', 'lib', 'site.py'))).toBe(true);
    expect(r.aged).toBe(0);
  });

  it('report measures the same uploads and deletes nothing', () => {
    const d = scratch();
    const legacy = join(d, 'kortix-legacy-00000000-0000-4000-8000-000000000002');
    write(join(legacy, 'workspace.tar.gz.transfer-cccc'), 128 * 1024, 48);
    const r = run(d, 'report');
    expect(r).toMatchObject({ ok: true, mode: 'report', partials: 1 });
    expect(r.partials_kb).toBeGreaterThanOrEqual(128);
    expect(existsSync(join(legacy, 'workspace.tar.gz.transfer-cccc'))).toBe(true);
  });

  // A flock-guarded singleton (Platinum's `flock -n /tmp/pt-ka.lock pt-ka`)
  // holds its lock on the exact file; the migration must see every such lock.
  it('tmp_locked names the files under /tmp that a process holds a lock on', () => {
    const d = scratch();
    write(join(d, 'app.lock'), 0);
    write(join(d, 'free.lock'), 0);
    const holder = spawn('flock', ['-n', join(d, 'app.lock'), 'sleep', '30'], { stdio: 'ignore' });
    try {
      spawnSync('sleep', ['0.5']);
      const script = renderTmpMaintenanceScript({ mode: 'report', allowMigrate: false, tmpDir: d });
      const fn = /^tmp_locked\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0] ?? '';
      expect(fn).not.toBe('');
      const r = spawnSync('bash', ['-c', `TMP='${d}'\n${fn}\ntmp_locked`], { encoding: 'utf8' });
      const locked = r.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t')[1]);
      expect(locked).toEqual([join(d, 'app.lock')]);
    } finally {
      holder.kill();
    }
  });

  it('reports the box: memory, shmem, and a /tmp that is not a mount', () => {
    const r = run(scratch(), 'report');
    expect(r.tmp_fs).toBe('dir');
    expect(r.mem_total_kb).toBeGreaterThan(0);
    expect(typeof r.shmem_before_kb).toBe('number');
    expect(r.migrate_blocker).toBe('');
  });
});
