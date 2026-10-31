/**
 * Integration test (real Postgres, Platinum stubbed at `fetch` with one
 * in-memory volume store per region): a project's Files live in one Platinum
 * region, and everything about them goes there.
 *
 * - A drive is created where the project's `us_region` flag says, and every
 *   Files route call goes to that region's control plane; the home region
 *   (which would answer `409 volume_in_other_region`) is never asked.
 * - While a region move copies a drive, the Files routes refuse writes with
 *   `503 drive_moving` and still serve reads.
 * - A move copies every directory and file byte for byte into a new volume of
 *   the target region, swaps the row, detaches stopped boxes' mounts, and
 *   leaves the old volume untouched. A running box's mount stops it before
 *   anything changes.
 * - Deleting a drive queues its volume, and a moved drive's old one, for
 *   deletion in their own regions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

const { eq } = await import('drizzle-orm');
const { accountMembers, drives, platinumVolumeDeletions, projectMembers, sessionSandboxes } = await import('@kortix/db');
const { config } = await import('../config');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { seedProject, seedSession } = await import('./helpers/integration-fixtures');
const { __resetPlatinumSandboxOriginsForTests } = await import('../shared/platinum');
const { abortDriveMove, moveDriveToRegion } = await import('../drives/region-move');
const { driveVolume } = await import('../drives/service');
const { writeVolumeFile } = await import('../drives/volumes');

const OWNER = crypto.randomUUID();
const PT = 'https://api.platinum.test';
const PT_US = 'https://us-east.api.platinum.test';
const REGION_OF: Record<string, string> = { [PT]: 'eu-west', [PT_US]: 'us-east' };

interface FakeVolume {
  id: string;
  files: Map<string, { bytes: Uint8Array; mtime: number; mode: number }>;
  dirs: Set<string>;
  head: number;
  mounts: Array<{ sandbox_id: string; mount_path: string; state: string }>;
}

/** Platinum's volumes, by region, by name. A name lives in one region only. */
const store = new Map<string, Map<string, FakeVolume>>([['eu-west', new Map()], ['us-east', new Map()]]);
const uploads = new Map<string, { volume: FakeVolume; files: Array<{ path: string; size: number; blocks: string[]; mtime?: number; mode?: number }>; dirs: string[] }>();
const blocks = new Map<string, Uint8Array>();
let calls: Array<{ method: string; origin: string; path: string }> = [];
/** What Platinum's `/health` answers for every volume. */
let health = { status: 'ok', reason: null as string | null };

const elsewhere = (region: string, name: string) => [...store.entries()].find(([r, vols]) => r !== region && vols.has(name))?.[0];
const parentsOf = (path: string) => path.split('/').slice(1, -1).map((_, i, parts) => `/${parts.slice(0, i + 1).join('/')}`);
const head = (v: FakeVolume) => `vc_${v.id}_${v.head}`;

function writeFile(v: FakeVolume, path: string, bytes: Uint8Array, mtime = Date.now(), mode = 0o644) {
  for (const d of parentsOf(path)) v.dirs.add(d);
  v.files.set(path, { bytes, mtime, mode });
  v.head++;
}

function entries(v: FakeVolume, dir: string, recursive: boolean) {
  const inside = (p: string) => (dir === '/' ? p !== '/' : p.startsWith(`${dir}/`));
  const direct = (p: string) => !p.slice(dir === '/' ? 1 : dir.length + 1).includes('/');
  const all = [
    ...[...v.dirs].map((p) => ({ path: p, type: 'dir', size: 0, mtime: 0 })),
    ...[...v.files].map(([p, f]) => ({ path: p, type: 'file', size: f.bytes.byteLength, mtime: f.mtime })),
  ];
  return all.filter((e) => inside(e.path) && (recursive || direct(e.path)));
}

