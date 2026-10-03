import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_POLICY,
  PolicySchema,
  checkManifest,
  liveState,
  manifestKeysFromIndex,
  objectKey,
  parseActionLine,
  parseCaptureKey,
  parseFrameLine,
  policyDocument,
  projectPrefix,
} from './format';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const PREFIX = projectPrefix(ACCOUNT, PROJECT);
const sha = 'a'.repeat(64);

describe('keys', () => {
  test('a Kortix key splits into account, project, device and the rest', () => {
    expect(parseCaptureKey(`${PREFIX}/${DEVICE}/2026/10/03/1-7.manifest.json`)).toEqual({
      accountId: ACCOUNT,
      projectId: PROJECT,
      deviceId: DEVICE,
      rest: '2026/10/03/1-7.manifest.json',
    });
    expect(parseCaptureKey(`${PREFIX}/policy.json`)).toBeNull();
    expect(parseCaptureKey('kortix-capture/x/y.manifest.json')).toBeNull();
  });

  test('a manifest object resolves inside its device folder only', () => {
    expect(objectKey(PREFIX, DEVICE, `${DEVICE}/2026/10/03/1-7.mp4`)).toBe(`${PREFIX}/${DEVICE}/2026/10/03/1-7.mp4`);
    expect(objectKey(PREFIX, DEVICE, `${PREFIX}/${DEVICE}/a.mp4`)).toBe(`${PREFIX}/${DEVICE}/a.mp4`);
    expect(objectKey(PREFIX, DEVICE, 'other-device/a.mp4')).toBeNull();
    expect(objectKey(PREFIX, DEVICE, `${DEVICE}/../other/a.mp4`)).toBeNull();
  });

  test('the index names only complete puts', () => {
    const body = [
      JSON.stringify({ op: 'put', base: `${DEVICE}/2026/10/03/100-1`, manifest: true }),
      JSON.stringify({ op: 'put', kind: 'audio', base: `${DEVICE}/2026/10/03/200-a2`, manifest: true }),
      JSON.stringify({ op: 'put', base: `${DEVICE}/2026/10/03/300-3`, manifest: false }),
      JSON.stringify({ op: 'delete', base: `${DEVICE}/2026/10/03/100-1` }),
      '{torn',
    ].join('\n');
    expect(manifestKeysFromIndex(PREFIX, DEVICE, body)).toEqual([
      `${PREFIX}/${DEVICE}/2026/10/03/100-1.manifest.json`,
      `${PREFIX}/${DEVICE}/2026/10/03/200-a2.manifest.json`,
    ]);
  });
});

describe('manifests', () => {
  const chunk = {
    schema: 2,
    kind: 'chunk',
    device_id: DEVICE,
    start_ms: 1000,
    end_ms: 2000,
    objects: { video: { key: 'v', size: 1, sha256: sha }, frames: { key: 'f', size: 1, sha256: sha } },
    future_field: true,
  };

  test('a schema-2 chunk with unknown fields is accepted', () => {
    expect(checkManifest(chunk, DEVICE).ok).toBe(true);
  });

  test('a newer schema, another device, a missing object or a bad hash is rejected', () => {
    expect(checkManifest({ ...chunk, schema: 3 }, DEVICE)).toEqual({ ok: false, reason: 'unsupported schema 3' });
    expect(checkManifest(chunk, 'other').ok).toBe(false);
    expect(checkManifest({ ...chunk, objects: { frames: chunk.objects.frames } }, DEVICE)).toEqual({
      ok: false,
      reason: 'missing object "video"',
    });
    expect(checkManifest({ ...chunk, objects: { video: { key: 'v', size: 1, sha256: 'x' } } }, DEVICE).ok).toBe(false);
  });
});

describe('lines', () => {
  test('a schema-1 frame line maps app, window, URL and both OCR halves', () => {
    const row = parseFrameLine({
      frame_index: 4,
      ts_ms: 1_791_000_000_000,
      title: 'Q3 budget.xlsx',
      url: 'https://example.test/sheet',
      domain: 'example.test',
      app: { bundle_id: 'com.example.sheets', name: 'Sheets' },
      inactive: false,
      ocr: { foreground: 'Revenue 42', background: 'Inbox', lines: [{ text: 'Revenue 42', x: 1, y: 2, w: 3, h: 4, off: 0, len: 10 }] },
    });
    expect(row).toMatchObject({
      frameIndex: 4,
      app: 'Sheets',
      bundleId: 'com.example.sheets',
      title: 'Q3 budget.xlsx',
      ocrText: 'Revenue 42\nInbox',
      ocrBoxes: [{ text: 'Revenue 42', x: 1, y: 2, w: 3, h: 4 }],
      inactive: false,
    });
    expect(row!.ts.getTime()).toBe(1_791_000_000_000);
    expect(parseFrameLine({ title: 'no time' })).toBeNull();
  });

  test('a schema-2 action line keeps app, window, target and screenshot', () => {
    const row = parseActionLine(
      { ts_ms: 5000, kind: 'click', app: 'Sheets', window: 'Q3 budget.xlsx', target: { x: 0.41, y: 0.2, button: 'left' }, screenshot: `sha256-${sha}.jpg` },
      0,
    );
    expect(row).toEqual({
      ts: new Date(5000),
      kind: 'click',
      app: 'Sheets',
      windowTitle: 'Q3 budget.xlsx',
      description: 'Click left button at 41%,20%',
      target: { x: 0.41, y: 0.2, button: 'left' },
      screenshot: `sha256-${sha}.jpg`,
    });
  });

  test('a schema-1 action line is timed from its segment start; screenshot markers are skipped', () => {
    const row = parseActionLine({ type: 'typewrite', timestamp: 2.5, args: { text: 'invoice 1042' } }, 10_000);
    expect(row?.ts.getTime()).toBe(12_500);
    expect(row?.description).toBe('Type "invoice 1042"');
    expect(parseActionLine({ type: 'screenshot', timestamp: 1, args: {} }, 0)).toBeNull();
  });
});

describe('policy and status', () => {
  test('the default policy keeps audio off and 90 days remote retention', () => {
    expect(DEFAULT_POLICY.layers).toEqual({ screen: true, actions: true, audio: false });
    expect(DEFAULT_POLICY.retention.remote_days).toBe(90);
    expect(PolicySchema.safeParse({ retention: { local_hours: 0, remote_days: -1 } }).success).toBe(false);
  });

  test('policy.json carries schema 2 and the update time', () => {
    expect(JSON.parse(policyDocument(DEFAULT_POLICY, 42))).toMatchObject({ schema: 2, updated_at_ms: 42, notice: '' });
  });

  test('a device is offline when its status is older than 120 s', () => {
    expect(liveState({ recording: 'recording', reportedAtMs: 1_000 }, 100_000)).toBe('recording');
    expect(liveState({ recording: 'recording', reportedAtMs: 1_000 }, 121_001)).toBe('offline');
    expect(liveState(null, 0)).toBe('offline');
  });
});
