#!/usr/bin/env bun
/**
 * Publish one release's boot artifacts to a Platinum volume and tag it.
 *
 *   PLATINUM_API_URL=https://api.platinum.dev PLATINUM_API_KEY=pt_live_… \
 *     bun scripts/boot-artifacts/publish.ts [--release r2026.10.04-abc123] [--volume kortix-boot-artifacts] [--no-build]
 *
 * Builds (unless --no-build) and gathers exactly what this checkout's API
 * serves as its runtime assets: the `kortix-agent` daemon, the `kortix` CLI,
 * the managed-skill overlay, and the OpenCode binary of the pinned version.
 * Uploads them (only the 1 MiB blocks the volume does not already hold),
 * tags the commit with the release name, and prints the one setting the API
 * needs: KORTIX_BOOT_ARTIFACTS=<volume>@<release>.
 *
 * The API serves runtime assets from its own image, so publish from the same
 * commit you deploy. A tag that is never configured costs nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { managedSkillOverlayFiles, managedSkillOverlayHash } from '../../apps/api/src/runtime-assets/managed-skills';

const ROOT = resolve(import.meta.dir, '../..');
const BLOCK = 1024 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const API = (process.env.PLATINUM_API_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.PLATINUM_API_KEY ?? '';
if (!API || !KEY) throw new Error('PLATINUM_API_URL and PLATINUM_API_KEY are required');
const VOLUME = arg('volume') ?? 'kortix-boot-artifacts';
const sha = spawnSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();
const RELEASE = arg('release') ?? `r${new Date().toISOString().slice(0, 10).replaceAll('-', '.')}-${sha}`;

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ── 1. gather ─────────────────────────────────────────────────────────────
const stage = join(tmpdir(), `kortix-boot-artifacts-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'kortix'), { recursive: true });
mkdirSync(join(stage, 'opencode/bin'), { recursive: true });

if (!flag('no-build')) {
  run('bash', ['scripts/build.sh'], join(ROOT, 'apps/kortix-sandbox-agent-server'), { BUN_COMPILE_TARGET: 'bun-linux-x64' });
  run('bash', ['scripts/build.sh'], join(ROOT, 'apps/cli'), { BUN_COMPILE_TARGET: 'bun-linux-x64' });
}
const agentSrc = join(ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent');
const cliSrc = join(ROOT, 'apps/cli/dist/kortix');
for (const [src, dst] of [[agentSrc, 'kortix/kortix-agent'], [cliSrc, 'kortix/kortix']] as const) {
  writeFileSync(join(stage, dst), readFileSync(src));
  chmodSync(join(stage, dst), 0o755);
}

const overlay = managedSkillOverlayFiles();
const skillsHash = managedSkillOverlayHash(overlay);
writeFileSync(join(stage, 'managed-skills.json'), JSON.stringify({ hash: skillsHash, files: overlay }));
for (const f of overlay) {
  const p = join(stage, 'managed-skills', f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
}

const versions = JSON.parse(readFileSync(join(ROOT, 'packages/shared/src/runtime-versions.json'), 'utf8'));
const ocVersion: string = arg('opencode') ?? versions.opencode;
const tgz = join(stage, 'opencode.tgz');
const res = await fetch(`https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${ocVersion}.tgz`);
if (!res.ok) throw new Error(`OpenCode ${ocVersion} download: ${res.status}`);
writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
run('tar', ['-xzf', tgz, '-C', join(stage, 'opencode'), '--strip-components=1', 'package/bin/opencode'], stage);
rmSync(tgz);
chmodSync(join(stage, 'opencode/bin/opencode'), 0o755);

const manifest = {
  release: RELEASE,
  source_sha: sha,
  built_at: new Date().toISOString(),
  components: {
    agent: { path: 'kortix/kortix-agent', sha256: sha256(readFileSync(join(stage, 'kortix/kortix-agent'))) },
    cli: { path: 'kortix/kortix', sha256: sha256(readFileSync(join(stage, 'kortix/kortix'))) },
    opencode: { path: 'opencode/bin/opencode', version: ocVersion },
    'managed-skills': { path: 'managed-skills', hash: skillsHash },
  },
};
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ── 2. upload ─────────────────────────────────────────────────────────────
async function pt<T>(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (r.ok) {
      const t = await r.text();
      return (t ? JSON.parse(t) : {}) as T;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 5) {
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
}
const v = `/v1/volumes/${encodeURIComponent(VOLUME)}`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
}
const files = walk(stage).map((p) => {
  const bytes = readFileSync(p);
  const blocks: string[] = [];
  for (let off = 0; off < bytes.length; off += BLOCK) blocks.push(sha256(bytes.subarray(off, off + BLOCK)));
  return { local: p, path: `/${relative(stage, p)}`, bytes, blocks, mode: statSync(p).mode & 0o7777 };
});
const total = files.reduce((n, f) => n + f.bytes.length, 0);
console.log(`[publish] ${RELEASE}: ${files.length} files, ${(total / 1048576).toFixed(1)} MiB`);

await pt('PUT', v, { sync_mode: 'git' });
// A file a newer release dropped must not linger: clear the release dirs first.
for (const top of ['kortix', 'opencode', 'managed-skills']) {
  await pt('DELETE', `${v}/files?path=${encodeURIComponent(`/${top}`)}&recursive=true`).catch(() => {});
}
const plan = await pt<{ upload_id: string; missing: string[] }>('POST', `${v}/files/upload`, {
  overwrite: true,
  files: files.map((f) => ({ path: f.path, size: f.bytes.length, mode: f.mode, mtime: Date.now(), blocks: f.blocks })),
  dirs: [],
});
const where = new Map<string, Uint8Array>();
for (const f of files) f.blocks.forEach((s, i) => where.set(s, f.bytes.subarray(i * BLOCK, (i + 1) * BLOCK)));
const missing = [...new Set(plan.missing ?? [])];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < missing.length) {
    const s = missing[next++]!;
    await pt('PUT', `${v}/files/upload/${plan.upload_id}/blocks/${s}`, undefined, where.get(s)!);
  }
}));
const commit = await pt<{ commit_id: string; head_commit_id?: string }>('POST', `${v}/files/upload/${plan.upload_id}/commit`, {});
const commitId = commit.head_commit_id ?? commit.commit_id;
await pt('PUT', `${v}/tags/${encodeURIComponent(RELEASE)}`, { commit: commitId });
console.log(`[publish] uploaded ${missing.length} new blocks; tagged ${RELEASE} at ${commitId}`);
rmSync(stage, { recursive: true, force: true });
console.log(`\nKORTIX_BOOT_ARTIFACTS=${VOLUME}@${RELEASE}`);
