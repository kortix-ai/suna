/**
 * The gitleaks binary that scans every push for committed secrets must be
 * verified before it runs.
 *
 * CWE-494: `secret-scan.yml` and `security-scan.yml` downloaded the gitleaks
 * release archive and executed the extracted binary with no integrity check,
 * while the release publishes `gitleaks_<v>_checksums.txt`. The scanner decides
 * whether a committed secret blocks a release, so its own integrity sits inside
 * the boundary it enforces. The repo already has the pattern in
 * `scripts/install.sh` and `tests/unit/install-sh.test.ts`.
 *
 * The user-data tests drive the REAL `run:` block of each install step as a
 * shell script against a local fixture release, so they assert what CI executes,
 * not the workflow text: a genuine archive installs, and a tampered archive, a
 * checksum-less release and an unlisted archive each fail the job before the
 * binary runs. The fixture archive is a real gzip stream. The fixture binary is
 * a shell script whose `version` answers.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readWorkflow } from '../src/fixtures/repo';

const VERSION = '9.9.9';
const ARCHIVE = `gitleaks_${VERSION}_linux_x64.tar.gz`;
const SUMS = `gitleaks_${VERSION}_checksums.txt`;
// Prints a marker the release URL never contains, so `out` proves whether the
// extracted binary ran.
const BINARY = '#!/bin/sh\necho gitleaks-ran\n';

// The `run:` block of one step, de-indented, exactly as the runner hands it to
// bash.
function runBlock(workflow: string, step: string): string {
  const start = workflow.indexOf(`      - name: ${step}\n`);
  expect(start, `step "${step}" is missing`).toBeGreaterThan(-1);
  const run = workflow.indexOf('        run: |\n', start);
  expect(run, `step "${step}" has no run block`).toBeGreaterThan(start);
  const lines: string[] = [];
  for (const line of workflow.slice(run + '        run: |\n'.length).split('\n')) {
    if (line.trim() && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

// The install step downloads from the GITLEAKS_VERSION release and keeps it in
// `base`: a step that hard-codes its URL would silently test the network
// instead of the fixture.
const BASE_ASSIGNMENT =
  'base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"';

const expectReleaseBase = (workflow: string, step: string): void => {
  expect(
    runBlock(workflow, step),
    `${step} builds its release base from GITLEAKS_VERSION`,
  ).toContain(BASE_ASSIGNMENT);
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function tarGz(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-tar-'));
  try {
    writeFileSync(join(dir, 'gitleaks'), BINARY);
    chmodSync(join(dir, 'gitleaks'), 0o755);
    // A real gzip stream: the step extracts with `tar -xzf`.
    const tar = spawnSync('tar', ['-czf', '-', '-C', dir, 'gitleaks']);
    expect(tar.status, String(tar.stderr)).toBe(0);
    return tar.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Release = { archive: Buffer; sums?: string };

// A directory holding the release assets.
function serve(release: Release): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-release-'));
  writeFileSync(join(dir, ARCHIVE), release.archive);
  if (release.sums !== undefined) writeFileSync(join(dir, SUMS), release.sums);
  return dir;
}

function run(script: string, releaseDir: string): { status: number | null; out: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'gitleaks-run-'));
  const result = spawnSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, GITLEAKS_VERSION: VERSION, GITLEAKS_BASE: `file://${releaseDir}` },
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// Both workflows install the scanner before it decides whether a committed
// secret blocks anything.
const workflows = [
  { file: 'secret-scan.yml', step: 'Install gitleaks' },
  { file: 'security-scan.yml', step: 'Install gitleaks' },
];

for (const { file, step } of workflows) {
  const source = readWorkflow(file);
  // The step assigns its release to `base`; the test swaps that assignment
  // for the fixture release, so the real download, checksum and extract lines
  // run unchanged. An unverified install reads neither `base` nor
  // GITLEAKS_VERSION, so it fails here before it can download anything.
  expectReleaseBase(source, step);
  const script = runBlock(source, step).replace(BASE_ASSIGNMENT, 'base="$GITLEAKS_BASE"');

  describe(`${file} installs a verified gitleaks`, () => {
    test('downloads, verifies and runs the genuine release', () => {
      const archive = tarGz();
      const { status, out } = run(
        script,
        serve({ archive, sums: `${sha256(archive)}  ${ARCHIVE}\n` }),
      );
      expect(status, out).toBe(0);
      expect(out).toContain(`${ARCHIVE}: OK`);
      expect(out).toContain('gitleaks-ran');
    });

    test('refuses a tampered archive before running it', () => {
      const archive = tarGz();
      const tampered = Buffer.from(archive);
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);
      const { status, out } = run(
        script,
        serve({ archive: tampered, sums: `${sha256(archive)}  ${ARCHIVE}\n` }),
      );
      expect(status).not.toBe(0);
      expect(out).toContain('FAILED');
      expect(out).not.toContain('gitleaks-ran');
    });

    test('refuses a release with no checksum manifest', () => {
      const { status, out } = run(script, serve({ archive: tarGz() }));
      expect(status).not.toBe(0);
      expect(out).not.toContain('gitleaks-ran');
    });

    test('refuses an archive the manifest lists with a TAB separator', () => {
      // The manifest carries the archive's own digest, so `sha256sum -c`
      // verifies it and the binary would run. `grep -q " ${archive}$"` sees no
      // space before the name (a TAB) and rejects it. Deleting that line keeps
      // this test red: the install then succeeds and prints `gitleaks-ran`.
      const archive = tarGz();
      const { status, out } = run(
        script,
        serve({ archive, sums: `${sha256(archive)}\t${ARCHIVE}\n` }),
      );
      expect(status).toBe(1);
      // The listing guard stops it before the download, so nothing ran.
      expect(out).not.toContain('gitleaks-ran');
      expect(out).not.toContain(`${ARCHIVE}: OK`);
    });
  });
}
