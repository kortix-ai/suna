/**
 * The Kortix Capture format (schema 2) contract, vendored from kortix-ai/capture
 * at the commit in tests/fixtures/capture-format-v2/SOURCE.json: the engine's
 * JSON Schemas and its synthetic fixture bucket (one device, 2026-10-01: two
 * screen chunks, two action segments with screenshots, one audio segment).
 *
 * `vendoredDevice` re-roots that bucket under a Kortix prefix and device id, as
 * a Kortix-issued device writes it: object keys and the manifests' `device_id`
 * and object keys change; every data object is byte-identical, so each size and
 * SHA-256 in the manifests still holds. The fixture has no index files; the
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

export const CONTRACT_DIR = resolve(fileURLToPath(new URL("../../fixtures/capture-format-v2", import.meta.url)));
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
  expected: { chunks: number; frames: number; actions: number; audioLines: number; ranges: number };
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

export function vendoredDevice(input: { prefix: string; deviceId: string; machineKeySha256?: string }): VendoredDevice {
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
  for (const path of walk(root)) {
    const rel = relative(root, path);
    const key = `${folder}/${rel}`;
    const body = new Uint8Array(readFileSync(path));
    if (rel === "device.json") device = JSON.parse(readFileSync(path, "utf8"));
    else if (rel === "status.json") status = JSON.parse(readFileSync(path, "utf8"));
    else if (rel === "policy.json") continue; // operator-written, never by a device
    else if (rel.endsWith(".manifest.json")) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.device_id = input.deviceId;
      for (const object of Object.values(manifest.objects) as Array<{ key: string }>) object.key = rekey(object.key);
      manifests.push({ key, body: text(JSON.stringify(manifest)), contentType: "application/json" });
      startMs = Math.min(startMs, manifest.start_ms);
      endMs = Math.max(endMs, manifest.end_ms);
      if (manifest.kind === "chunk") frames += manifest.frame_count;
      if (manifest.kind === "actions") actions += manifest.event_count;
      if (manifest.kind === "audio") audioLines += (manifest.transcript ?? []).length;
      const day = new Date(manifest.start_ms).toISOString().slice(0, 10);
      const base = `${input.deviceId}/${rel.replace(/\.manifest\.json$/, "")}`;
      index.set(day, [...(index.get(day) ?? []), JSON.stringify({ op: "put", kind: manifest.kind, base, start_ms: manifest.start_ms, end_ms: manifest.end_ms, manifest: true, at_ms: manifest.created_at_ms })]);
    } else data.push({ key, body, contentType: contentType(key) });
  }
  const now = Date.now();
  const indexObjects = [...index].map(([day, lines]) => ({ key: `${folder}/index/${day}.jsonl`, body: text(lines.join("\n") + "\n"), contentType: "application/x-ndjson" }));
  const deviceDoc = { ...device, device_id: input.deviceId, ...(input.machineKeySha256 ? { machine_key_sha256: input.machineKeySha256 } : {}), updated_at_ms: now };
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
    expected: { chunks: manifests.length, frames, actions, audioLines, ranges: 1 },
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
    for (const file of readdirSync(join(CONTRACT_DIR, "schemas"))) {
      ajv.addSchema(JSON.parse(readFileSync(join(CONTRACT_DIR, "schemas", file), "utf8")), file.replace(/\.schema\.json$/, ""));
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
