/**
 * The versitygw S3 gateway that capture-build.yml installs must be verified
 * before it runs.
 *
 * CWE-494: the workflow downloaded the versitygw v1.8.0 release archive at six
 * sites and ran the extracted binary with no integrity check, although the
 * release publishes `checksums.txt`. capture-build.yml is the reusable workflow
 * deploy-prod.yml calls for the prod Capture installers and capture.yml calls
 * for dev, so a swapped asset would run inside the release pipeline.
 *
 * The tests run the REAL `run:` lines of a site — fetch, listing guard, digest
 * check, extraction — with only the network fetches swapped for a copy from a
 * local fixture release, then run the extracted binary. They assert what CI
 * executes: the genuine release passes, and a tampered archive, a release
 * without a manifest and an archive the manifest does not list all fail before
 * the binary runs. GitHub runs a `run: |` step with `bash -e`, so the tests do
 * too.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readWorkflow } from '../src/fixtures/repo';

const WORKFLOW = readWorkflow('capture-build.yml');
const RAN = 'versitygw-ran';
const BINARY = `#!/bin/sh\necho ${RAN}\n`;

const LINUX = 'versitygw_v1.8.0_Linux_x86_64.tar.gz';
const DARWIN = 'versitygw_v1.8.0_Darwin_arm64.tar.gz';
const WINDOWS = 'versitygw_v1.8.0_Windows_x86_64.zip';
const VERSION = WORKFLOW.match(/^ {2}VERSITYGW_VERSION: (\S+)$/m)?.[1];

// Every job in the workflow that installs versitygw, the archive it uses and
// the shell its step runs in.
const SITES = [
  { job: 'test', archive: LINUX, shell: 'bash' },
  { job: 'windows-msi', archive: WINDOWS, shell: 'pwsh' },
  { job: 'macos-pkg', archive: DARWIN, shell: 'bash' },
  { job: 'linux-deb', archive: LINUX, shell: 'bash' },
  { job: 'macos-personal', archive: DARWIN, shell: 'bash' },
  { job: 'windows-personal', archive: WINDOWS, shell: 'pwsh' },
] as const;

// The de-indented `run:` block of the versitygw step in one job. The step is
// found by the line that fetches the release, not by its name (the `test` job
// calls it "Cloud sync against a real S3 gateway").
function step(job: string): string[] {
  const jobStart = WORKFLOW.indexOf(`\n  ${job}:\n`);
  expect(jobStart, `job "${job}" is missing`).toBeGreaterThan(-1);
  const fetch = /^ {10}(?:gh release download|curl -sSfL )[^\n]*versitygw/m;
  const match = fetch.exec(WORKFLOW.slice(jobStart));
  expect(match, `job "${job}" does not fetch versitygw`).not.toBeNull();
  const start = WORKFLOW.lastIndexOf('        run: |\n', jobStart + (match?.index ?? 0));
  expect(start, `job "${job}": no run block`).toBeGreaterThan(jobStart);
  const lines: string[] = [];
  for (const line of WORKFLOW.slice(start + '        run: |\n'.length).split('\n')) {
    if (line.trim() && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

// A real gzip stream holding a `versitygw` shell script that prints RAN.
function tarGz(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'versitygw-tar-'));
  try {
    writeFileSync(join(dir, 'versitygw'), BINARY);
    chmodSync(join(dir, 'versitygw'), 0o755);
    const tar = spawnSync('tar', ['-czf', '-', '-C', dir, 'versitygw']);
    expect(tar.status, String(tar.stderr)).toBe(0);
    return tar.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A real zip stream holding a `versitygw.exe` shell script that prints RAN.
function zip(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'versitygw-zip-'));
  try {
    writeFileSync(join(dir, 'versitygw.exe'), BINARY);
    const zipped = spawnSync('zip', ['-q', '-X', join(dir, 'release.zip'), 'versitygw.exe'], {
      cwd: dir,
    });
    expect(zipped.status, String(zipped.stderr)).toBe(0);
    return readFileSync(join(dir, 'release.zip'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A local release directory: the archive plus, when given, its checksums.txt.
// Each run gets its own RUNNER_TEMP, as a job step does.
function fixture(archive: string, bytes: Buffer, sums?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'versitygw-fixture-'));
  writeFileSync(join(dir, archive), bytes);
  if (sums !== undefined) writeFileSync(join(dir, 'checksums.txt'), sums);
  writeFileSync(join(dir, 'home'), '');
  return dir;
}

type Result = { status: number | null; out: string };

// The step's shell lines with the two release fetches replaced by copies from
// the fixture. The listing guard, the digest check and the extraction are the
// workflow's own lines.
function offline(lines: string[], dir: string, archive: string): string[] {
  return lines.map((line) => {
    const gh = line.match(/^gh release download \S+ --repo versity\/versitygw .* -D ("?)(\S+?)\1$/);
    if (gh) return `cp "${dir}/${archive}" "${dir}/checksums.txt" ${gh[2]}`;
    const checksums = line.match(/^curl -sSfL "\$\{base\}\/checksums\.txt" -o (".*"|\S+)$/);
    if (checksums) return `cp "${dir}/checksums.txt" ${checksums[1]}`;
    const asset = line.match(/^curl -sSfL "\$\{base\}\/(versitygw\S+)" -o (".*"|\S+)$/);
    if (asset) return `cp "${dir}/${asset[1]}" ${asset[2]}`;
    return line;
  });
}

// A POSIX site, through the extraction and the path it resolves for the
// extracted binary, then one run of that binary. `bash -e` is how the runner
// runs a `run: |` step: a refused archive fails the guard and the step ends
// before the extraction, so the binary never runs.
function installJob(job: string, archive: string, dir: string): Result {
  const lines = offline(step(job), dir, archive);
  const extract = lines.findIndex((line) => line.startsWith('tar -xzf'));
  expect(extract, `no tar extraction of ${archive} in ${job}`).toBeGreaterThan(-1);
  // The line that resolves the extracted binary: an `export`ed test variable,
  // a `gw=` assignment, or the `nohup "$(find …)"` that starts the gateway.
  // The test runs that binary without the gateway flags, all it needs to see.
  const isPath = (line: string, i: number): boolean =>
    i > extract && /^(?:export |gw=|nohup )/.test(line) && line.includes('$(find ');
  const resolved = lines.findIndex(isPath);
  expect(resolved, `no binary path after the extraction in ${job}`).toBeGreaterThan(extract);
  const line = lines[resolved];
  const binary = /^export [A-Z_]+=/.test(line)
    ? '"$KORTIX_CAPTURE_TEST_VERSITYGW"'
    : /^gw=/.test(line)
      ? '"$gw"'
      : `"${line.slice(line.indexOf('$(find '), line.lastIndexOf(')') + 1)}"`;
  const script = [...lines.slice(0, resolved + 1), `sh ${binary}`].join('\n');
  const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: dir, EV: dir, VERSITYGW_VERSION: VERSION },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

for (const { job, archive } of SITES.filter((site) => site.shell === 'bash')) {
  const bytes = tarGz();
  const sums = `${sha256(bytes)}  ${archive}\n`;
  const attempt = (fixtureBytes: Buffer, manifest?: string): Result => {
    const dir = fixture(archive, fixtureBytes, manifest);
    const { status, out } = installJob(job, archive, dir);
    // The step runs the gateway in the background; stop it so the test ends.
    rmSync(dir, { recursive: true, force: true });
    return { status, out };
  };

  describe(`${job}: versitygw is verified before it runs`, () => {
    test('runs the genuine release', () => {
      const { status, out } = attempt(bytes, sums);
      expect(out).toContain(`${archive}: OK`);
      expect(out).toContain(RAN);
      expect(status, out).toBe(0);
    });

    test('refuses a tampered archive', () => {
      // Flip a byte in the middle, away from the gzip header, so the stream
      // stays readable and only the digest check can catch it.
      const tampered = Buffer.from(bytes);
      tampered[tampered.length >> 1] ^= 0xff;
      const { status, out } = attempt(tampered, sums);
      expect(out).toContain(`${archive}: FAILED`);
      expect(out).not.toContain(RAN);
      expect(status).not.toBe(0);
    });

    test('refuses a release with no checksums.txt', () => {
      const { status, out } = attempt(bytes);
      expect(out).not.toContain(RAN);
      expect(status).not.toBe(0);
    });

    test('refuses an archive the manifest does not list', () => {
      // Its own digest matches, so only the listing guard rejects it.
      const { status, out } = attempt(bytes, `${sha256(bytes)}  some-other-asset.tar.gz\n`);
      expect(out).not.toContain(RAN);
      expect(status).not.toBe(0);
    });
  });
}

// The Windows sites run PowerShell. A runner without pwsh (a factory sandbox,
// the unit lane) has no PowerShell, so their execution is asserted structurally
// below; on a runner that has pwsh, they run for real.
const hasPwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

// The Windows guard: from `$archive` to the extraction. It lists the archive in
// checksums.txt, reads its published digest and compares it to the file's,
// throwing on either failure.
function windowsGuard(job: string, archive: string): { guard: string; extract: string } {
  const lines = step(job);
  const start = lines.findIndex((line) => line.startsWith('$archive = '));
  const end = lines.findIndex((line) => line.startsWith('Expand-Archive'));
  expect(start, `no $archive line in ${job}`).toBeGreaterThan(-1);
  expect(end, `no Expand-Archive in ${job}`).toBeGreaterThan(start);
  return { guard: lines.slice(start, end).join('\n'), extract: lines[end] };
}

for (const { job, archive } of SITES.filter((site) => site.shell === 'pwsh')) {
  describe(`${job}: versitygw is verified before it runs`, () => {
    test('checks checksums.txt before it extracts or runs anything', () => {
      const { guard, extract } = windowsGuard(job, archive);
      const listing = guard.indexOf('checksums.txt does not list');
      const digest = guard.indexOf('does not match checksums.txt');
      const expand = guard.indexOf('Expand-Archive');
      expect(guard).toContain(`$archive = "${archive}"`);
      expect(listing, 'the listing guard is present').toBeGreaterThan(-1);
      expect(digest, 'the digest check is present').toBeGreaterThan(listing);
      // Nothing runs before the checks, and the extraction is the workflow's
      // own line, after both of them.
      expect(expand, 'no extraction before the checks').toBe(-1);
      expect(extract).toContain(archive);
    });

    const fixture = (bytes: Buffer, sums?: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'versitygw-win-'));
      writeFileSync(join(dir, archive), bytes);
      if (sums !== undefined) writeFileSync(join(dir, 'checksums.txt'), sums);
      return dir;
    };
    const run = (dir: string): Result => {
      const script = [
        "$ErrorActionPreference='Stop'",
        `$d = '${dir}'`,
        `$env:VERSITYGW_VERSION = '${VERSION}'`,
        windowsGuard(job, archive).guard,
      ].join('\n');
      const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', script], {
        encoding: 'utf8',
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };

    test.skipIf(!hasPwsh)('accepts the genuine release', () => {
      const bytes = zip();
      const { status, out } = run(fixture(bytes, `${sha256(bytes)}  ${archive}\n`));
      expect(out).toContain(`SHA256 ${archive} verified against checksums.txt`);
      expect(status, out).toBe(0);
    });

    test.skipIf(!hasPwsh)('refuses a tampered archive', () => {
      const bytes = zip();
      const tampered = Buffer.from(bytes);
      tampered[tampered.length >> 1] ^= 0xff;
      const { status, out } = run(fixture(tampered, `${sha256(bytes)}  ${archive}\n`));
      expect(out).toContain('does not match checksums.txt');
      expect(status).not.toBe(0);
    });

    test.skipIf(!hasPwsh)('refuses an archive the manifest does not list', () => {
      const bytes = zip();
      const { status, out } = run(fixture(bytes, `${sha256(bytes)}  some-other-asset.zip\n`));
      expect(out).toContain(`checksums.txt does not list ${archive}`);
      expect(status).not.toBe(0);
    });
  });
}

test('all six install sites are covered by this file', () => {
  const fetches =
    WORKFLOW.match(
      /^ {10}(?:gh release download [^\n]*repo versity\/versitygw|base="https:\/\/github\.com\/versity\/versitygw\/releases)/gm,
    ) ?? [];
  const installed =
    WORKFLOW.match(/^ {10}(?:Expand-Archive|tar -xzf)[^\n]*versitygw_[^\n]*$/gm) ?? [];
  // A seventh site added without a case here would ship unverified.
  expect(fetches).toHaveLength(SITES.length);
  expect(installed).toHaveLength(SITES.length);
});
