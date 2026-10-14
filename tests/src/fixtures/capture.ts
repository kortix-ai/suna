/**
 * The Kortix Capture format (schema 2) contract, owned by the app in apps/capture:
 * the engine's
 * JSON Schemas and its synthetic fixture bucket (one device, 2026-10-01: two
 * screen chunks, two action segments with screenshots, one audio segment).
 *
 * `vendoredDevice` re-roots that bucket under a Kortix prefix and device id, as
 * a Kortix-issued device writes it: object keys and the manifests' `device_id`
 * and object keys change; every data object is byte-identical, so each size and
 * SHA-256 in the manifests still holds. The fixture's own index files are skipped; the
 * index lines are built from the manifests (index-line.schema.json), and
 * `status.json` is restamped so the device reads as live.
 *
 * `captureSchemas` validates any object against the vendored schemas (ajv,
 * draft 2020-12).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Ajv2020 from "ajv/dist/2020.js";
import { readLocalSupabaseEnvironment, resolveLocalTopology } from "../core/local-stack";

const CAPTURE_APP = resolve(fileURLToPath(new URL("../../../apps/capture", import.meta.url)));
export const CONTRACT_DIR = join(CAPTURE_APP, "fixtures/capture-format-v2");
const SCHEMAS_DIR = join(CAPTURE_APP, "schemas");
const FIXTURE_PREFIX = "fixture-prefix";
const FIXTURE_DEVICE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

export interface CaptureObject {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface VendoredDevice {
  /** Data and assets, then the manifests, then index, device.json and status.json. */
  objects: CaptureObject[];
  manifestKeys: string[];
  /** What indexing the whole device yields. */
  expected: { chunks: number; frames: number; actions: number; audioLines: number };
  /** The fixture's UTC day and its span. */
  day: string;
  startMs: number;
  endMs: number;
}

const text = (value: string) => new TextEncoder().encode(value);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const contentType = (key: string) =>
  key.endsWith(".mp4") ? "video/mp4" : key.endsWith(".m4a") ? "audio/mp4" : key.endsWith(".zst") ? "application/zstd" : key.endsWith(".png") ? "image/png" : key.endsWith(".jpg") ? "image/jpeg" : "application/json";

/** The two displays of a dual-monitor fixture device: the built-in main display and an external one to its right. */
export const FIXTURE_DISPLAYS = [
  { id: 1, name: "Built-in Display", x: 0, y: 0, w: 1512, h: 982, scale: 2, main: true },
  { id: 2, name: "External Display", x: 1512, y: 0, w: 2560, h: 1440, scale: 1, main: false },
] as const;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Rewrite every line of a frames.jsonl.zst with one display (and its focus). */
function framesOnDisplay(body: Uint8Array, display: (typeof FIXTURE_DISPLAYS)[number], focused: boolean): Uint8Array {
  const lines = new TextDecoder().decode(Bun.zstdDecompressSync(body)).split("\n").filter((line) => line.trim());
  const out = lines.map((line) => {
    const frame = JSON.parse(line);
    return JSON.stringify({ ...frame, display: { ...(frame.display ?? {}), id: display.id, name: display.name, main: display.main, focused, x: display.x, y: display.y, w: display.w, h: display.h } });
  });
  return Bun.zstdCompressSync(text(out.join("\n") + "\n"));
}

/**
 * `displays: 2` makes the device a dual-monitor one, as the engine writes it:
 * every screen item is recorded once per display (one item per display, its
 * manifest naming the display; display 1 holds the focused window), and
 * device.json lists both displays. Action and audio items are unchanged.
 */
