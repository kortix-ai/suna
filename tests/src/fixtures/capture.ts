/**
 * Synthetic Kortix Capture (schema 2) device output, for the CAP flows and for
 * driving a local stack by hand. Builds exactly the objects the desktop app
 * writes under `<prefix>/<device_id>/` (kortix-ai/capture
 * `apps/recorder/docs/capture-format.md`): screen chunks (mp4 + zstd frames),
 * action segments (zstd actions + content-addressed screenshot assets), an
 * audio segment with transcript lines, one manifest per item (written last),
 * the per-day `index/<day>.jsonl`, `device.json` and `status.json`.
 *
 * Two activity sessions 40 minutes apart, so a reader detects two ranges.
 * Every value is synthetic. `marker` is a unique word put on screen, in an
 * action and in the audio transcript, so a search can prove all three layers.
 */
import { createHash } from "node:crypto";

export interface CaptureObject {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface CaptureDay {
  /** Data and assets, then each item's manifest, then index, device.json, status.json. */
  objects: CaptureObject[];
  manifestKeys: string[];
  expected: { chunks: number; frames: number; actions: number; audioLines: number; ranges: number };
  sessions: Array<{ startMs: number; endMs: number }>;
}

/** A 1×1 PNG: a valid image for the vision model when no real screenshot is supplied. */
const PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);
const zstd = (lines: unknown[]) =>
  new Uint8Array(Bun.zstdCompressSync(text(lines.map((line) => JSON.stringify(line)).join("\n") + "\n")));
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayFolder = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};

export interface CaptureDayInput {
  prefix: string;
  deviceId: string;
  machineKeySha256: string;
  marker: string;
  /** Start of the first session. Default: 3 hours ago. */
  startMs?: number;
  /** Real media, when a run should play a video or show the model a real screenshot. */
  media?: { video?: Uint8Array; screenshots?: Uint8Array[] };
}

