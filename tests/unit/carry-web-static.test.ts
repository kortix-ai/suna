import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// infra/scripts/carry-web-static.sh keeps earlier builds' `_next/static` files
// in a new dev frontend image, so a tab on an earlier build can still load its
// lazy chunks after a deploy (2026-10-30: "Failed to load chunk" crash on dev).

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'infra/scripts/carry-web-static.sh');
const HOUR = 3600;

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One build's static dir: `<id>/_buildManifest.js` plus chunks, all at `builtAt`. */
function writeBuild(dir: string, id: string, chunks: Record<string, string>, builtAt: number) {
  mkdirSync(join(dir, id), { recursive: true });
  mkdirSync(join(dir, 'chunks'), { recursive: true });
  const files = [join(dir, id, '_buildManifest.js')];
  writeFileSync(files[0], id);
  for (const [name, body] of Object.entries(chunks)) {
    const file = join(dir, 'chunks', name);
    writeFileSync(file, body);
    files.push(file);
  }
  for (const file of files) utimesSync(file, builtAt, builtAt);
}

function carry(staticDir: string, keep: number, images: string[]) {
  return execFileSync('bash', [SCRIPT, staticDir, String(keep), ...images], {
    env: { ...process.env, CARRY_WEB_STATIC_FROM_DIR: join(root, 'images') },
    encoding: 'utf8',
  });
}

describe('carry-web-static', () => {
  it('carries the chunks of earlier builds and keeps the new build own files', () => {
    root = mkdtempSync(join(tmpdir(), 'carry-web-static-'));
    const now = Math.floor(Date.now() / 1000);
    writeBuild(join(root, 'images/previous'), 'build-1', { 'old.js': 'old', 'shared.js': 'stale copy' }, now - HOUR);
    const next = join(root, 'next');
    writeBuild(next, 'build-2', { 'new.js': 'new', 'shared.js': 'current' }, now);

    const out = carry(next, 5, ['previous', 'missing']);

    expect(readFileSync(join(next, 'chunks/old.js'), 'utf8')).toBe('old');
    expect(readFileSync(join(next, 'chunks/new.js'), 'utf8')).toBe('new');
    expect(readFileSync(join(next, 'chunks/shared.js'), 'utf8')).toBe('current');
    expect(out).toContain('cannot read missing');
    expect(out).toContain('2 builds');
  });

  it('drops the files of builds older than the newest <keep> builds', () => {
    root = mkdtempSync(join(tmpdir(), 'carry-web-static-'));
    const now = Math.floor(Date.now() / 1000);
    // The previous image already carries builds 1..6, one hour apart.
    const previous = join(root, 'images/previous');
    for (let n = 1; n <= 6; n += 1) {
      writeBuild(previous, `build-${n}`, { [`only-${n}.js`]: String(n) }, now - (7 - n) * HOUR);
    }
    const next = join(root, 'next');
    writeBuild(next, 'build-7', { 'only-7.js': '7' }, now);

    carry(next, 5, ['previous']);

    for (const n of [1, 2]) {
      expect(existsSync(join(next, `chunks/only-${n}.js`))).toBe(false);
      expect(existsSync(join(next, `build-${n}`))).toBe(false);
    }
    for (const n of [3, 4, 5, 6, 7]) {
      expect(existsSync(join(next, `chunks/only-${n}.js`))).toBe(true);
    }
  });
});