export function vendoredDevice(input: { prefix: string; deviceId: string; machineKeySha256?: string; displays?: 1 | 2 }): VendoredDevice {
  const root = join(CONTRACT_DIR, "bucket", FIXTURE_PREFIX, FIXTURE_DEVICE);
  const folder = `${input.prefix}/${input.deviceId}`;
  const rekey = (key: string) => key.replace(`${FIXTURE_DEVICE}/`, `${input.deviceId}/`);
  const data: CaptureObject[] = [];
  const manifests: CaptureObject[] = [];
  const index = new Map<string, string[]>();
  let startMs = Infinity;
  let endMs = 0;
  let frames = 0;
  let actions = 0;
  let audioLines = 0;
  let device: Record<string, unknown> = {};
  let status: Record<string, unknown> = {};
  const parsed: Array<{ key: string; rel: string; manifest: any }> = [];
  for (const path of walk(root)) {
    const rel = relative(root, path);
    const key = `${folder}/${rel}`;
    const body = new Uint8Array(readFileSync(path));
    if (rel === "device.json") device = JSON.parse(readFileSync(path, "utf8"));
    else if (rel === "status.json") status = JSON.parse(readFileSync(path, "utf8"));
    else if (rel === "policy.json") continue; // operator-written, never by a device
    else if (rel.startsWith("index/")) continue; // rebuilt below from the re-keyed manifests
    else if (rel.endsWith(".manifest.json")) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.device_id = input.deviceId;
      for (const object of Object.values(manifest.objects) as Array<{ key: string }>) object.key = rekey(object.key);
      parsed.push({ key, rel, manifest });
    } else data.push({ key, body, contentType: contentType(key) });
  }
  if (input.displays === 2) {
    // One screen item per display: display 1 keeps the item (focused), display 2 gets a copy under its own base.
    const byKey = new Map(data.map((object) => [object.key, object]));
    const objectOf = (manifest: { objects: Record<string, { key: string }> }, role: string) => byKey.get(`${input.prefix}/${manifest.objects[role]!.key}`);
    for (const item of [...parsed]) {
      if (item.manifest.kind !== "chunk") continue;
      const [main, external] = FIXTURE_DISPLAYS;
      const second = JSON.parse(JSON.stringify(item.manifest));
      for (const [manifest, display, focused] of [[item.manifest, main, true], [second, external, false]] as const) {
        manifest.display = display;
        const frames = objectOf(item.manifest, "frames");
        if (!frames) throw new Error(`no frames object for ${item.key}`);
        const body = framesOnDisplay(frames.body, display, focused);
        const suffix = display.id === 1 ? "" : `-display${display.id}`;
        for (const role of Object.keys(manifest.objects)) {
          const source = objectOf(item.manifest, role)!;
          const newKey = source.key.replace(/(\.[a-z0-9]+(?:\.zst)?)$/, `${suffix}$1`);
          const newBody = role === "frames" ? body : source.body;
          if (newKey !== source.key) data.push({ key: newKey, body: newBody, contentType: source.contentType });
          else source.body = newBody;
          const digest = { size: newBody.byteLength, sha256: sha256Hex(newBody), plain_size: newBody.byteLength, plain_sha256: sha256Hex(newBody) };
          manifest.objects[role] = { ...manifest.objects[role], ...digest, key: manifest.objects[role].key.replace(/(\.[a-z0-9]+(?:\.zst)?)$/, `${suffix}$1`) };
        }
      }
      parsed.push({ key: item.key.replace(/\.manifest\.json$/, "-display2.manifest.json"), rel: item.rel.replace(/\.manifest\.json$/, "-display2.manifest.json"), manifest: second });
    }
  }
  for (const { key, rel, manifest } of parsed) {
    manifests.push({ key, body: text(JSON.stringify(manifest)), contentType: "application/json" });
    startMs = Math.min(startMs, manifest.start_ms);
    endMs = Math.max(endMs, manifest.end_ms);
    if (manifest.kind === "chunk") frames += manifest.frame_count;
    if (manifest.kind === "actions") actions += manifest.event_count;
    if (manifest.kind === "audio") audioLines += (manifest.transcript ?? []).length;
    const day = new Date(manifest.start_ms).toISOString().slice(0, 10);
    const base = `${input.deviceId}/${rel.replace(/\.manifest\.json$/, "")}`;
    index.set(day, [...(index.get(day) ?? []), JSON.stringify({ op: "put", kind: manifest.kind, base, start_ms: manifest.start_ms, end_ms: manifest.end_ms, manifest: true, at_ms: manifest.created_at_ms })]);
  }
  const now = Date.now();
  const indexObjects = [...index].map(([day, lines]) => ({ key: `${folder}/index/${day}.jsonl`, body: text(lines.join("\n") + "\n"), contentType: "application/x-ndjson" }));
  const deviceDoc = { ...device, device_id: input.deviceId, ...(input.machineKeySha256 ? { machine_key_sha256: input.machineKeySha256 } : {}), ...(input.displays === 2 ? { displays: FIXTURE_DISPLAYS } : {}), updated_at_ms: now };
  const statusDoc = { ...status, reportedAtMs: now };
  return {
    objects: [
      ...data,
      ...manifests,
      ...indexObjects,
      { key: `${folder}/device.json`, body: text(JSON.stringify(deviceDoc)), contentType: "application/json" },
      { key: `${folder}/status.json`, body: text(JSON.stringify(statusDoc)), contentType: "application/json" },
    ],
    manifestKeys: manifests.map((m) => m.key),
    expected: { chunks: manifests.length, frames, actions, audioLines },
    day: new Date(startMs).toISOString().slice(0, 10),
    startMs,
    endMs,
  };
}

