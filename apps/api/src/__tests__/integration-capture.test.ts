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

const { accounts, captureDevices, captureEpisodes: captureEpisodesTable, captureWorkspaces, rangeOutputs, timelineChunks, timelineRanges } = await import('@kortix/db');
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
/** A real 2×2 PNG. */
const REAL_PNG = '89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001049444154789c63f8cfc000440c100a001fee03fd8b5f14d40000000049454e44ae426082';

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

    // The vendored screenshots are placeholder bytes. Make one a real PNG: only real images reach the model.
    const shotKeys = [...objects.keys()].filter((k) => k.startsWith(`${PREFIX}/${deviceId}/assets/`) && /\.(jpg|png)$/.test(k) && !k.endsWith('e8bd4e6799e83e494755239d46175b2f1c78b1fea3a94e3a56da068049d22ee1.png'));
    expect(shotKeys.length).toBeGreaterThanOrEqual(2);
    objects.set(shotKeys[0]!, new Uint8Array(Buffer.from(REAL_PNG, 'hex')));
    const prompts: string[] = [];
    const imagesSeen: Array<Array<{ dataUrl: string }>> = [];
    const caller = {
      model: 'scripted-model',
      async call(schema: { parse: (v: unknown) => unknown }, prompt: string, images: Array<{ dataUrl: string }>, usage: Record<string, number>) {
        prompts.push(prompt);
        imagesSeen.push(images);
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
    // The action screenshots are the images the model sees: the real PNG only; a placeholder is skipped.
    expect(seg).toMatch(/\[shot:1\]/);
    expect(seg).not.toMatch(/\[shot:2\]/);
    const sent = imagesSeen.find((list) => list.length > 0)!;
    expect(sent.map((image) => image.dataUrl.slice(0, 22))).toEqual(['data:image/png;base64,']);
  });
});