async function platinum(url: URL, method: string, init?: RequestInit): Promise<Response> {
  const region = REGION_OF[url.origin]!;
  const vols = store.get(region)!;
  calls.push({ method, origin: url.origin, path: url.pathname });
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const q = (k: string) => url.searchParams.get(k);
  if (url.pathname === '/v1/volumes/limits') return json({ max_mounts_per_sandbox: 8 });
  const detach = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/volumes\/(.+)$/);
  if (detach && method === 'DELETE') {
    for (const v of vols.values()) v.mounts = v.mounts.filter((m) => !(m.sandbox_id === detach[1] && m.mount_path === decodeURIComponent(detach[2]!)));
    return json({ commit: null });
  }
  const m = url.pathname.match(/^\/v1\/volumes\/([^/]+)(\/.*)?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const name = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '';
  let v = vols.get(name);
  if (!v) {
    const other = elsewhere(region, name);
    if (other) return json({ code: 'volume_in_other_region', region: other }, 409);
    if (method === 'DELETE' && rest === '') return new Response(null, { status: 204 });
    if (!(method === 'PUT' && rest === '')) return json({ code: 'volume_not_found' }, 404);
    v = { id: `vol_${crypto.randomUUID().slice(0, 8)}`, files: new Map(), dirs: new Set(), head: 0, mounts: [] };
    vols.set(name, v);
    return json({ id: v.id, region, sync_mode: 'drive', head_commit_id: head(v) }, 201);
  }
  const info = () => ({ id: v!.id, region, sync_mode: 'drive', head_commit_id: head(v!), file_count: v!.files.size, logical_bytes: 0, last_commit_at: null });
  if (rest === '' && (method === 'PUT' || method === 'GET')) return json(info());
  if (rest === '' && method === 'DELETE') {
    if (v.mounts.length) return json({ code: 'volume_busy' }, 409);
    vols.delete(name);
    return new Response(null, { status: 204 });
  }
  if (rest === '/mounts') return json({ mounts: v.mounts });
  if (rest === '/health') return json(health);
  if (rest === '/files' && method === 'GET') return json({ entries: entries(v, q('path') ?? '/', q('recursive') === 'true'), next_cursor: null });
  if (rest === '/files/content' && method === 'GET') {
    const f = v.files.get(q('path')!);
    return f ? new Response(new Uint8Array(f.bytes)) : json({ code: 'file_not_found' }, 404);
  }
  if (rest === '/files/content' && method === 'PUT') {
    const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
    writeFile(v, q('path')!, bytes);
    return json({ path: q('path'), size: bytes.byteLength, version: head(v), commit_id: head(v), outcome: 'fast', head_commit_id: head(v) }, 201);
  }
  if (rest === '/files/stat') {
    const f = v.files.get(q('path')!);
    return f ? json({ path: q('path'), type: 'file', size: f.bytes.byteLength, mtime: f.mtime, mode: f.mode, version: head(v) }) : json({ code: 'file_not_found' }, 404);
  }
  if (rest === '/files/upload' && method === 'POST') {
    const plan = JSON.parse(String(init?.body)) as { files: Array<{ path: string; size: number; blocks: string[] }>; dirs?: string[] };
    const id = crypto.randomUUID();
    uploads.set(id, { volume: v, files: plan.files, dirs: plan.dirs ?? [] });
    return json({ upload_id: id, missing: [...new Set(plan.files.flatMap((f) => f.blocks))].filter((sha) => !blocks.has(sha)) });
  }
  const block = rest.match(/^\/files\/upload\/([^/]+)\/blocks\/([0-9a-f]+)$/);
  if (block && method === 'PUT') {
    blocks.set(block[2]!, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
    return new Response(null, { status: 204 });
  }
  const commit = rest.match(/^\/files\/upload\/([^/]+)\/commit$/);
  if (commit && method === 'POST') {
    const up = uploads.get(commit[1]!)!;
    for (const d of up.dirs) up.volume.dirs.add(d);
    for (const f of up.files) {
      const parts = f.blocks.map((sha) => blocks.get(sha)!);
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
      writeFile(up.volume, f.path, bytes, f.mtime, f.mode);
    }
    return json({ commit_id: head(up.volume), outcome: 'fast', head_commit_id: head(up.volume), files: up.files.map((f) => ({ path: f.path })) });
  }
  return json({ error: `fake platinum: ${method} ${url.pathname}` }, 500);
}

const original = {
  PLATINUM_API_URL: config.PLATINUM_API_URL,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  US_REGION: process.env.KORTIX_PLATINUM_US_REGION,
};
const realFetch = globalThis.fetch;
const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
let ownerSecret = '';
let account = '';

async function projectWith(usRegion: boolean) {
  const p = await seedProject(`drive-region-${usRegion ? 'us' : 'home'}`, { ...(account ? { accountId: account } : {}), metadata: { experimental: { us_region: usRegion } } });
  account = p.account_id;
  await insertIntoView(db, projectMembers, [{ accountId: p.account_id, projectId: p.project_id, userId: OWNER, projectRole: 'manager' }]);
  return p;
}

async function call(path: string, init: RequestInit = {}) {
  const res = await app.request(path, { ...init, headers: { Authorization: `Bearer ${ownerSecret}`, ...init.headers } });
  return { status: res.status, text: await res.text() };
}

async function driveOf(projectId: string) {
  const res = await call(`/v1/drives?projectId=${projectId}`);
  expect(res.status).toBe(200);
  const [row] = await db.select().from(drives).where(eq(drives.projectId, projectId));
  return row!;
}

const put = (driveId: string, path: string, body: string) =>
  call(`/v1/drives/${driveId}/files/content?path=${encodeURIComponent(path)}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
const get = (driveId: string, path: string) => call(`/v1/drives/${driveId}/files/content?path=${encodeURIComponent(path)}`);
const volumeCalls = (name: string) => calls.filter((c) => c.path.startsWith(`/v1/volumes/${name}`));

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Run through pnpm test -- --db-only drive-region');
  config.PLATINUM_API_URL = PT;
  config.PLATINUM_API_KEY = 'pt_synthetic_drive_region';
  process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!(url.origin in REGION_OF)) return realFetch(input, init);
    return platinum(url, (init?.method ?? 'GET').toUpperCase(), init);
  }) as typeof fetch;
  const first = await projectWith(false);
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: first.account_id, accountRole: 'owner', isSuperAdmin: false }]);
  const owner = await createAccountToken({ accountId: first.account_id, userId: OWNER, name: 'drive-region-owner' });
  ownerSecret = owner.secretKey;
});

beforeEach(() => {
  calls = [];
  health = { status: 'ok', reason: null };
  __resetPlatinumSandboxOriginsForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  sleep.mockRestore();
  config.PLATINUM_API_URL = original.PLATINUM_API_URL;
  config.PLATINUM_API_KEY = original.PLATINUM_API_KEY;
  if (original.US_REGION === undefined) delete process.env.KORTIX_PLATINUM_US_REGION;
  else process.env.KORTIX_PLATINUM_US_REGION = original.US_REGION;
  // The suite's database is its own (pnpm test -- --db-only): no row cleanup.
});

describe('Files live in their project’s region', () => {
  test('a us_region project’s Files are created in us-east, and every Files call goes there', async () => {
    const p = await projectWith(true);
    const drive = await driveOf(p.project_id);
    expect(drive.platinumVolumeRegion).toBe('us-east');

    expect((await put(drive.driveId, '/Company/plan.md', 'written in us-east')).status).toBe(200);
    const read = await get(drive.driveId, '/Company/plan.md');
    expect(read).toEqual({ status: 200, text: 'written in us-east' });
    const list = await call(`/v1/drives/${drive.driveId}/files?path=/Company`);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).entries.map((e: { path: string }) => e.path)).toContain('/Company/plan.md');

    const touched = volumeCalls(drive.platinumVolumeName);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((c) => c.origin === PT_US)).toBe(true);
    expect(store.get('us-east')!.has(drive.platinumVolumeName)).toBe(true);
    expect(store.get('eu-west')!.has(drive.platinumVolumeName)).toBe(false);
  });

  test('a project without us_region keeps its Files in the home region', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    expect(drive.platinumVolumeRegion).toBeNull();
    expect((await put(drive.driveId, '/Company/home.md', 'home')).status).toBe(200);
    expect(volumeCalls(drive.platinumVolumeName).every((c) => c.origin === PT)).toBe(true);
  });

  test('while a region move copies a drive, writes answer 503 drive_moving and reads still work', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    expect((await put(drive.driveId, '/Company/before.md', 'before')).status).toBe(200);
    await db.update(drives).set({
      platinumVolumeMove: { to: 'us-east', from_name: drive.platinumVolumeName, from_region: null, started_at: new Date().toISOString() },
    }).where(eq(drives.driveId, drive.driveId));
    calls = [];

    const refused = await put(drive.driveId, '/Company/during.md', 'during');
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.text).code).toBe('drive_moving');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(await get(drive.driveId, '/Company/before.md')).toEqual({ status: 200, text: 'before' });

    await db.update(drives).set({ platinumVolumeMove: null }).where(eq(drives.driveId, drive.driveId));
  });
});

describe('moving a drive to another region', () => {
  test('copies every file and folder, swaps the row, detaches stopped boxes, and keeps the old volume', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/notes/a.md', 'alpha');
    await put(drive.driveId, '/Company/notes/b.bin', 'x'.repeat(3 * 1024 * 1024 + 7));
    const old = store.get('eu-west')!.get(drive.platinumVolumeName)!;
    old.dirs.add('/Company/empty');
    const oldHead = head(old);
    // A stopped box still holds a mount of the drive.
    const sessionId = await seedSession(p, OWNER);
    await db.insert(sessionSandboxes).values({
      sandboxId: sessionId, sessionId, accountId: p.account_id, projectId: p.project_id, provider: 'platinum', status: 'stopped', externalId: 'sbx_stopped',
      metadata: { driveMounts: [{ driveId: drive.driveId, kind: 'project', mountPath: '/drives/company', readOnly: false, subdir: '/Company' }] },
    });
    old.mounts.push({ sandbox_id: 'sbx_stopped', mount_path: '/drives/company', state: 'parked' });

    const planned = await moveDriveToRegion(drive.driveId, 'us-east', { apply: false });
    expect(planned.outcome).toBe('planned');
    expect((await db.select().from(drives).where(eq(drives.driveId, drive.driveId)))[0]!.platinumVolumeName).toBe(drive.platinumVolumeName);

    const report = await moveDriveToRegion(drive.driveId, 'us-east', { apply: true });
    expect(report.outcome).toBe('moved');
    expect(report.detached).toBe(1);

    const [moved] = await db.select().from(drives).where(eq(drives.driveId, drive.driveId));
    expect(moved!.platinumVolumeRegion).toBe('us-east');
    expect(moved!.platinumVolumeName).toBe(`${drive.platinumVolumeName}-us-east`);
    expect(moved!.platinumVolumeMove).toMatchObject({ to: 'us-east', from_name: drive.platinumVolumeName, from_region: null, from_head: oldHead });
    expect(moved!.platinumVolumeMove?.finished_at).toBeString();

    const copy = store.get('us-east')!.get(moved!.platinumVolumeName)!;
    expect([...copy.files.keys()].sort()).toEqual([...old.files.keys()].sort());
    for (const [path, f] of old.files) expect(Buffer.from(copy.files.get(path)!.bytes).equals(Buffer.from(f.bytes))).toBe(true);
    expect(copy.dirs.has('/Company/empty')).toBe(true);
    // The old volume is untouched; only its stopped-box mount ended.
    expect(head(old)).toBe(oldHead);
    expect(old.mounts).toEqual([]);
    const [box] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId));
    expect((box!.metadata as { driveMounts: unknown[] }).driveMounts).toEqual([]);

    // The Files routes now read and write the new volume, in us-east.
    calls = [];
    expect(await get(drive.driveId, '/Company/notes/a.md')).toEqual({ status: 200, text: 'alpha' });
    expect((await put(drive.driveId, '/Company/after.md', 'after')).status).toBe(200);
    expect(calls.filter((c) => c.path.startsWith('/v1/volumes/')).every((c) => c.origin === PT_US)).toBe(true);
    expect(old.files.has('/Company/after.md')).toBe(false);
  });

  test('a drive deleted since the run listed it is reported and skipped, not a crash', async () => {
    const report = await moveDriveToRegion(crypto.randomUUID(), 'us-east', { apply: true });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('the drive no longer exists');
  });

  test('a drive a running box mounts does not move, and nothing changes', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/live.md', 'live');
    const old = store.get('eu-west')!.get(drive.platinumVolumeName)!;
    old.mounts.push({ sandbox_id: 'sbx_running', mount_path: '/drives/company', state: 'mounted' });

    const report = await moveDriveToRegion(drive.driveId, 'us-east', { apply: true });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('running box');
    const [row] = await db.select().from(drives).where(eq(drives.driveId, drive.driveId));
    expect(row!.platinumVolumeName).toBe(drive.platinumVolumeName);
    expect(row!.platinumVolumeRegion).toBeNull();
    expect(row!.platinumVolumeMove).toBeNull();
    expect(old.mounts).toHaveLength(1);
    expect(store.get('us-east')!.has(`${drive.platinumVolumeName}-us-east`)).toBe(false);
    old.mounts = [];
  });

  test('a write sent with the drive row read before the move is refused after it, and the old volume stays as it was', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/a.md', 'a');
    const stale = driveVolume(drive);
    expect((await moveDriveToRegion(drive.driveId, 'us-east', { apply: true })).outcome).toBe('moved');
    const old = store.get('eu-west')!.get(drive.platinumVolumeName)!;
    const before = head(old);
    const refused = await writeVolumeFile(stale, '/Company/late.md', new TextEncoder().encode('late') as Uint8Array<ArrayBuffer>, { overwrite: false })
      .catch((err: { code?: string }) => err.code);
    expect(refused).toBe('drive_moving');
    expect(head(old)).toBe(before);
    expect(old.files.has('/Company/late.md')).toBe(false);
  });

  test('a volume Platinum does not report saved does not move, and the fence comes down', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/a.md', 'a');
    health = { status: 'degraded', reason: 'merge queue not empty' };
    const report = await moveDriveToRegion(drive.driveId, 'us-east', { apply: true });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('merge queue not empty');
    const [row] = await db.select().from(drives).where(eq(drives.driveId, drive.driveId));
    expect(row!.platinumVolumeMove).toBeNull();
    expect(row!.platinumVolumeName).toBe(drive.platinumVolumeName);
    expect((await put(drive.driveId, '/Company/b.md', 'b')).status).toBe(200);
  });

  test('abort lifts the fence of a move whose process died and deletes its half-made volume', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/a.md', 'a');
    await db.update(drives).set({
      platinumVolumeMove: { to: 'us-east', from_name: drive.platinumVolumeName, from_region: null, started_at: new Date().toISOString() },
    }).where(eq(drives.driveId, drive.driveId));
    store.get('us-east')!.set(`${drive.platinumVolumeName}-us-east`, { id: 'vol_half', files: new Map(), dirs: new Set(), head: 0, mounts: [] });
    expect((await put(drive.driveId, '/Company/b.md', 'b')).status).toBe(503);

    expect(await abortDriveMove(drive.driveId)).toContain('fence lifted');
    const [row] = await db.select().from(drives).where(eq(drives.driveId, drive.driveId));
    expect(row!.platinumVolumeMove).toBeNull();
    expect(store.get('us-east')!.has(`${drive.platinumVolumeName}-us-east`)).toBe(false);
    expect((await put(drive.driveId, '/Company/b.md', 'b')).status).toBe(200);
  });

  test('deleting a moved drive queues its volume and its old one, each with its region', async () => {
    const p = await projectWith(false);
    const drive = await driveOf(p.project_id);
    await put(drive.driveId, '/Company/x.md', 'x');
    expect((await moveDriveToRegion(drive.driveId, 'us-east', { apply: true })).outcome).toBe('moved');
    await db.delete(drives).where(eq(drives.driveId, drive.driveId));
    const queued = await db.select().from(platinumVolumeDeletions);
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({ volumeName: `${drive.platinumVolumeName}-us-east`, region: 'us-east', reason: 'drive_deleted' }),
      expect.objectContaining({ volumeName: drive.platinumVolumeName, region: null, reason: 'drive_deleted' }),
    ]));
  });
});