export function buildCaptureDay(input: CaptureDayInput): CaptureDay {
  const { prefix, deviceId, marker } = input;
  const folder = `${prefix}/${deviceId}`;
  const start = input.startMs ?? Date.now() - 3 * 3_600_000;
  const data: CaptureObject[] = [];
  const manifests: CaptureObject[] = [];
  const index = new Map<string, string[]>();
  const assets = new Map<string, Uint8Array>();
  let id = 0;
  const expected = { chunks: 0, frames: 0, actions: 0, audioLines: 0, ranges: 2 };

  const objectInfo = (key: string, body: Uint8Array) => ({
    key: key.slice(prefix.length + 1),
    size: body.byteLength,
    sha256: sha256(body),
    plain_size: body.byteLength,
    plain_sha256: sha256(body),
  });

  const item = (
    kind: "chunk" | "audio" | "actions",
    startMs: number,
    endMs: number,
    files: Array<{ role: string; ext: string; body: Uint8Array; contentType: string }>,
    extra: Record<string, unknown>,
  ) => {
    id += 1;
    const tag = kind === "chunk" ? `${id}` : kind === "audio" ? `a${id}` : `x${id}`;
    const base = `${folder}/${dayFolder(startMs)}/${startMs}-${tag}`;
    const objects: Record<string, unknown> = {};
    for (const file of files) {
      const key = `${base}.${file.ext}`;
      data.push({ key, body: file.body, contentType: file.contentType });
      objects[file.role] = objectInfo(key, file.body);
    }
    const manifest = {
      schema: 2,
      kind,
      device_id: deviceId,
      start_ms: startMs,
      end_ms: endMs,
      app_version: "0.0.0-fixture",
      created_at_ms: endMs + 1_000,
      encryption: null,
      privacy: { redact_pii: false, mode: "off" },
      objects,
      ...extra,
    };
    manifests.push({ key: `${base}.manifest.json`, body: text(JSON.stringify(manifest)), contentType: "application/json" });
    const day = dayOf(startMs);
    index.set(day, [
      ...(index.get(day) ?? []),
      JSON.stringify({ op: "put", kind, base: base.slice(prefix.length + 1), start_ms: startMs, end_ms: endMs, manifest: true, at_ms: endMs + 2_000 }),
    ]);
  };

  const asset = (bytes: Uint8Array) => {
    const name = `sha256-${sha256(bytes)}.png`;
    if (!assets.has(name)) assets.set(name, bytes);
    return name;
  };
  const screenshots = input.media?.screenshots?.length ? input.media.screenshots : [PIXEL_PNG];

  // Session A: 4 five-minute chunks in a spreadsheet and mail. Session B, 40 min later: 2 chunks in a browser.
  const screens = [
    { app: "Sheets", bundle: "test.example.sheets", title: "Q3 budget.xlsx", url: null, ocr: `Revenue 42,000 Forecast ${marker} quarter close` },
    { app: "Sheets", bundle: "test.example.sheets", title: "Q3 budget.xlsx", url: null, ocr: "Revenue 42,000 Costs 18,500 Margin" },
    { app: "Mail", bundle: "test.example.mail", title: "Inbox — vendor invoice", url: null, ocr: "Invoice 1042 due Friday from a vendor" },
    { app: "Sheets", bundle: "test.example.sheets", title: "Q3 budget.xlsx", url: null, ocr: "Forecast updated Margin 23.5%" },
    { app: "Browser", bundle: "test.example.browser", title: "Capture format — docs", url: "https://docs.example.test/capture", ocr: `${marker} capture format schema 2 manifests` },
    { app: "Browser", bundle: "test.example.browser", title: "Capture format — docs", url: "https://docs.example.test/capture#policy", ocr: "policy.json layers retention notice" },
  ];
  const sessionA = start;
  const sessionB = start + 20 * 60_000 + 40 * 60_000;
  const CHUNK_MS = 5 * 60_000;
  const FRAME_EVERY_MS = 20_000;
  screens.forEach((screen, i) => {
    const chunkStart = i < 4 ? sessionA + i * CHUNK_MS : sessionB + (i - 4) * CHUNK_MS;
    const chunkEnd = chunkStart + CHUNK_MS - 1_000;
    const frames = [];
    for (let t = chunkStart, n = 0; t <= chunkEnd; t += FRAME_EVERY_MS, n++) {
      frames.push({
        frame_index: n,
        ts_ms: t,
        width: 1440,
        height: 900,
        title: screen.title,
        url: screen.url,
        domain: screen.url ? new URL(screen.url).hostname : null,
        app: { bundle_id: screen.bundle, name: screen.app, version: "1.0", is_user_app: true, icon: null },
        capture_reason: n === 0 ? "app_switch" : "fixed_interval",
        inactive: false,
        pii_redacted: false,
        ocr: { foreground: screen.ocr, background: null, lines: [{ text: screen.ocr, x: 40, y: 80, w: 600, h: 24, off: 0, len: screen.ocr.length }] },
      });
    }
    const video = input.media?.video ?? text(`synthetic-mp4:${deviceId}:${chunkStart}`);
    item("chunk", chunkStart, chunkEnd, [
      { role: "video", ext: "mp4", body: video, contentType: "video/mp4" },
      { role: "frames", ext: "frames.jsonl.zst", body: zstd(frames), contentType: "application/zstd" },
    ], { video_id: i + 1, frame_count: frames.length, width: 1440, height: 900 });
    expected.chunks += 1;
    expected.frames += frames.length;

    const shot = asset(screenshots[i % screenshots.length]!);
    const actions = [
      { ts_ms: chunkStart + 15_000, kind: "click", app: screen.app, window: screen.title, target: { x: 0.41, y: 0.2, button: "left", role: "cell" }, screenshot: shot },
      { ts_ms: chunkStart + 45_000, kind: "typewrite", app: screen.app, window: screen.title, target: { text: i === 0 ? `forecast ${marker}` : "42000" }, screenshot: null },
      { ts_ms: chunkStart + 90_000, kind: "hotkey", app: screen.app, window: screen.title, target: { keys: ["Cmd", "S"] }, screenshot: null },
      { ts_ms: chunkStart + 150_000, kind: "press", app: screen.app, window: screen.title, target: { key: "Enter" }, screenshot: null },
      { ts_ms: chunkStart + 240_000, kind: "scroll", app: screen.app, window: screen.title, target: { x: 0.5, y: 0.5, clicks: -3 }, screenshot: null },
    ];
    item("actions", chunkStart, chunkEnd, [{ role: "actions", ext: "actions.jsonl.zst", body: zstd(actions), contentType: "application/zstd" }], {
      segment_id: i + 1,
      event_count: actions.length,
      screenshots: [shot],
    });
    expected.chunks += 1;
    expected.actions += actions.length;
  });

  const transcript = [
    { start_ms: sessionB + 30_000, end_ms: sessionB + 36_000, text: `Let us review the ${marker} rollout plan before Friday.` },
    { start_ms: sessionB + 40_000, end_ms: sessionB + 47_000, text: "The policy turns audio off by default for every project." },
    { start_ms: sessionB + 60_000, end_ms: sessionB + 66_000, text: "Ship the schema two reader after the fixture bucket lands." },
  ];
  item("audio", sessionB, sessionB + CHUNK_MS - 1_000, [
    { role: "audio", ext: "m4a", body: text(`synthetic-m4a:${deviceId}:${sessionB}`), contentType: "audio/mp4" },
  ], { audio_id: 1, sources: ["microphone", "system"], transcript });
  expected.chunks += 1;
  expected.audioLines += transcript.length;

  const assetObjects = [...assets].map(([name, body]) => ({ key: `${folder}/assets/${name}`, body, contentType: "image/png" }));
  const indexObjects = [...index].map(([day, lines]) => ({ key: `${folder}/index/${day}.jsonl`, body: text(lines.join("\n") + "\n"), contentType: "application/x-ndjson" }));
  const lastFrameMs = sessionB + 2 * CHUNK_MS - 1_000;
  const device = {
    schema: 2,
    device_id: deviceId,
    machine_key_sha256: input.machineKeySha256,
    hostname: "fixture-host",
    computer_name: "Fixture Laptop",
    os: "macos",
    os_version: "15.0",
    arch: "arm64",
    app_version: "0.0.0-fixture",
    member: null,
    updated_at_ms: Date.now(),
  };
  const status = {
    recording: "recording",
    reason: null,
    missingPermissions: [],
    pausedUntilMs: null,
    audio: { enabled: true, state: "recording" },
    sync: { state: "ok", pending: 0, errorClass: null, lastUploadMs: Date.now() },
    lastFrameMs,
    appVersion: "0.0.0-fixture",
    actionsRecording: true,
    reportedAtMs: Date.now(),
  };
  return {
    objects: [
      ...assetObjects,
      ...data,
      ...manifests,
      ...indexObjects,
      { key: `${folder}/device.json`, body: text(JSON.stringify(device)), contentType: "application/json" },
      { key: `${folder}/status.json`, body: text(JSON.stringify(status)), contentType: "application/json" },
    ],
    manifestKeys: manifests.map((m) => m.key),
    expected,
    sessions: [
      { startMs: sessionA, endMs: sessionA + 4 * CHUNK_MS - 1_000 },
      { startMs: sessionB, endMs: lastFrameMs },
    ],
  };
}

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Upload objects in order with Bun's S3 client (path-style), as a device would. */
export async function uploadCaptureObjects(target: S3Target, objects: CaptureObject[]): Promise<void> {
  const client = new Bun.S3Client({
    endpoint: target.endpoint,
    bucket: target.bucket,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    sessionToken: target.sessionToken,
    virtualHostedStyle: false,
  });
  for (const object of objects) await client.write(object.key, object.body, { type: object.contentType });
}

/** A fresh synthetic machine key (sha256 hex), as the desktop app sends it. */
export function syntheticMachineKey(seed: string): string {
  return sha256(text(`kortix-capture/machine/v1\nfixture-${seed}`));
}