describe('intelligence: episodes (L1/L2) and mining (L3)', () => {
  const scripted = (answer: (prompt: string) => unknown, prompts: string[] = []) => ({
    model: 'scripted-model',
    async call(schema: { parse: (v: unknown) => unknown }, prompt: string, _images: unknown[], usage: Record<string, number>) {
      prompts.push(prompt);
      usage.requests += 1;
      usage.cost_usd += 0.0002;
      return schema.parse(answer(prompt));
    },
  });

  test('a closed range becomes episodes: literal-free labels, value-only variables, strictly ordered step times; spend recorded; the range reads processed', async () => {
    const { traceRange } = await import('../capture/episodes');
    const { captureEpisodes, captureEpisodeSteps, captureAiUsage } = await import('@kortix/db');
    const [range] = await db.select().from(timelineRanges).where(and(eq(timelineRanges.deviceId, deviceId), eq(timelineRanges.source, 'detected')));
    const prompts: string[] = [];
    const caller = scripted(
      () => ({
        episodes: [
          {
            first: 1, last: 99, label: 'Plan roadmap SO-123456', goal: 'Draft the roadmap for ticket #41234.', outcome: 'Roadmap saved.', outcome_status: 'succeeded', procedural: true,
            steps: [
              { moment: 1, verb: 'Open', app: 'Editor', object: 'roadmap guide', variables: ['roadmap_guide'] },
              { moment: 1, verb: 'Type', app: 'Editor', object: 'plan for order SO-123456', variables: ['Order ID'] },
              { moment: 1, verb: 'Reply', app: 'Editor', object: 'summary', variables: [] },
            ],
          },
        ],
      }),
      prompts,
    );
    const result = await traceRange(range!.rangeId, caller as never);
    expect(result.episodes).toBe(1);
    expect(prompts[0]).toContain('m1 ');
    const [episode] = await db.select().from(captureEpisodes).where(eq(captureEpisodes.deviceId, deviceId));
    expect([episode!.label, episode!.goal, episode!.status, episode!.stepsCount, episode!.signature]).toEqual(['Plan roadmap', 'Draft the roadmap for ticket.', 'traced', 3, 'open@editor fill@editor send@editor']);
    const steps = await db.select().from(captureEpisodeSteps).where(eq(captureEpisodeSteps.episodeId, episode!.episodeId)).orderBy(captureEpisodeSteps.index);
    expect(steps.map((s) => [s.verb, s.object, s.variables])).toEqual([['Open', 'roadmap guide', []], ['Fill', 'plan for order', ['order_id']], ['Send', 'summary', []]]);
    const times = steps.map((s) => s.ts.getTime());
    expect(new Set(times).size).toBe(3);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const [usage] = await db.select().from(captureAiUsage).where(eq(captureAiUsage.accountId, ACCOUNT));
    expect(Number(usage!.costUsd)).toBeGreaterThan(0);
    const [after] = await db.select().from(timelineRanges).where(eq(timelineRanges.rangeId, range!.rangeId));
    expect(after!.status).toBe('processed');
    // A re-run replaces the range's detected episodes instead of adding to them.
    await traceRange(range!.rangeId, caller as never);
    expect((await db.select().from(captureEpisodes).where(eq(captureEpisodes.deviceId, deviceId))).length).toBe(1);
  });

  test('mining: clusters need 3 finished runs; an abandoned run joins the workflow it started; names are unique; identities and reviews survive a re-mine; runIntelligence queues ranges', async () => {
    const { mineAccount } = await import('../capture/mining');
    const { runIntelligence } = await import('../capture/workers');
    const { captureEpisodes, captureEpisodeSteps, captureWorkflows } = await import('@kortix/db');
    const now = Date.now();
    const OTHER = crypto.randomUUID();
    const add = async (i: number, userId: string, label: string, path: Array<[string, string, string]>, outcomeStatus = 'succeeded') => {
      const start = new Date(now - (i + 1) * 3_600_000);
      const [e] = await db
        .insert(captureEpisodes)
        .values({ accountId: ACCOUNT, userId, deviceId, startAt: start, endAt: new Date(start.getTime() + 300_000), label, status: 'traced', outcomeStatus, stepsCount: path.length, signature: path.map(([v, a]) => `${v.toLowerCase()}@${a.toLowerCase()}`).join(' ') })
        .returning();
      await db.insert(captureEpisodeSteps).values(path.map(([verb, app, object], index) => ({ episodeId: e!.episodeId, accountId: ACCOUNT, index, ts: new Date(start.getTime() + index * 1000), verb, app, object, variables: [] })));
      return e!.episodeId;
    };
    const refund: Array<[string, string, string]> = [['Open', 'Helpdesk', 'damaged ticket'], ['Search', 'ERP', 'order by number'], ['Create', 'ERP', 'refund'], ['Send', 'Mail', 'refund confirmation']];
    const invoice: Array<[string, string, string]> = [['Download', 'Mail', 'invoice attachment'], ['Match', 'ERP', 'invoice to purchase order'], ['Approve', 'Billing', 'invoice payment']];
    for (let i = 0; i < 4; i++) await add(i, i % 2 ? MEMBER : OTHER, 'Refund a damaged order', refund);
    for (let i = 4; i < 7; i++) await add(i, MEMBER, 'Approve a supplier invoice', invoice);
    const abandoned = await add(8, MEMBER, 'Refund a damaged order', refund.slice(0, 2), 'abandoned');
    const lonely = await add(9, MEMBER, 'Book travel', [['Open', 'Browser', 'travel site'], ['Create', 'Browser', 'booking']]);
    const caller = scripted((prompt) => (prompt.includes('Each pair shows') ? { same: [] } : { name: 'Process a request', goal: 'Handle it.', outcome: 'Done.', variants: [] }));
    const first = await mineAccount(ACCOUNT, caller as never, now);
    expect(first.workflows).toBe(2);
    const rows = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, ACCOUNT)).orderBy(captureWorkflows.runsTotal);
    expect(rows.map((w) => [w.name, w.runsTotal, w.peopleCount])).toEqual([['Process a request (2)', 3, 1], ['Process a request', 5, 2]]);
    const [joined] = await db.select().from(captureEpisodes).where(eq(captureEpisodes.episodeId, abandoned));
    expect(joined!.workflowId).toBe(rows[1]!.workflowId);
    const [alone] = await db.select().from(captureEpisodes).where(eq(captureEpisodes.episodeId, lonely));
    expect(alone!.workflowId).toBeNull();
    // A person reviews one; a re-mine keeps both identities and the reviewed name.
    await db.update(captureWorkflows).set({ name: 'Refund a damaged order', status: 'reviewed' }).where(eq(captureWorkflows.workflowId, rows[1]!.workflowId));
    await mineAccount(ACCOUNT, caller as never, now);
    const again = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, ACCOUNT)).orderBy(captureWorkflows.runsTotal);
    expect(again.map((w) => [w.workflowId, w.name, w.status])).toEqual([[rows[0]!.workflowId, 'Process a request (2)', 'detected'], [rows[1]!.workflowId, 'Refund a damaged order', 'reviewed']]);
    // The admin "run" queues every closed detected range, then mining.
    await db.update(timelineRanges).set({ status: 'closed' }).where(and(eq(timelineRanges.deviceId, deviceId), eq(timelineRanges.source, 'detected')));
    const run = await runIntelligence(ACCOUNT);
    expect(run.episodes_queued).toBeGreaterThanOrEqual(1);
    expect(run.mining_queued).toBe(true);
    expect((await runIntelligence(ACCOUNT, { miningOnly: true })).episodes_queued).toBe(0);
    await db.update(timelineRanges).set({ status: 'processed' }).where(and(eq(timelineRanges.deviceId, deviceId), eq(timelineRanges.source, 'detected')));
  });

  test('a Parquet export is one table, one column per field, that reads back row for row', async () => {
    const { exportParquet } = await import('../capture/exports');
    const { captureWorkflows } = await import('@kortix/db');
    const hyparquet = await import(Bun.resolveSync('hyparquet', Bun.resolveSync('hyparquet-writer', import.meta.dir)));
    const built = await exportParquet(ACCOUNT, { include: ['workflows'] });
    expect(new TextDecoder().decode(built.body.slice(0, 4))).toBe('PAR1');
    const rows = (await hyparquet.parquetReadObjects({ file: built.body.buffer.slice(built.body.byteOffset, built.body.byteOffset + built.body.byteLength) })) as Array<Record<string, unknown>>;
    const workflows = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, ACCOUNT));
    expect(built.table).toBe('workflows');
    expect(rows.map((r) => r.name).sort()).toEqual(workflows.map((w) => w.name).sort());
    expect(typeof rows[0]!.runs_total).toBe('number');
    expect(Array.isArray(rows[0]!.steps)).toBe(true);
    const episodes = await exportParquet(ACCOUNT, {});
    expect(episodes.table).toBe('episodes');
    expect(episodes.rows).toBeGreaterThan(0);
  });

  test('Ask is a tool-calling agent: it calls a tool in the asker\'s scope, gets numbered sources, and answers with citations; a member\'s tools see only the member', async () => {
    const { ask, runTool } = await import('../capture/ask');
    const bodies: Array<Record<string, any>> = [];
    const sse = (frames: unknown[]) => new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    const transport = async (body: Record<string, unknown>) => {
      bodies.push(body);
      if (bodies.length === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_workflows', arguments: '{"sort":"runs"}' } }] } }] }, { usage: { cost: 0.0001 } }]);
      const tool = JSON.parse(String((body.messages as Array<{ role: string; content: string }>).at(-1)!.content)) as Array<{ source: number; name: string }>;
      return sse([{ choices: [{ delta: { content: `${tool[0]!.name} runs most [${tool[0]!.source}].` } }] }, { usage: { cost: 0.0002 } }]);
    };
    const events: Array<Record<string, any>> = [];
    await ask({ accountId: ACCOUNT, viewer: MEMBER, subject: null, accountWide: true }, { question: 'Which workflow runs most?' }, (e) => events.push(e), transport);
    expect(events.map((e) => e.type)).toEqual(['sources', 'tool', 'sources', 'delta', 'done']);
    expect(bodies[0]!.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['search_moments', 'list_episodes', 'get_episode', 'list_workflows', 'get_workflow', 'stats']);
    expect(bodies[1]!.messages.at(-1).role).toBe('tool');
    const done = events.at(-1)!;
    expect(done.citations.length).toBe(1);
    expect(done.citations[0].kind).toBe('workflow');
    expect(done.answer).toContain(`[${done.citations[0].n}]`);
    expect(done.cost_usd).toBeCloseTo(0.0003);
    // A member's agent has no workflow tools, and its episode tool reads the member only.
    const memberScope = { accountId: ACCOUNT, viewer: MEMBER, subject: MEMBER, accountWide: false };
    expect(await runTool(memberScope, 'list_workflows', {}, (x) => ({ ...x, n: 0 }) as never)).toEqual({ error: 'workflows and stats are for Capture admins and viewers' });
    const listed = (await runTool(memberScope, 'list_episodes', { user_id: crypto.randomUUID() }, (x) => ({ ...x, n: 1 }) as never)) as Array<{ episode_id: string }>;
    const owners = await db.select({ userId: captureEpisodesTable.userId }).from(captureEpisodesTable).where(sql`${captureEpisodesTable.episodeId} IN (${sql.join(listed.map((e) => sql`${e.episode_id}::uuid`), sql`, `)})`);
    expect(listed.length).toBeGreaterThan(0);
    expect(owners.every((o) => o.userId === MEMBER)).toBe(true);
    expect((listed as unknown as Array<{ person: unknown }>).every((e) => e.person === 'you')).toBe(true);

    // An admin's tools name people from the account's member directory; an id outside it is no one's name.
    const { accountMemberships, captureWorkflows } = await import('@kortix/db');
    await db.execute(sql`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (${MEMBER}::uuid, ${`member-${MEMBER.slice(0, 8)}@example.test`}, ${JSON.stringify({ full_name: 'Synthetic Member' })}::jsonb) ON CONFLICT (id) DO NOTHING`);
    await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: MEMBER }).onConflictDoNothing();
    const [refund] = await db.select().from(captureWorkflows).where(and(eq(captureWorkflows.accountId, ACCOUNT), sql`${captureWorkflows.peopleCount} = 2`));
    const adminScope = { accountId: ACCOUNT, viewer: MEMBER, subject: null, accountWide: true };
    const detail = (await runTool(adminScope, 'get_workflow', { workflow_id: refund!.workflowId }, (x) => ({ ...x, n: 1 }) as never)) as { people: Array<{ user_id: string; name: string; email: string | null }> };
    const named = detail.people.find((p) => p.user_id === MEMBER)!;
    expect([named.name, named.email]).toEqual(['Synthetic Member', `member-${MEMBER.slice(0, 8)}@example.test`]);
    expect(detail.people.find((p) => p.user_id !== MEMBER)!.name).toBe('A former member');
  });
});

