import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// kortixd (apps/kortix-sandbox-agent-server) is a standalone binary. A value it
// shares with another package lives in packages/api-contract (or, for message
// ids, the SDK's import-free codec), and both sides import it. A test that
// imports or reads the daemon's source from outside, or a daemon file that
// imports another app, couples two packages through a file path: a daemon file
// move then breaks apps/api, and apps/api typechecks daemon code (which pinned
// `@types/node` for the whole repo until R3.6).
//
// Not covered on purpose: apps/api code that hashes or builds the daemon tree
// (snapshots/, git-proxy/compiled-agent-bundle.ts) and Dockerfile reads. Those
// treat the daemon as a build input, not as code.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DAEMON = 'apps/kortix-sandbox-agent-server';
const DAEMON_SRC = `${DAEMON}/src`;

/** Each entry is `<file> -> <target>` with the reason it stays. Remove it with the reason. */
const ALLOWED: Record<string, string> = {
  // apps/kortix-worker is workspace-excluded and has no test lane. This is the
  // only proof that its env-rpc client speaks the daemon's user-context codec.
  // It goes away with apps/kortix-worker (refactor plan R6.6).
  [`${DAEMON}/src/__tests__/env-rpc-worker-integration.test.ts -> apps/kortix-worker/src/lazy-env.ts`]:
    'kortix-worker has no test lane of its own',
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /(?:\.test\.[cm]?[jt]sx?$|\/__tests__\/)/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`]([^'"`]+)['"`]/gm;
const LITERAL = /['"`]([^'"`\n]+)['"`]/g;

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => SOURCE.test(file) && !file.includes('node_modules/'));
}

/** The file text without whole-line comments, which may cite a path freely. */
function code(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** A relative specifier resolved to a repo-relative path, or null. */
function resolveRelative(file: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  return relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), specifier));
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function violations(): string[] {
  const found = new Set<string>();
  for (const file of trackedSources()) {
    // The daemon's own scripts/ hold lint fixtures, not code that ships.
    if (inside(file, DAEMON) && !inside(file, DAEMON_SRC)) continue;
    const text = code(file);
    const fromDaemon = inside(file, DAEMON_SRC);
    if (!fromDaemon && !text.includes('kortix-sandbox-agent-server')) continue;

    for (const [, specifier] of text.matchAll(IMPORT)) {
      const target = resolveRelative(file, specifier!);
      if (!target) continue;
      if (!fromDaemon && inside(target, DAEMON_SRC)) found.add(`${file} -> ${target}`);
      if (fromDaemon && inside(target, 'apps') && !inside(target, DAEMON)) found.add(`${file} -> ${target}`);
    }

    if (!fromDaemon && !TEST.test(file)) continue;
    for (const [, literal] of text.matchAll(LITERAL)) {
      // A path has no spaces; `COPY apps/… ./apps/…` is a Dockerfile line under test.
      if (/\s/.test(literal!)) continue;
      const target = resolveRelative(file, literal!);
      if (fromDaemon) {
        if (target && /^apps\/[^/]+\/src(?:\/|$)/.test(target) && !inside(target, DAEMON)) found.add(`${file} -> ${target}`);
      } else if (literal!.includes(DAEMON_SRC) || (target && inside(target, DAEMON_SRC))) {
        found.add(`${file} -> ${target ?? literal}`);
      }
    }
    // `resolve(root, 'kortix-sandbox-agent-server', 'src', …)` spells the path in segments.
    if (!fromDaemon && /['"`]kortix-sandbox-agent-server['"`]\s*,\s*['"`]src['"`]/.test(text)) {
      found.add(`${file} -> ${DAEMON_SRC} (path segments)`);
    }
  }
  return [...found].filter((entry) => !(entry in ALLOWED)).sort();
}

describe('the kortixd package boundary', () => {
  it('no test outside kortixd reads its source, and kortixd imports no other app', () => {
    expect(violations()).toEqual([]);
  });

  it('every allowed exception still exists', () => {
    for (const entry of Object.keys(ALLOWED)) {
      const [file, target] = entry.split(' -> ');
      expect(code(file!), entry).toContain(relative(dirname(file!), target!).replace(/\.ts$/, ''));
    }
  });
});
