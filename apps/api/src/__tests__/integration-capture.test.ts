/**
 * Integration test (real local PostgreSQL): Kortix Capture ingestion, detected
 * ranges, the range pipelines and retention. The object store is an in-memory
 * map behind the capture store module, holding the engine's vendored fixture
 * bucket (tests/fixtures/capture-format-v2, pinned) re-rooted under a Kortix
 * prefix by the same fixture the CAP flows upload (tests/src/fixtures/capture.ts).
 * The pipelines run with a scripted model caller: the orchestration, the
 * stored outputs and the deterministic segmentation rules are what is proved
 * here; real gateway calls are proved by hand (PR body).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

const objects = new Map<string, Uint8Array>();
const removed: string[] = [];
mock.module('../capture/store', () => ({
  captureStore: {
    configured: true,
    bucket: 'test-bucket',
    getBytes: async (key: string) => objects.get(key) ?? null,
    getText: async (key: string) => (objects.has(key) ? new TextDecoder().decode(objects.get(key)!) : null),
    head: async (key: string) => (objects.has(key) ? { bytes: objects.get(key)!.byteLength, etag: null } : null),
    remove: async (keys: string[]) => {
      for (const key of keys) {
        removed.push(key);
        objects.delete(key);
      }
      return keys.length;
    },
    presignDownload: async (key: string) => ({ url: `https://store.test/${key}`, expiresAt: new Date() }),
    list: async (prefix: string) =>
      [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => ({ key, bytes: body.byteLength, lastModified: new Date(0) })),
  },
  captureStoreConfigured: () => true,
  captureRegion: () => 'us-east-1',
  deviceEndpoint: () => 'https://store.test',
  putCaptureObject: async (key: string, body: string) => void objects.set(key, new TextEncoder().encode(body)),
  getCaptureObjectIfChanged: async (key: string) =>
    objects.has(key) ? { status: 'ok', body: objects.get(key)!, etag: createHash('md5').update(objects.get(key)!).digest('hex') } : { status: 'missing' },
}));

const { accounts, captureDevices, captureWorkspaces, rangeOutputs, timelineChunks, timelineRanges } = await import('@kortix/db');
const { and, eq, sql } = await import('drizzle-orm');
const { db } = await import('../shared/db');
const { ingestManifest, extendDetectedRange } = await import('../capture/ingest');
const { processRange, applyIdleWindows, computeIdleWindows, normalizeSegments } = await import('../capture/processing');
const { applyRetention, closeQuietRanges, pollDevice } = await import('../capture/workers');
const { writeAccountPolicy } = await import('../capture/policy');
const { frameOf, frameVideoOffsetMs, recordedDays } = await import('../capture/reads');
const { DEFAULT_POLICY, accountPrefix } = await import('../capture/format');
const { vendoredDevice } = await import('../../../../tests/src/fixtures/capture');

const ACCOUNT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const PREFIX = accountPrefix(ACCOUNT);
let deviceId = '';
const MACHINE = 'b'.repeat(64);

async function count(table: string, where = sql`TRUE`): Promise<number> {
  const [row] = Array.from(
    await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier('kortix')}.${sql.identifier(table)} WHERE device_id = ${deviceId}::uuid AND ${where}`),
  );
  return row!.n;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'capture-test-acct' });
  // Capture's tenant is the account: its workspace row is the switch. No project anywhere.
  await db.insert(captureWorkspaces).values({ accountId: ACCOUNT, enabled: true });
  const [device] = await db
    .insert(captureDevices)
    .values({ accountId: ACCOUNT, userId: MEMBER, machineKeySha256: MACHINE })
    .returning();
  deviceId = device!.deviceId;
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('ingestion', () => {
  let day: ReturnType<typeof vendoredDevice>;

  test('the index reader queues every complete item and reads live status and device.json', async () => {
    day = vendoredDevice({ prefix: PREFIX, deviceId, machineKeySha256: MACHINE });
    for (const object of day.objects) objects.set(object.key, object.body);
    const [device] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    const polled = await pollDevice(device!);
    expect(polled.enqueued).toBe(day.manifestKeys.length);
    const [after] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    expect(after!.status?.recording).toBe('recording');
    expect(after!.name).toBe('Fixture Computer');
    // Unchanged index on the next poll: nothing new is queued.
    expect((await pollDevice(after!)).enqueued).toBe(0);
  });

  test('each manifest indexes once; audio waits for the policy layer; counts match the device output', async () => {
    const outcomes = [];
    for (const key of day.manifestKeys) outcomes.push(await ingestManifest(key));
    expect(outcomes.filter((o) => o.status === 'indexed').length).toBe(day.expected.chunks - 1);
    expect(outcomes.find((o) => o.status === 'skipped')).toEqual({ status: 'skipped', reason: 'audio layer is off by policy' });
    expect(await count('timeline_frames')).toBe(day.expected.frames);
    expect(await count('timeline_actions')).toBe(day.expected.actions);
    expect(await count('timeline_audio')).toBe(0);

    await writeAccountPolicy(ACCOUNT, { ...DEFAULT_POLICY, layers: { screen: true, actions: true, audio: true } }, MEMBER);
    expect(JSON.parse(new TextDecoder().decode(objects.get(`${PREFIX}/policy.json`)!)).layers.audio).toBe(true);
    const audioKey = day.manifestKeys.find((key) => /-a\d+\.manifest\.json$/.test(key))!;
    expect((await ingestManifest(audioKey)).status).toBe('indexed');
    expect(await count('timeline_audio')).toBe(day.expected.audioLines);

    // Idempotent: a second ingest of every key indexes nothing new.
    for (const key of day.manifestKeys) expect((await ingestManifest(key)).status).toBe('duplicate');
    expect(await count('timeline_frames')).toBe(day.expected.frames);
  });

  test('recorded days: one row per local day, newest first, with its first and last moment and screen time', async () => {
    const localDay = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
    const manifests = day.objects
      .filter((object) => day.manifestKeys.includes(object.key))
      .map((object) => JSON.parse(new TextDecoder().decode(object.body)) as { kind: string; start_ms: number; end_ms: number });
    const screenSeconds = Math.round(manifests.filter((m) => m.kind === 'chunk').reduce((sum, m) => sum + (m.end_ms - m.start_ms) / 1000, 0));
    for (const tz of ['UTC', 'Pacific/Kiritimati']) {
      const days = await recordedDays(ACCOUNT, MEMBER, { tz });
      // The fixture's span may cross midnight in either zone: compare against the zone's own dates.
      expect(days.map((d) => d.day)).toEqual([...new Set([localDay(day.endMs, tz), localDay(day.startMs, tz)])]);
      expect(days[0]!.end_at).toBe(new Date(day.endMs).toISOString());
      expect(days.at(-1)!.start_at).toBe(new Date(day.startMs).toISOString());
      // Screen chunks only; audio and actions items do not count.
      expect(days.reduce((sum, d) => sum + d.screen_seconds, 0)).toBe(screenSeconds);
    }
    expect(await recordedDays(ACCOUNT, crypto.randomUUID(), { tz: 'UTC' })).toEqual([]);
    expect(await recordedDays(ACCOUNT, MEMBER, { tz: 'UTC', deviceId: crypto.randomUUID() })).toEqual([]);
  });

  test('a frame seeks to frame_index seconds in its 1 fps chunk video, not to its wall-clock offset; without an index, to its position', async () => {
    const rows = Array.from(await db.execute<{ frame_id: string; frame_index: number | null }>(sql`SELECT frame_id, frame_index FROM kortix.timeline_frames WHERE device_id = ${deviceId}::uuid AND frame_index = 2 LIMIT 1`));
    const frameId = rows[0]!.frame_id;
    // The recorder samples every ~2 s, but the chunk video holds frame i at t = i s (capture-format.md).
    await db.execute(sql`UPDATE kortix.timeline_frames f SET ts = c.start_at + interval '4.7 seconds' FROM kortix.timeline_chunks c WHERE f.frame_id = ${frameId}::uuid AND c.chunk_id = f.chunk_id`);
    const found = await frameOf(ACCOUNT, MEMBER, frameId);
    expect(await frameVideoOffsetMs(found!.frame)).toBe(2000);
    await db.execute(sql`UPDATE kortix.timeline_frames SET frame_index = NULL WHERE frame_id = ${frameId}::uuid`);
    const unindexed = await frameOf(ACCOUNT, MEMBER, frameId);
    const [{ n }] = Array.from(await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM kortix.timeline_frames WHERE chunk_id = ${unindexed!.frame.chunk_id as string}::uuid AND ts < ${unindexed!.frame.ts as string}::timestamptz`));
    expect(await frameVideoOffsetMs(unindexed!.frame)).toBe(n * 1000);
    await db.execute(sql`UPDATE kortix.timeline_frames SET frame_index = 2 WHERE frame_id = ${frameId}::uuid`);
  });

  test('the fixture minute is one detected range; activity within 15 minutes grows it, a later session starts another, a bridge merges them', async () => {
    const [only] = await db.select().from(timelineRanges).where(eq(timelineRanges.deviceId, deviceId));
    expect(only).toMatchObject({ source: 'detected', status: 'open' });
    expect(only!.startAt.getTime()).toBe(day.startMs);
    expect(only!.endAt.getTime()).toBe(day.endMs);
    const device = { accountId: ACCOUNT, userId: MEMBER, deviceId };
    const later = new Date(day.endMs + 40 * 60_000);
    await extendDetectedRange(device, later, new Date(later.getTime() + 60_000));
    let ranges = await db.select().from(timelineRanges).where(eq(timelineRanges.deviceId, deviceId)).orderBy(timelineRanges.startAt);
    expect(ranges.length).toBe(2);
    await extendDetectedRange(device, new Date(day.endMs + 10 * 60_000), new Date(later.getTime() - 10 * 60_000));
    ranges = await db.select().from(timelineRanges).where(eq(timelineRanges.deviceId, deviceId));
    expect(ranges.length).toBe(1);
    expect(ranges[0]!.startAt.getTime()).toBe(day.startMs);
    expect(ranges[0]!.endAt.getTime()).toBe(later.getTime() + 60_000);
  });

  test('a changed object, a foreign object key, an unknown device and a newer schema are refused', async () => {
    const base = `${PREFIX}/${deviceId}/2026/01/01/1000-99`;
    const good = new TextEncoder().encode('video');
    objects.set(`${base}.mp4`, good);
    const manifest = (objectsMap: Record<string, unknown>, schema = 2) =>
      new TextEncoder().encode(JSON.stringify({ schema, kind: 'chunk', device_id: deviceId, start_ms: 1000, end_ms: 2000, objects: objectsMap }));
    const info = (key: string, bytes: Uint8Array) => ({ key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });

    objects.set(`${base}.manifest.json`, manifest({ video: { ...info(`${deviceId}/2026/01/01/1000-99.mp4`, good), sha256: 'f'.repeat(64) } }));
    await expect(ingestManifest(`${base}.manifest.json`)).rejects.toThrow('sha256 mismatch');

    objects.set(`${base}.manifest.json`, manifest({ video: info(`${crypto.randomUUID()}/x.mp4`, good) }));
    expect(await ingestManifest(`${base}.manifest.json`)).toEqual({ status: 'ignored', reason: 'object "video" is outside the device folder' });

    objects.set(`${base}.manifest.json`, manifest({ video: info(`${deviceId}/2026/01/01/1000-99.mp4`, good) }, 3));
    expect(await ingestManifest(`${base}.manifest.json`)).toEqual({ status: 'ignored', reason: 'unsupported schema 3' });

    expect((await ingestManifest(`${PREFIX}/${crypto.randomUUID()}/2026/01/01/1-1.manifest.json`)).status).toBe('ignored');
    expect((await ingestManifest('kortix-capture/elsewhere/x.manifest.json')).status).toBe('ignored');
  });

  test('an account with Capture off indexes nothing', async () => {
    await db.update(captureWorkspaces).set({ enabled: false }).where(eq(captureWorkspaces.accountId, ACCOUNT));
    const key = day.manifestKeys[0]!;
    // Forget the item entirely (its lines too), as if it had never been indexed.
    const [gone] = await db.delete(timelineChunks).where(eq(timelineChunks.manifestKey, key)).returning({ chunkId: timelineChunks.chunkId });
    for (const table of ['timeline_frames', 'timeline_actions', 'timeline_audio']) {
      await db.execute(sql`DELETE FROM ${sql.identifier('kortix')}.${sql.identifier(table)} WHERE chunk_id = ${gone!.chunkId}::uuid`);
    }
    expect(await ingestManifest(key)).toEqual({ status: 'skipped', reason: 'capture is off for the account' });
    await db.update(captureWorkspaces).set({ enabled: true }).where(eq(captureWorkspaces.accountId, ACCOUNT));
    expect((await ingestManifest(key)).status).toBe('indexed');
  });
});

describe('ranges and processing', () => {
  test('segmentation rules: gaps fill with idle, input gaps of 2 minutes or more override the model', () => {
    const segments = normalizeSegments(
      [
        { tStart: '0:00', tEnd: '5:00', category: 'coding', title: 'Editing', annotation: 'a', screenshotRefs: [] },
        { tStart: '8:00', tEnd: '10:00', category: 'video', title: 'Watching', annotation: 'b', screenshotRefs: [] },
      ],
      600,
    );
    expect(segments.map((s) => [s.startSec, s.endSec, s.category])).toEqual([
      [0, 300, 'work'],
      [300, 480, 'idle'],
      [480, 600, 'entertainment'],
    ]);
    const idle = computeIdleWindows([10, 20, 200, 590], 600);
    expect(idle).toEqual([[20, 200], [200, 590]]);
    const applied = applyIdleWindows(segments, [[100, 250]], 600);
    // The idle window splits the work block; the model's own idle block stays separate.
    expect(applied.map((s) => [s.startSec, s.endSec, s.category])).toEqual([
      [0, 100, 'work'],
      [100, 250, 'idle'],
      [250, 300, 'work'],
      [300, 480, 'idle'],
      [480, 600, 'entertainment'],
    ]);
  });

  test('a quiet range closes and its three pipelines store their outputs and usage', async () => {
    await db.update(timelineRanges).set({ endAt: sql`now() - interval '1 hour'` }).where(eq(timelineRanges.deviceId, deviceId));
    expect(await closeQuietRanges()).toBeGreaterThanOrEqual(1);
    const [range] = await db.select().from(timelineRanges).where(eq(timelineRanges.deviceId, deviceId));
    expect(range!.status).toBe('closed');

    const prompts: string[] = [];
    const caller = {
      model: 'scripted-model',
      async call(schema: { parse: (v: unknown) => unknown }, prompt: string, _images: unknown[], usage: Record<string, number>) {
        prompts.push(prompt);
        usage.requests += 1;
        usage.prompt_tokens += 100;
        usage.completion_tokens += 10;
        usage.cost_usd += 0.0001;
        if (prompt.includes('TIME-SEGMENTATION')) {
          return schema.parse({ segments: [{ tStart: '0:00', tEnd: '20:00', category: 'work', title: 'Budget work', annotation: 'Edited the sheet' }] });
        }
        if (prompt.includes('ONE short window')) return schema.parse({ narrative: 'Edited Q3 budget.xlsx.', keyPoints: ['Revenue 42,000'], entities: ['Q3 budget.xlsx'] });
        if (prompt.includes('per-segment transcript')) return schema.parse({ title: 'Q3 budget work', summary: 'Edited the budget.' });
        if (prompt.includes('deep annotation engine')) {
          return schema.parse({
            title: 'Budget session', summary: 's', apps: ['Sheets'], entities: [], segments: [{ tStart: '0:00', heading: 'Edit', description: 'Edited the budget sheet for the quarter close.', screenshotRefs: [], confidence: '0.9' }],
            keyMoments: [], sourceOfTruth: { narrative: 'n', keyInsights: [], timelineRef: '' }, dataQuality: { coverage: 'high', gaps: [], confidence: 0.8 },
          });
        }
        if (prompt.includes('CRITIQUE')) return schema.parse({ corrections: [], enrichedSegments: [], enrichedNarrative: 'Better narrative.', qualityScore: 0.7, missingDetails: [] });
        return schema.parse({ files: [{ name: 'Q3 budget.xlsx', operation: 'edit', context: 'quarter close', screenshotRefs: ['1'] }] });
      },
    };
    await processRange(range!.rangeId, caller as never);
    const outputs = await db.select().from(rangeOutputs).where(eq(rangeOutputs.rangeId, range!.rangeId));
    expect(outputs.map((o) => [o.kind, o.status]).sort()).toEqual([['annotation', 'done'], ['segmentation', 'done'], ['transcript', 'done']]);
    const annotation = outputs.find((o) => o.kind === 'annotation')!.output as any;
    expect(annotation.sourceOfTruth.narrative).toBe('Better narrative.');
    expect(annotation.extraction.files[0].screenshotRefs).toEqual([1]);
    expect(outputs.every((o) => (o.usage as any).requests >= 1 && (o.usage as any).cost_usd > 0)).toBe(true);
    const [done] = await db.select().from(timelineRanges).where(eq(timelineRanges.rangeId, range!.rangeId));
    expect(done!.status).toBe('processed');
    expect(done!.title).toBe('Q3 budget work');
    // The timeline the model saw names what was on screen, what was typed, and what was heard.
    const seg = prompts.find((p) => p.includes('TIME-SEGMENTATION'))!;
    expect(seg).toContain('Screen: Editor — Guide — Editor — https://docs.example.org/guide | text: "quarterly roadmap frame 0 sidebar"');
    expect(seg).toContain('Type "quarterly plan"');
    expect(seg).toContain('Heard: "we ship the roadmap on friday"');
    // The action screenshots are the images the model sees.
    expect(seg).toMatch(/\[shot:1\]/);
  });
});

describe('forget', () => {
  test('a delete line retracts the item, its rows and the outputs of overlapping ranges; a re-poll is a no-op', async () => {
    const key = [...objects.keys()].find((k) => k.startsWith(`${PREFIX}/${deviceId}/`) && /\/\d+-1\.manifest\.json$/.test(k))!;
    const [chunk] = await db.select().from(timelineChunks).where(eq(timelineChunks.manifestKey, key));
    const chunkFrames = await count('timeline_frames', sql`chunk_id = ${chunk!.chunkId}::uuid`);
    expect(chunkFrames).toBeGreaterThan(0);
    const framesBefore = await count('timeline_frames');
    const [processed] = await db.select().from(timelineRanges).where(eq(timelineRanges.deviceId, deviceId));
    expect(processed!.status).toBe('processed');
    // What the engine does on `storage forget`: remove the item's objects, then append a delete line.
    const base = key.slice(PREFIX.length + 1, -'.manifest.json'.length);
    for (const k of [...objects.keys()]) if (k.startsWith(`${PREFIX}/${base}.`)) objects.delete(k);
    const indexKey = [...objects.keys()].find((k) => k.startsWith(`${PREFIX}/${deviceId}/index/`))!;
    const line = JSON.stringify({ op: 'delete', kind: 'chunk', base, reason: 'forget', at_ms: Date.now() });
    objects.set(indexKey, new TextEncoder().encode(`${new TextDecoder().decode(objects.get(indexKey)!)}${line}\n`));

    const [device] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    expect(await pollDevice(device!)).toEqual({ enqueued: 0, forgotten: 1 });
    expect(await db.select().from(timelineChunks).where(eq(timelineChunks.manifestKey, key))).toEqual([]);
    expect(await count('timeline_frames')).toBe(framesBefore - chunkFrames);
    const [range] = await db.select().from(timelineRanges).where(eq(timelineRanges.rangeId, processed!.rangeId));
    expect(range!.status).toBe('closed');
    expect(await db.select().from(rangeOutputs).where(eq(rangeOutputs.rangeId, range!.rangeId))).toEqual([]);

    const [again] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    expect(await pollDevice(again!)).toEqual({ enqueued: 0, forgotten: 0 });
  });
});

describe('retention', () => {
  test('items older than remote_days lose their objects first, then their rows', async () => {
    await writeAccountPolicy(ACCOUNT, { ...DEFAULT_POLICY, retention: { local_hours: 0, remote_days: 1 } }, MEMBER);
    // The fixture day is in the past: keep every item but the action segments inside the window.
    await db.execute(sql`UPDATE kortix.timeline_chunks SET end_at = CASE WHEN kind = 'actions' THEN now() - interval '2 days' ELSE now() END WHERE device_id = ${deviceId}::uuid`);
    const actionChunks = await db.select().from(timelineChunks).where(and(eq(timelineChunks.deviceId, deviceId), eq(timelineChunks.kind, 'actions')));
    // Rows keep their real event time; retention deletes them by chunk.
    const removedCount = await applyRetention();
    expect(removedCount).toBe(actionChunks.length);
    expect(removed).toContain(actionChunks[0]!.manifestKey);
    expect(await count('timeline_actions')).toBe(0);
    expect(await count('timeline_frames')).toBeGreaterThan(0);
  });
});