describe('forget', () => {
  test('a delete line retracts the item, its rows, the outputs and detected episodes of overlapping ranges (queued to trace again); a re-poll is a no-op', async () => {
    const { captureEpisodes } = await import('@kortix/db');
    const { jobQueue } = await import('@kortix/db');
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
    const left = await db.select().from(captureEpisodes).where(and(eq(captureEpisodes.deviceId, deviceId), eq(captureEpisodes.source, 'detected'), sql`${captureEpisodes.startAt} <= ${range!.endAt.toISOString()}::timestamptz`));
    expect(left.filter((e) => e.endAt >= range!.startAt && e.label === 'Plan roadmap')).toEqual([]);
    const queued = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, 'capture.episodes'), sql`${jobQueue.jobKey} LIKE ${`${range!.rangeId}:%:forget-%`}`));
    expect(queued.length).toBe(1);

    const [again] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    expect(await pollDevice(again!)).toEqual({ enqueued: 0, forgotten: 0 });
  });
});

describe('forget reaches every derived artifact', () => {
  test('a forgotten item\'s unique marker appears nowhere afterwards: episodes, steps, workflows, exports (old and new), Ask sources', async () => {
    const { traceRange } = await import('../capture/episodes');
    const { mineAccount } = await import('../capture/mining');
    const { exportJsonl } = await import('../capture/exports');
    const { retrieve } = await import('../capture/ask');
    const { captureEpisodes, captureEpisodeSteps, captureExports, captureWorkflows } = await import('@kortix/db');
    const MARK = 'Zebraquartz';
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const enc = (t: string) => new TextEncoder().encode(t);
    // One small item on an old day whose screen shows the marker, written as the engine writes it.
    const start = Date.UTC(2026, 8, 1, 10);
    const base = `${deviceId}/2026/09/01/${start}-900`;
    const lines = [0, 1, 2].map((i) => JSON.stringify({ app: { bundle_id: 'com.example.billing', name: 'Billing' }, frame_index: i, ts_ms: start + i * 10_000, title: `${MARK} invoice — Billing`, ocr: { foreground: `${MARK} invoice review`, background: '', lines: [] }, windows: [] }));
    const frames = Bun.zstdCompressSync(enc(`${lines.join('\n')}\n`));
    const video = enc('video-bytes');
    const info = (key: string, body: Uint8Array) => ({ key, size: body.byteLength, sha256: sha(body), plain_size: body.byteLength, plain_sha256: sha(body) });
    const manifest = { app_version: '0.1.0', created_at_ms: start + 40_000, device_id: deviceId, encryption: null, end_ms: start + 30_000, frame_count: 3, height: 360, kind: 'chunk', objects: { frames: info(`${base}.frames.jsonl.zst`, frames), video: info(`${base}.mp4`, video) }, privacy: { mode: 'off', redact_pii: false }, schema: 2, start_ms: start, video_id: 900, video_name: `${start}.mp4`, width: 640 };
    const manifestKey = `${PREFIX}/${base}.manifest.json`;
    objects.set(`${PREFIX}/${base}.frames.jsonl.zst`, frames);
    objects.set(`${PREFIX}/${base}.mp4`, video);
    objects.set(manifestKey, enc(JSON.stringify(manifest)));
    const indexKey = `${PREFIX}/${deviceId}/index/2026-09-01.jsonl`;
    objects.set(indexKey, enc(`${JSON.stringify({ op: 'put', kind: 'chunk', base, start_ms: start, end_ms: start + 30_000, manifest: true, at_ms: start + 41_000, frames: 3, video_id: 900 })}\n`));
    expect((await ingestManifest(manifestKey)).status).toBe('indexed');
    const [range] = await db.select().from(timelineRanges).where(and(eq(timelineRanges.deviceId, deviceId), sql`${timelineRanges.startAt} = ${new Date(start).toISOString()}::timestamptz`));
    await db.update(timelineRanges).set({ status: 'closed' }).where(eq(timelineRanges.rangeId, range!.rangeId));

    // The model echoes the marker everywhere it can: label, goal, step objects, workflow name.
    const echo = (prompt: string) => (prompt.includes(MARK) ? MARK : 'plain');
    const caller = {
      model: 'scripted-model',
      async call(schema: { parse: (v: unknown) => unknown }, prompt: string, _images: unknown[], usage: Record<string, number>) {
        usage.requests += 1;
        if (prompt.includes('Each pair shows')) return schema.parse({ same: [] });
        if (prompt.includes('Name the procedure')) return schema.parse({ name: `Review ${echo(prompt)} invoices`, goal: `Check ${echo(prompt)} invoices.`, outcome: 'Approved.', variants: [] });
        return schema.parse({ episodes: [{ first: 1, last: 9, label: `Review ${MARK} invoice`, goal: `Review the ${MARK} invoice.`, outcome: 'Approved.', outcome_status: 'succeeded', procedural: true, steps: [
          { moment: 1, verb: 'Open', app: 'Billing', object: `${MARK} invoice`, variables: ['invoice_id'] },
          { moment: 1, verb: 'Read', app: 'Billing', object: 'invoice lines', variables: [] },
          { moment: 1, verb: 'Approve', app: 'Billing', object: 'invoice payment', variables: [] },
        ] }] });
      },
    };
    await traceRange(range!.rangeId, caller as never);
    // Three more runs of the same procedure on other days, with no marker: the workflow outlives the forget.
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.UTC(2026, 8, 2 + i, 10));
      const [e] = await db.insert(captureEpisodes).values({ accountId: ACCOUNT, userId: MEMBER, deviceId, startAt: at, endAt: new Date(at.getTime() + 300_000), label: 'Approve an invoice', goal: 'Approve a supplier invoice.', status: 'traced', outcomeStatus: 'succeeded', stepsCount: 3, signature: 'open@billing read@billing approve@billing' }).returning();
      await db.insert(captureEpisodeSteps).values([['Open', 'invoice'], ['Read', 'invoice lines'], ['Approve', 'invoice payment']].map(([verb, object], index) => ({ episodeId: e!.episodeId, accountId: ACCOUNT, index, ts: new Date(at.getTime() + index * 1000), verb: verb!, app: 'Billing', object: object!, variables: [] })));
    }
    const workflowsBefore = (await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, ACCOUNT))).map((w) => w.workflowId);
    await mineAccount(ACCOUNT, caller as never, Date.UTC(2026, 8, 10));
    const hits = async () => {
      const q = (table: string) => sql`SELECT count(*)::int AS n FROM ${sql.identifier('kortix')}.${sql.identifier(table)} t WHERE account_id = ${ACCOUNT}::uuid AND row_to_json(t)::text ILIKE ${`%${MARK}%`}`;
      const n = async (table: string) => Array.from(await db.execute<{ n: number }>(q(table)))[0]!.n;
      return { episodes: await n('capture_episodes'), steps: await n('capture_episode_steps'), workflows: await n('capture_workflows') };
    };
    const before = await hits();
    expect(before.episodes).toBeGreaterThan(0);
    expect(before.steps).toBeGreaterThan(0);
    expect(before.workflows).toBeGreaterThan(0);
    // An export taken before the forget holds the marker.
    const old = await exportJsonl(ACCOUNT, {});
    expect(old.body).toContain(MARK);
    const oldKey = `${PREFIX}/exports/forget-test.jsonl`;
    objects.set(oldKey, enc(old.body));
    const [exp] = await db.insert(captureExports).values({ accountId: ACCOUNT, requestedBy: MEMBER, format: 'jsonl', status: 'done', objectKey: oldKey, rows: old.rows }).returning();

    // The engine forgets the item: objects deleted, a delete line appended; the reader retracts it.
    for (const k of [...objects.keys()]) if (k.startsWith(`${PREFIX}/${base}.`)) objects.delete(k);
    objects.set(indexKey, enc(`${new TextDecoder().decode(objects.get(indexKey)!)}${JSON.stringify({ op: 'delete', kind: 'chunk', base, reason: 'forget', at_ms: Date.now() })}\n`));
    const [device] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, deviceId));
    expect((await pollDevice(device!)).forgotten).toBe(1);

    expect(await hits()).toEqual({ episodes: 0, steps: 0, workflows: 0 });
    // The workflow rebuilt from its 3 remaining runs: same identity, their label, their steps.
    const after = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, ACCOUNT));
    const kept = after.find((w) => !workflowsBefore.includes(w.workflowId))!;
    expect([kept.name, kept.runsTotal, (kept.steps as Array<{ object: string }>).map((s) => s.object)]).toEqual(['Approve an invoice', 3, ['invoice', 'invoice lines', 'invoice payment']]);
    const [expired] = await db.select().from(captureExports).where(eq(captureExports.exportId, exp!.exportId));
    expect([expired!.status, expired!.objectKey, objects.has(oldKey)]).toEqual(['failed', null, false]);
    expect((await exportJsonl(ACCOUNT, {})).body).not.toContain(MARK);
    const sources = await retrieve(ACCOUNT, null, true, { question: `What happened with ${MARK} invoices?`, scope: { from: '2026-08-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } });
    expect(JSON.stringify(sources)).not.toContain(MARK);
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
