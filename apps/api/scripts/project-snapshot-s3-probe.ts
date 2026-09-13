/**
 * Project snapshot — object-store probe for the API IMAGE's Bun.
 *
 * `apps/api/Dockerfile` pins `BUN_VERSION=1.2` while laptops and CI run a newer
 * Bun, so a Web/Node API the producer relies on can be missing or broken only
 * in the deployed image (see the 2026-08-27 `CompressionStream` learning). This
 * script exercises the exact AWS SDK call shapes `project-snapshot-store.ts`
 * uses — conditional PutObject (`IfNoneMatch: '*'`) with a Buffer body,
 * duplicate put → 412, HeadObject, GetObject `transformToString`, presigned GET
 * — against any S3-compatible endpoint, and prints one JSON line.
 *
 * Run it inside the image's Bun against local MinIO (from the repo root):
 *
 *   docker run --rm --network host -v "$PWD/apps/api:/app" -w /app \
 *     -e S3_ENDPOINT=http://127.0.0.1:19100 -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
 *     oven/bun:1.2-slim bun run scripts/project-snapshot-s3-probe.ts
 *
 * (Docker Desktop without host networking: `--add-host` or the MinIO container's
 * bridge IP as S3_ENDPOINT.) Expected: `stream_put` is NOT exercised — on Bun
 * 1.2.23 a PutObject whose body is a Node `createReadStream` never completes
 * and pins a core, which is why the store uploads a Buffer.
 */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:19100';
const client = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'kortixsnapshot',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'kortixsnapshotsecret',
  },
});
const Bucket = process.env.S3_BUCKET ?? 'kortix-bun-probe';

try {
  await client.send(new HeadBucketCommand({ Bucket }));
} catch {
  await client.send(new CreateBucketCommand({ Bucket }));
}

const Key = `probe/${Date.now()}.bin`;
const body = Buffer.alloc(3 * 1024 * 1024, 7);
const t0 = performance.now();
await client.send(
  new PutObjectCommand({
    Bucket,
    Key,
    Body: body,
    ContentLength: body.byteLength,
    ContentType: 'application/octet-stream',
    IfNoneMatch: '*',
  }),
);
const putMs = Math.round(performance.now() - t0);

let duplicate = 'no-error';
try {
  await client.send(new PutObjectCommand({ Bucket, Key, Body: 'x', IfNoneMatch: '*' }));
} catch (err) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  duplicate = `${e.name}/${e.$metadata?.httpStatusCode}`;
}

const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
await client.send(
  new PutObjectCommand({ Bucket, Key: `${Key}.json`, Body: JSON.stringify({ ok: true }), ContentType: 'application/json' }),
);
const text = await (await client.send(new GetObjectCommand({ Bucket, Key: `${Key}.json` }))).Body!.transformToString();
const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 120 });
const res = await fetch(url);
const bytes = (await res.arrayBuffer()).byteLength;

const ok =
  head.ContentLength === body.byteLength &&
  duplicate === 'PreconditionFailed/412' &&
  text === '{"ok":true}' &&
  res.status === 200 &&
  bytes === body.byteLength;

console.log(
  JSON.stringify({
    ok,
    bun: typeof Bun === 'undefined' ? null : Bun.version,
    buffer_put_ms: putMs,
    buffer_put_ok: head.ContentLength === body.byteLength,
    conditional_put_duplicate: duplicate,
    get_text: text,
    presigned_status: res.status,
    presigned_bytes: bytes,
  }),
);
process.exit(ok ? 0 : 1);
