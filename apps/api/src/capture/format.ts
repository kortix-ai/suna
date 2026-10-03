/**
 * The reader side of the Kortix Capture format, schema 2 (the desktop app's
 * only contract: kortix-ai/capture `apps/recorder/docs/capture-format.md`).
 * Pure functions: key layout, manifest / policy / status shapes, and the
 * line parsers for frames, actions and audio transcripts. The JSON Schemas
 * and the fixture bucket of the contract are vendored, pinned to one engine
 * commit, in tests/fixtures/capture-format-v2. Kortix reads schema 2 only
 * (every Kortix prefix is written by a schema-2 engine); unknown fields are
 * ignored.
 */
import { z } from 'zod';
import { isUuid } from '../shared/validate';

export const CAPTURE_SCHEMA = 2;

/** Kortix's prefix for one project. The device writes under `<prefix>/<device_id>/`. */
export function projectPrefix(accountId: string, projectId: string): string {
  return `orgs/${accountId}/projects/${projectId}`;
}

/** Split an object key of the Kortix layout. Null for any other key. */
export function parseCaptureKey(
  key: string,
): { accountId: string; projectId: string; deviceId: string; rest: string } | null {
  const [orgs, accountId, projects, projectId, deviceId, ...rest] = key.split('/');
  if (orgs !== 'orgs' || projects !== 'projects' || rest.length === 0 || !rest.every(Boolean)) return null;
  if (!isUuid(accountId) || !isUuid(projectId) || !isUuid(deviceId)) return null;
  return { accountId, projectId, deviceId, rest: rest.join('/') };
}

// ─── Manifests ───────────────────────────────────────────────────────────────

const ObjectInfoSchema = z
  .object({
    key: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

const TranscriptLineSchema = z.object({
  start_ms: z.number(),
  end_ms: z.number(),
  text: z.string(),
});

export const ManifestSchema = z
  .object({
    schema: z.number().int(),
    kind: z.enum(['chunk', 'audio', 'actions']),
    device_id: z.string().min(1),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative(),
    app_version: z.string().optional(),
    created_at_ms: z.number().optional(),
    encryption: z.unknown().optional(),
    objects: z.record(z.string(), ObjectInfoSchema),
    transcript: z.array(TranscriptLineSchema).optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof ManifestSchema>;

export type ManifestCheck = { ok: true; manifest: Manifest } | { ok: false; reason: string };

/** Validate a manifest against its key and the device it was written for. */
export function checkManifest(raw: unknown, deviceId: string): ManifestCheck {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `invalid manifest: ${parsed.error.issues[0]?.message ?? 'shape'}` };
  const manifest = parsed.data;
  if (manifest.schema !== CAPTURE_SCHEMA) return { ok: false, reason: `unsupported schema ${manifest.schema}` };
  if (manifest.device_id !== deviceId) return { ok: false, reason: 'manifest device_id does not match its key' };
  if (manifest.end_ms < manifest.start_ms) return { ok: false, reason: 'end_ms before start_ms' };
  const required = { chunk: ['video'], audio: ['audio'], actions: ['actions'] }[manifest.kind];
  for (const role of required) {
    if (!manifest.objects[role]) return { ok: false, reason: `missing object "${role}"` };
  }
  return { ok: true, manifest };
}

/**
 * The full key of a manifest object (manifest keys are relative to the prefix;
 * a full key is accepted too). Null when the object is outside the device's own
 * folder: a device may only index what it wrote.
 */
export function objectKey(prefix: string, deviceId: string, key: string): string | null {
  const full = key.startsWith(`${prefix}/`) ? key : `${prefix}/${key.replace(/^\/+/, '')}`;
  if (!full.startsWith(`${prefix}/${deviceId}/`) || full.includes('/../') || full.endsWith('/..')) return null;
  return full;
}

export function isEncrypted(manifest: Manifest): boolean {
  return manifest.encryption !== null && manifest.encryption !== undefined;
}

// ─── Index files ─────────────────────────────────────────────────────────────

/**
 * Fold one `index/<day>.jsonl` body (capture-format.md "Index lines"): the
 * latest `put` of a base is live until a `delete` of it. `live` holds the
 * manifests of complete items; `deleted` holds the manifests of items the
 * person forgot or the device's retention removed, which Kortix retracts.
 */
export function foldIndex(prefix: string, deviceId: string, body: string): { live: string[]; deleted: string[] } {
  const state = new Map<string, 'live' | 'incomplete' | 'deleted'>();
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.base !== 'string') continue;
    const key = objectKey(prefix, deviceId, `${entry.base}.manifest.json`);
    if (!key) continue;
    if (entry.op === 'put') state.set(key, entry.manifest === true ? 'live' : 'incomplete');
    else if (entry.op === 'delete') state.set(key, 'deleted');
  }
  const keys = (want: string) => [...state].filter(([, value]) => value === want).map(([key]) => key);
  return { live: keys('live'), deleted: keys('deleted') };
}

/** The UTC day (`YYYY-MM-DD`) of an instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Lines ───────────────────────────────────────────────────────────────────

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export interface FrameRow {
  ts: Date;
  frameIndex: number | null;
  app: string | null;
  bundleId: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  ocrText: string | null;
  ocrBoxes: unknown[] | null;
  inactive: boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One line of `frames.jsonl.zst` (frames-line.schema.json). Null for a line without `ts_ms`. */
export function parseFrameLine(line: Record<string, unknown>): FrameRow | null {
  const tsMs = Number(line.ts_ms);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  const app = record(line.app);
  const ocr = record(line.ocr);
  const lines = Array.isArray(ocr?.lines) ? ocr.lines.map(record).filter((l) => l !== null) : null;
  return {
    ts: new Date(tsMs),
    frameIndex: Number.isInteger(line.frame_index) ? (line.frame_index as number) : null,
    app: str(app?.name),
    bundleId: str(app?.bundle_id),
    title: str(line.title),
    url: str(line.url),
    domain: str(line.domain),
    ocrText: str([ocr?.foreground, ocr?.background].filter((part) => typeof part === 'string').join('\n')),
    ocrBoxes: lines && lines.map(({ text, x, y, w, h }) => ({ text, x, y, w, h })),
    inactive: line.inactive === true,
  };
}

export interface ActionRow {
  ts: Date;
  kind: string;
  app: string | null;
  windowTitle: string | null;
  description: string;
  target: Record<string, unknown> | null;
  screenshot: string | null;
}

const pct = (v: unknown) => (typeof v === 'number' && v <= 1 ? `${Math.round(v * 100)}%` : String(v));

/** A one-line, human-readable action, as the range pipelines and search read it. */
export function describeAction(kind: string, args: Record<string, unknown>): string {
  switch (kind) {
    case 'click':
    case 'double_click':
      return `${kind === 'double_click' ? 'Double-click' : 'Click'} ${args.button ?? 'left'} button at ${pct(args.x)},${pct(args.y)}`;
    case 'drag':
      return `Drag from ${pct(args.start_x)},${pct(args.start_y)} to ${pct(args.end_x)},${pct(args.end_y)}`;
    case 'scroll': {
      const clicks = Number(args.clicks ?? 0);
      return `Scroll ${clicks < 0 ? 'down' : 'up'} ${Math.abs(clicks)} at ${pct(args.x)},${pct(args.y)}`;
    }
    case 'press':
      return `Press ${args.key ?? '?'}`;
    case 'hotkey':
      return `Hotkey ${Array.isArray(args.keys) ? args.keys.join('+') : '?'}`;
    case 'typewrite':
    case 'type':
    case 'write':
      return `Type "${String(args.text ?? '').slice(0, 120)}"`;
    case 'sleep':
      return `Wait ${args.duration ?? '?'}s`;
    case 'screenshot':
      return 'Screenshot';
    default:
      return kind;
  }
}

/**
 * One line of `actions.jsonl.zst` (actions-line.schema.json). Null for a line
 * without `ts_ms` or `kind`, and for a screenshot event without its asset.
 */
export function parseActionLine(line: Record<string, unknown>): ActionRow | null {
  const kind = str(line.kind);
  const tsMs = Number(line.ts_ms);
  if (!kind || !Number.isFinite(tsMs) || tsMs <= 0) return null;
  const screenshot = str(line.screenshot);
  if (kind === 'screenshot' && !screenshot) return null;
  const target = record(line.target);
  const args = record(line.args) ?? {};
  return {
    ts: new Date(tsMs),
    kind,
    app: str(record(line.app)?.name),
    windowTitle: str(line.window),
    description: describeAction(kind, { ...args, ...(target ?? {}) }),
    target: target ?? (Object.keys(args).length ? args : null),
    screenshot,
  };
}

/** Parse a JSONL body into objects, skipping blank and malformed lines. */
export function jsonLines(body: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value);
    } catch {
      // A torn last line of a partial upload is not an error worth failing on.
    }
  }
  return rows;
}

