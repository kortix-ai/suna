/**
 * The reader side of the Kortix Capture format against the engine's own
 * contract: the JSON Schemas and fixture bucket vendored, pinned, in
 * tests/fixtures/capture-format-v2 (see SOURCE.json).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import {
  DEFAULT_POLICY,
  PolicySchema,
  accountPrefix,
  checkManifest,
  jsonLines,
  liveState,
  foldIndex,
  objectKey,
  parseActionLine,
  parseCaptureKey,
  parseFrameLine,
  policyDocument,
} from './format';

const CONTRACT = join(import.meta.dir, '../../../../tests/fixtures/capture-format-v2');
const FIXTURE_DEVICE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const DAY = join(CONTRACT, 'bucket/fixture-prefix', FIXTURE_DEVICE, '2026/10/01');
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const file of readdirSync(join(CONTRACT, 'schemas'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(CONTRACT, 'schemas', file), 'utf8')), file.replace(/\.schema\.json$/, ''));
}
const conforms = (name: string, value: unknown) => {
  const validate = ajv.getSchema(name)!;
  expect(validate(value) ? null : ajv.errorsText(validate.errors)).toBeNull();
};
const json = (file: string) => JSON.parse(readFileSync(join(DAY, file), 'utf8'));
const lines = (file: string) => jsonLines(new TextDecoder().decode(Bun.zstdDecompressSync(readFileSync(join(DAY, file)))));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const PREFIX = accountPrefix(ACCOUNT);

describe('the vendored fixture bucket', () => {
  test('every fixture object matches its schema (the contract Kortix reads)', () => {
    conforms('manifest-chunk', json('1790845200000-1.manifest.json'));
    conforms('manifest-actions', json('1790845201000-x1.manifest.json'));
    conforms('manifest-audio', json('1790845205000-a1.manifest.json'));
    for (const line of lines('1790845200000-1.frames.jsonl.zst')) conforms('frames-line', line);
    for (const line of lines('1790845201000-x1.actions.jsonl.zst')) conforms('actions-line', line);
    const device = join(CONTRACT, 'bucket/fixture-prefix', FIXTURE_DEVICE);
    conforms('device', JSON.parse(readFileSync(join(device, 'device.json'), 'utf8')));
    conforms('status', JSON.parse(readFileSync(join(device, 'status.json'), 'utf8')));
    conforms('policy', JSON.parse(readFileSync(join(CONTRACT, 'bucket/fixture-prefix/policy.json'), 'utf8')));
    conforms('policy', JSON.parse(readFileSync(join(device, 'policy.json'), 'utf8')));
  });

  test('each manifest checks out for its device; another schema or device is refused', () => {
    for (const file of ['1790845200000-1.manifest.json', '1790845201000-x1.manifest.json', '1790845205000-a1.manifest.json']) {
      expect(checkManifest(json(file), FIXTURE_DEVICE).ok).toBe(true);
    }
    const chunk = json('1790845200000-1.manifest.json');
    expect(checkManifest({ ...chunk, schema: 3 }, FIXTURE_DEVICE)).toEqual({ ok: false, reason: 'unsupported schema 3' });
    expect(checkManifest({ ...chunk, schema: 1 }, FIXTURE_DEVICE)).toEqual({ ok: false, reason: 'unsupported schema 1' });
    expect(checkManifest(chunk, 'another-device').ok).toBe(false);
    expect(checkManifest({ ...chunk, objects: { frames: chunk.objects.frames } }, FIXTURE_DEVICE)).toEqual({ ok: false, reason: 'missing object "video"' });
  });

  test('a frame line maps app, window, URL, both OCR halves and the boxes', () => {
    const row = parseFrameLine(lines('1790845200000-1.frames.jsonl.zst')[0]!)!;
    expect(row).toMatchObject({
      frameIndex: 0,
      app: 'Editor',
      bundleId: 'com.example.editor',
      title: 'Guide — Editor',
      url: 'https://docs.example.org/guide',
      domain: 'docs.example.org',
      ocrText: 'quarterly roadmap frame 0\nsidebar',
      ocrBoxes: [{ text: 'quarterly roadmap frame 0', x: 10, y: 20, w: 300, h: 18 }],
      inactive: false,
    });
    expect(row.ts.getTime()).toBe(1790845200000);
    expect(parseFrameLine({ title: 'no time' })).toBeNull();
  });

  test('action lines keep clicks, typing, hotkeys and the screenshot events that carry an asset', () => {
    const rows = lines('1790845201000-x1.actions.jsonl.zst').map(parseActionLine);
    expect(rows.every((r) => r !== null)).toBe(true);
    expect(rows.map((r) => r!.description)).toEqual([
      'Click left button at 50%,50%', 'Screenshot', 'Click left button at 50%,50%', 'Screenshot',
      'Click left button at 50%,50%', 'Screenshot', 'Type "quarterly plan"', 'Hotkey command+s',
    ]);
    expect(rows[1]).toMatchObject({ kind: 'screenshot', app: 'Editor', windowTitle: 'Guide — Editor', screenshot: expect.stringMatching(/^sha256-[0-9a-f]{64}\.jpg$/) });
    expect(parseActionLine({ kind: 'screenshot', ts_ms: 1, screenshot: null })).toBeNull();
    expect(parseActionLine({ type: 'click', timestamp: 1.5 })).toBeNull();
  });
});

describe('keys and index', () => {
  test('a Kortix key orgs/<account>/<device>/… splits into account, device and the rest; no project in the layout', () => {
    expect(PREFIX).toBe(`orgs/${ACCOUNT}`);
    expect(parseCaptureKey(`${PREFIX}/${DEVICE}/2026/10/03/1-7.manifest.json`)).toEqual({ accountId: ACCOUNT, deviceId: DEVICE, rest: '2026/10/03/1-7.manifest.json' });
    expect(parseCaptureKey(`${PREFIX}/policy.json`)).toBeNull();
    // The retired project layout is not a Kortix key.
    expect(parseCaptureKey(`${PREFIX}/projects/22222222-2222-4222-8222-222222222222/${DEVICE}/a.manifest.json`)).toBeNull();
    expect(parseCaptureKey(`fixture-prefix/${FIXTURE_DEVICE}/x.manifest.json`)).toBeNull();
  });

  test('a manifest object resolves inside its device folder only', () => {
    expect(objectKey(PREFIX, DEVICE, `${DEVICE}/2026/10/03/1-7.mp4`)).toBe(`${PREFIX}/${DEVICE}/2026/10/03/1-7.mp4`);
    expect(objectKey(PREFIX, DEVICE, `${PREFIX}/${DEVICE}/a.mp4`)).toBe(`${PREFIX}/${DEVICE}/a.mp4`);
    expect(objectKey(PREFIX, DEVICE, 'other-device/a.mp4')).toBeNull();
    expect(objectKey(PREFIX, DEVICE, `${DEVICE}/../other/a.mp4`)).toBeNull();
  });

  test('schema-valid index lines fold to live manifests; a delete retracts its item until a later put', () => {
    const base = (id: string) => `${DEVICE}/2026/10/01/${id}`;
    const index = [
      { op: 'put', kind: 'chunk', base: base('1790845200000-1'), start_ms: 1790845200000, end_ms: 1790845204000, manifest: true, at_ms: 1 },
      { op: 'put', kind: 'audio', base: base('1790845205000-a1'), start_ms: 1790845205000, end_ms: 1790845265000, manifest: true },
      { op: 'put', kind: 'actions', base: base('1790845201000-x1'), start_ms: 1790845201000, end_ms: 1790845213000, manifest: false },
      { op: 'put', kind: 'chunk', base: base('1790845260000-2'), start_ms: 1790845260000, end_ms: 1790845264000, manifest: true, at_ms: 2 },
      { op: 'delete', kind: 'chunk', base: base('1790845200000-1'), reason: 'forget', at_ms: 3 },
      { op: 'delete', kind: 'chunk', base: base('1790845260000-2'), reason: 'retention', at_ms: 4 },
      { op: 'put', kind: 'chunk', base: base('1790845260000-2'), start_ms: 1790845260000, end_ms: 1790845264000, manifest: true, at_ms: 5 },
      { op: 'delete', kind: 'chunk', base: `other-device/2026/10/01/1-1`, reason: 'forget', at_ms: 6 },
    ];
    for (const line of index.slice(0, 7)) conforms('index-line', line);
    const body = [...index.map((l) => JSON.stringify(l)), '{torn'].join('\n');
    const key = (id: string) => `${PREFIX}/${base(id)}.manifest.json`;
    expect(foldIndex(PREFIX, DEVICE, body)).toEqual({
      live: [key('1790845205000-a1'), key('1790845260000-2')],
      deleted: [key('1790845200000-1')],
    });
  });
});

describe('policy and status', () => {
  test('the policy.json Kortix writes matches the policy schema, default and full', () => {
    conforms('policy', JSON.parse(policyDocument(DEFAULT_POLICY, 42)));
    const full = PolicySchema.parse({
      layers: { screen: true, actions: false, audio: true },
      privacy: { redact_pii: true },
      retention: { local_hours: 24, remote_days: 30 },
      recording: { paused: true, paused_until_ms: 1790848800000 },
      notice: 'Recording is on for the support team.',
    });
    conforms('policy', JSON.parse(policyDocument(full, 1790845200000)));
    expect(DEFAULT_POLICY.layers).toEqual({ screen: true, actions: true, audio: false });
    expect(PolicySchema.safeParse({ retention: { local_hours: 0, remote_days: -1 } }).success).toBe(false);
  });

  test('a device is offline when its status is older than 120 s', () => {
    expect(liveState({ recording: 'recording', reportedAtMs: 1_000 }, 100_000)).toBe('recording');
    expect(liveState({ recording: 'recording', reportedAtMs: 1_000 }, 121_001)).toBe('offline');
    expect(liveState(null, 0)).toBe('offline');
  });
});
