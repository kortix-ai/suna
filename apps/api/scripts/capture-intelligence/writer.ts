/**
 * Turn synthetic activity into the objects the Kortix Capture engine writes
 * (schema 2): screen chunks (frames JSONL + video + manifest), action segments
 * (actions JSONL + screenshot assets + manifest), daily index lines, device.json
 * and status.json. Every object is validated against the vendored JSON Schemas.
 */
import { createHash } from 'node:crypto';
import { captureSchemaErrors, type CaptureObject, type CaptureSchemaName } from '../../../../tests/src/fixtures/capture';
import type { Activity } from './synthetic';
import { renderChunkVideo, VIDEO_HEIGHT, VIDEO_WIDTH } from './video';
/** A real 160×100 JPEG (synthetic stripes): the screenshot of every screenshot action. */
const SHOT = new Uint8Array(Buffer.from('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', 'base64'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const SHOT_NAME = `sha256-${sha(SHOT)}.jpg`;
const enc = (text: string) => new TextEncoder().encode(text);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function check(name: CaptureSchemaName, value: unknown) {
  const errors = captureSchemaErrors(name, value);
  if (errors) throw new Error(`${name}: ${errors}`);
}

const info = (key: string, body: Uint8Array) => ({ key, size: body.byteLength, sha256: sha(body), plain_size: body.byteLength, plain_sha256: sha(body) });

/** Groups of consecutive items: a new group after `gapMs` of silence or `max` items. */
function groups<T extends { ts: number }>(items: T[], gapMs: number, max: number): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.length < max && item.ts - last[last.length - 1]!.ts <= gapMs) last.push(item);
    else out.push([item]);
  }
  return out;
}