/** The vendored issuer responses (`issuer/*.json`), by file name without `.json`. */
export function vendoredIssuer(name: "device-authorization" | "device-token" | "device-token-pending" | "credentials"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, "issuer", `${name}.json`), "utf8"));
}

export type CaptureSchemaName =
  | "actions-line" | "device" | "frames-line" | "index-line" | "issuer-credentials" | "issuer-device-authorization"
  | "issuer-device-token" | "manifest-actions" | "manifest-audio" | "manifest-chunk" | "policy" | "status";

let ajv: Ajv2020 | null = null;

/** Validate `value` against one vendored schema. Returns the error text, or null when valid. */
export function captureSchemaErrors(name: CaptureSchemaName, value: unknown): string | null {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const file of readdirSync(SCHEMAS_DIR)) {
      ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, file), "utf8")), file.replace(/\.schema\.json$/, ""));
    }
  }
  const validate = ajv.getSchema(name);
  if (!validate) throw new Error(`no vendored schema ${name}`);
  return validate(value) ? null : ajv.errorsText(validate.errors);
}

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A path-style S3 client for a store. Node and Bun both run it (the browser journeys load this file in Node). */
function s3(target: S3Target): S3Client {
  return new S3Client({
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: true,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Upload objects in order (path-style), as a device would. */
export async function uploadCaptureObjects(target: S3Target, objects: CaptureObject[]): Promise<void> {
  const client = s3(target);
  for (const object of objects) {
    await client.send(new PutObjectCommand({ Bucket: target.bucket, Key: object.key, Body: object.body, ContentType: object.contentType }));
  }
}

/** A fresh synthetic machine key (sha256 hex), as the desktop app sends it. */
export function syntheticMachineKey(seed: string): string {
  return createHash("sha256").update(`kortix-capture/machine/v1\nfixture-${seed}`).digest("hex");
}

/**
 * The local profile's capture store: Supabase Storage's S3 endpoint, bucket
 * `kortix-capture`, with the S3 protocol key pair — the "static credentials"
 * provider of the format. It has no STS, so a flow writes with these keys.
 */
export async function localCaptureStore(): Promise<S3Target> {
  // Browser journeys run in Node: the runner hands them the store (local-runner.ts).
  const fromEnv = process.env.E2E_CAPTURE_S3_ENDPOINT
    ? { endpoint: process.env.E2E_CAPTURE_S3_ENDPOINT, accessKeyId: process.env.E2E_CAPTURE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.E2E_CAPTURE_S3_SECRET_ACCESS_KEY }
    : null;
  const sb = fromEnv ? null : await readLocalSupabaseEnvironment(resolveLocalTopology(resolve(fileURLToPath(new URL("../../..", import.meta.url)))));
  const endpoint = fromEnv?.endpoint ?? (sb?.API_URL ? `${sb.API_URL.replace(/\/+$/, "")}/storage/v1/s3` : "");
  const accessKeyId = fromEnv?.accessKeyId ?? sb?.S3_PROTOCOL_ACCESS_KEY_ID;
  const secretAccessKey = fromEnv?.secretAccessKey ?? sb?.S3_PROTOCOL_ACCESS_KEY_SECRET;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("local Supabase reports no S3 protocol endpoint or keys");
  return { endpoint, bucket: "kortix-capture", region: "local", accessKeyId, secretAccessKey };
}

/** Delete objects as the device does when the person forgets a time range. */
export async function deleteCaptureObjects(target: S3Target, keys: string[]): Promise<void> {
  const client = s3(target);
  for (const key of keys) await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
}

/** Read one object back from a store (the flows read `policy.json` as a device would). */
export async function readCaptureObject(target: S3Target, key: string): Promise<string | null> {
  try {
    const out = await s3(target).send(new GetObjectCommand({ Bucket: target.bucket, Key: key }));
    return (await out.Body?.transformToString()) ?? null;
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