// ─── policy.json ─────────────────────────────────────────────────────────────

export const PolicySchema = z.object({
  layers: z
    .object({ screen: z.boolean(), actions: z.boolean(), audio: z.boolean() })
    .default({ screen: true, actions: true, audio: false }),
  privacy: z.object({ redact_pii: z.boolean() }).passthrough().default({ redact_pii: false }),
  retention: z
    .object({
      local_hours: z.number().int().min(0).max(24 * 365),
      remote_days: z.number().int().min(0).max(3650),
    })
    .default({ local_hours: 0, remote_days: 90 }),
  recording: z
    .object({ paused: z.boolean(), paused_until_ms: z.number().int().nullable() })
    .default({ paused: false, paused_until_ms: null }),
  notice: z.string().max(2000).default(''),
});
export type CapturePolicy = z.infer<typeof PolicySchema>;

/** The project policy before an operator sets one. Audio is off until someone turns it on. */
export const DEFAULT_POLICY: CapturePolicy = PolicySchema.parse({});

/** The `policy.json` object body, as devices read it. */
export function policyDocument(policy: CapturePolicy, updatedAtMs: number): string {
  return `${JSON.stringify({ schema: CAPTURE_SCHEMA, ...policy, updated_at_ms: updatedAtMs }, null, 2)}\n`;
}

// ─── status.json / device.json ───────────────────────────────────────────────

export const OFFLINE_AFTER_MS = 120_000;

/** `reportedAtMs` of a status document, or null. */
export function statusReportedAt(status: Record<string, unknown> | null | undefined): number | null {
  const value = Number(status?.reportedAtMs);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Live state of a device: what its last status says, or `offline` when it is older than 120 s. */
export function liveState(status: Record<string, unknown> | null | undefined, nowMs: number): string {
  const reported = statusReportedAt(status);
  if (reported === null || nowMs - reported > OFFLINE_AFTER_MS) return 'offline';
  return str(status?.recording) ?? 'unknown';
}

/** The descriptive fields Kortix keeps from `device.json` (or a sign-in request). */
export function deviceFields(raw: Record<string, unknown>): {
  name: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  appVersion: string | null;
} {
  const clip = (value: unknown) => str(value)?.slice(0, 200) ?? null;
  return {
    name: clip(raw.computer_name) ?? clip(raw.hostname),
    os: clip(raw.os),
    osVersion: clip(raw.os_version),
    arch: clip(raw.arch),
    appVersion: clip(raw.app_version),
  };
}