export async function deviceObjects(input: { prefix: string; deviceId: string; machineKey: string; name: string; activity: Activity[] }) {
  const { prefix, deviceId } = input;
  const activity = [...input.activity].sort((a, b) => a.ts - b.ts);
  const data: CaptureObject[] = [];
  const manifests: CaptureObject[] = [];
  const index = new Map<string, string[]>();
  const addIndex = (line: Record<string, unknown>, start: number) => {
    check('index-line', line);
    index.set(ymd(start), [...(index.get(ymd(start)) ?? []), JSON.stringify(line)]);
  };
  let id = 0;
  // Screen chunks: up to 12 frames, split on 30 s without a frame. Videos render 8 at a time.
  const screenChunks = groups(activity.filter((a) => !a.action), 30_000, 12);
  const videos: Uint8Array[] = [];
  for (let i = 0; i < screenChunks.length; i += 8) videos.push(...(await Promise.all(screenChunks.slice(i, i + 8).map((c) => renderChunkVideo(c)))));
  for (const [ci, chunk] of screenChunks.entries()) {
    const VIDEO = videos[ci]!;
    id++;
    const start = chunk[0]!.ts;
    const end = chunk[chunk.length - 1]!.ts + 1_000;
    const base = `${deviceId}/${ymd(start).replaceAll('-', '/')}/${start}-${id}`;
    const lines = chunk.map((f, i) => {
      const line = {
        app: { bundle_id: `com.example.${f.app.toLowerCase()}`, icon: null, is_user_app: true, name: f.app, version: '1.0' },
        capture_reason: 'interval', dhash: 'abcd', display: { h: VIDEO_HEIGHT, w: VIDEO_WIDTH, x: 0, y: 0 }, domain: null, domain_icon: null,
        frame_index: i, height: VIDEO_HEIGHT, image_hash: null, inactive: false,
        ocr: { background: '', foreground: f.text, lines: [{ h: 18, len: f.text.length, off: 0, text: f.text, w: 600, x: 10, y: 20 }] },
        pii_redacted: false, segment: id, title: f.title, ts_ms: f.ts, url: null, width: VIDEO_WIDTH,
        windows: [{ app: `com.example.${f.app.toLowerCase()}`, app_name: f.app, focused: true, h: VIDEO_HEIGHT, layer: 0, title: f.title, url: null, w: VIDEO_WIDTH, x: 0, y: 0, z: 0 }],
      };
      check('frames-line', line);
      return JSON.stringify(line);
    });
    const frames = Bun.zstdCompressSync(enc(`${lines.join('\n')}\n`));
    const fKey = `${base}.frames.jsonl.zst`;
    const vKey = `${base}.mp4`;
    data.push({ key: `${prefix}/${fKey}`, body: frames, contentType: 'application/zstd' }, { key: `${prefix}/${vKey}`, body: VIDEO, contentType: 'video/mp4' });
    const manifest = { app_version: '0.1.0', created_at_ms: end + 2_000, device_id: deviceId, encryption: null, end_ms: end, frame_count: chunk.length, height: VIDEO_HEIGHT, kind: 'chunk', objects: { frames: info(fKey, frames), video: info(vKey, VIDEO) }, privacy: { mode: 'off', redact_pii: false }, schema: 2, start_ms: start, video_id: id, video_name: `${start}.mp4`, width: VIDEO_WIDTH };
    check('manifest-chunk', manifest);
    manifests.push({ key: `${prefix}/${base}.manifest.json`, body: enc(JSON.stringify(manifest)), contentType: 'application/json' });
    addIndex({ op: 'put', kind: 'chunk', base, start_ms: start, end_ms: end, manifest: true, at_ms: end + 3_000, frames: chunk.length, video_id: id }, start);
  }
  // Action segments: split on 2 minutes without an action, at most 60 events.
  let shots = false;
  for (const seg of groups(activity.filter((a) => a.action), 120_000, 60)) {
    id++;
    const start = seg[0]!.ts;
    const end = seg[seg.length - 1]!.ts;
    const base = `${deviceId}/${ymd(start).replaceAll('-', '/')}/${start}-x${id}`;
    const lines = seg.map((a) => {
      const kind = a.action!.kind;
      const line = {
        app: { bundle_id: `com.example.${a.app.toLowerCase()}`, name: a.app },
        args: kind === 'click' ? { button: 'left', clicks: 1, modifiers: [], x: 0.5, y: 0.4 } : kind === 'typewrite' ? { text: a.action!.text } : kind === 'hotkey' ? { keys: (a.action!.text ?? '').split('+') } : { height: 100, width: 160 },
        command: kind === 'typewrite' ? `typewrite('${a.action!.text}')` : '',
        kind, screenshot: kind === 'screenshot' ? SHOT_NAME : null,
        ...(kind === 'screenshot' ? { displays: [{ display_id: 1, height: 100, screenshot: SHOT_NAME, width: 160, x: 0, y: 0 }] } : {}),
        start_ms: a.ts - 100,
        target: kind === 'click' && a.action!.text ? { name: a.action!.text, role: 'button' } : null,
        ts_ms: a.ts, window: a.title,
      };
      check('actions-line', line);
      return JSON.stringify(line);
    });
    const actions = Bun.zstdCompressSync(enc(`${lines.join('\n')}\n`));
    const aKey = `${base}.actions.jsonl.zst`;
    data.push({ key: `${prefix}/${aKey}`, body: actions, contentType: 'application/zstd' });
    const hasShot = seg.some((a) => a.action!.kind === 'screenshot');
    shots ||= hasShot;
    const manifest = { app_version: '0.1.0', created_at_ms: end + 2_000, device_id: deviceId, encryption: null, end_ms: end, event_count: seg.length, kind: 'actions', objects: { actions: info(aKey, actions) }, privacy: { mode: 'off', redact_pii: false }, schema: 2, screenshots: hasShot ? [SHOT_NAME] : [], segment_id: id, start_ms: start };
    check('manifest-actions', manifest);
    manifests.push({ key: `${prefix}/${base}.manifest.json`, body: enc(JSON.stringify(manifest)), contentType: 'application/json' });
    addIndex({ op: 'put', kind: 'actions', base, start_ms: start, end_ms: end, manifest: true, at_ms: end + 3_000, events: seg.length, segment_id: id }, start);
  }
  const assets = shots ? [{ key: `${prefix}/${deviceId}/assets/${SHOT_NAME}`, body: SHOT, contentType: 'image/jpeg' }] : [];
  const indexes = [...index].map(([day, lines]) => ({ key: `${prefix}/${deviceId}/index/${day}.jsonl`, body: enc(`${lines.join('\n')}\n`), contentType: 'application/x-ndjson' }));
  const first = activity[0]?.ts ?? Date.now();
  const last = activity[activity.length - 1]?.ts ?? Date.now();
  const now = Date.now();
  const device = { app_version: '0.1.0', arch: 'aarch64', computer_name: input.name, device_id: deviceId, encryption: null, first_chunk_ms: first, hostname: 'eval.local', last_chunk_ms: last, machine_key_sha256: input.machineKey, member: null, os: 'macos', os_version: '26.0', schema: 2, updated_at_ms: now };
  check('device', device);
  const status = { actionsRecording: true, appVersion: '0.1.0', audio: { enabled: false, state: null }, lastFrameMs: last, missingPermissions: [], pausedUntilMs: null, policy: { fetchedAtMs: now, source: `${prefix}/policy.json`, updatedAtMs: now }, reason: null, recording: 'recording', reportedAtMs: now, sync: { state: 'ok' } };
  check('status', status);
  const meta = [
    { key: `${prefix}/${deviceId}/device.json`, body: enc(JSON.stringify(device)), contentType: 'application/json' },
    { key: `${prefix}/${deviceId}/status.json`, body: enc(JSON.stringify(status)), contentType: 'application/json' },
  ];
  return { data: [...data, ...assets], manifests, rest: [...indexes, ...meta], items: manifests.length };
}
