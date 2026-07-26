#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const requiredEnvironment = [
  'SOURCE_DATABASE_URL',
  'SOURCE_SUPABASE_URL',
  'SOURCE_SERVICE_ROLE_KEY',
  'TARGET_DATABASE_URL',
  'TARGET_SUPABASE_URL',
  'TARGET_SERVICE_ROLE_KEY',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const buckets = (process.env.STORAGE_BUCKETS ?? 'avatars')
  .split(',')
  .map((bucket) => bucket.trim())
  .filter(Boolean);
const chunkSize = Number(process.env.STORAGE_CHUNK_SIZE ?? 6 * 1024 * 1024);
const limit = Number(process.env.STORAGE_LIMIT ?? 0);
const verifyAll = process.env.STORAGE_VERIFY_ALL === '1';

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function queryObjects(databaseUrl, selectedBuckets) {
  const bucketList = selectedBuckets.map(sqlString).join(', ');
  const query = `
    COPY (
      SELECT
        bucket_id,
        name,
        (metadata->>'size')::bigint AS size,
        coalesce(metadata->>'mimetype', 'application/octet-stream') AS content_type,
        coalesce(metadata->>'cacheControl', '3600') AS cache_control,
        coalesce(metadata->>'eTag', '') AS source_etag,
        coalesce(metadata->>'sourceETag', '') AS migrated_source_etag,
        coalesce(metadata->>'sourceSha256', '') AS source_sha256
      FROM storage.objects
      WHERE bucket_id IN (${bucketList})
      ORDER BY bucket_id, name
    ) TO STDOUT WITH (FORMAT csv, HEADER true)
  `;
  const result = spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`psql object inventory failed: ${result.stderr.trim()}`);
  }
  return parseCsv(result.stdout);
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  const [header, ...data] = rows;
  if (!header) return [];
  return data
    .filter((values) => values.length === header.length)
    .map((values) => Object.fromEntries(header.map((name, index) => [name, values[index]])));
}

function objectUrl(projectUrl, bucket, name) {
  const encodedName = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${projectUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodedName}`;
}

function base64(value) {
  return Buffer.from(String(value)).toString('base64');
}

async function request(url, options, expectedStatuses) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (expectedStatuses.includes(response.status)) return response;
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}

async function createTusUpload(object) {
  const metadata = [
    ['bucketName', object.bucket_id],
    ['objectName', object.name],
    ['contentType', object.content_type],
    ['cacheControl', object.cache_control],
    [
      'metadata',
      JSON.stringify({
        sourceETag: object.source_etag,
        sourceSize: Number(object.size),
      }),
    ],
  ]
    .map(([name, value]) => `${name} ${base64(value)}`)
    .join(',');

  const response = await request(
    `${process.env.TARGET_SUPABASE_URL}/storage/v1/upload/resumable`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TARGET_SERVICE_ROLE_KEY}`,
        apikey: process.env.TARGET_SERVICE_ROLE_KEY,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': object.size,
        'Upload-Metadata': metadata,
        'x-upsert': 'true',
      },
    },
    [201],
  );

  const location = response.headers.get('location');
  if (!location) throw new Error('TUS create response did not include Location');
  return new URL(location, process.env.TARGET_SUPABASE_URL).toString();
}

async function uploadObject(object) {
  const uploadUrl = await createTusUpload(object);
  const digest = createHash('sha256');
  const totalSize = Number(object.size);
  let offset = 0;

  while (offset < totalSize) {
    const end = Math.min(offset + chunkSize, totalSize) - 1;
    const sourceResponse = await request(
      objectUrl(
        process.env.SOURCE_SUPABASE_URL,
        object.bucket_id,
        object.name,
      ),
      {
        headers: {
          Authorization: `Bearer ${process.env.SOURCE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SOURCE_SERVICE_ROLE_KEY,
          Range: `bytes=${offset}-${end}`,
        },
      },
      [200, 206],
    );
    const chunk = Buffer.from(await sourceResponse.arrayBuffer());
    const expectedLength = end - offset + 1;
    if (chunk.length !== expectedLength) {
      throw new Error(
        `${object.bucket_id}/${object.name}: expected ${expectedLength} source bytes, received ${chunk.length}`,
      );
    }
    digest.update(chunk);

    const targetResponse = await request(
      uploadUrl,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${process.env.TARGET_SERVICE_ROLE_KEY}`,
          apikey: process.env.TARGET_SERVICE_ROLE_KEY,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: chunk,
      },
      [204],
    );
    offset = Number(targetResponse.headers.get('upload-offset'));
    if (!Number.isFinite(offset)) {
      throw new Error(`${object.bucket_id}/${object.name}: TUS response omitted Upload-Offset`);
    }
  }

  return digest.digest('hex');
}

async function hashRemoteObject(projectUrl, serviceRoleKey, object) {
  const digest = createHash('sha256');
  const response = await request(
    objectUrl(projectUrl, object.bucket_id, object.name),
    {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
    [200],
  );
  if (!response.body) {
    throw new Error(`${object.bucket_id}/${object.name}: response has no body`);
  }
  for await (const chunk of response.body) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function writeTargetChecksum(object, checksum) {
  const query = `
    UPDATE storage.objects
    SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'sourceETag', ${sqlString(object.source_etag)},
      'sourceSize', ${Number(object.size)},
      'sourceSha256', ${sqlString(checksum)}
    )
    WHERE bucket_id = ${sqlString(object.bucket_id)}
      AND name = ${sqlString(object.name)}
  `;
  const result = spawnSync(
    'psql',
    [process.env.TARGET_DATABASE_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', query],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to persist object checksum: ${result.stderr.trim()}`);
  }
}

const sourceObjects = queryObjects(process.env.SOURCE_DATABASE_URL, buckets);
const targetObjects = queryObjects(process.env.TARGET_DATABASE_URL, buckets);
const targetByPath = new Map(
  targetObjects.map((object) => [`${object.bucket_id}/${object.name}`, object]),
);
const selectedObjects = limit > 0 ? sourceObjects.slice(0, limit) : sourceObjects;
let copied = 0;
let skipped = 0;
let verified = 0;
let copiedBytes = 0;

for (const [index, object] of selectedObjects.entries()) {
  const path = `${object.bucket_id}/${object.name}`;
  const target = targetByPath.get(path);
  const targetMatchesManifest =
    target &&
    target.size === object.size &&
    target.migrated_source_etag === object.source_etag &&
    target.source_sha256;

  if (targetMatchesManifest && !verifyAll) {
    skipped += 1;
    console.log(
      `[${index + 1}/${selectedObjects.length}] skip ${path} (${object.size} bytes)`,
    );
    continue;
  }

  if (!targetMatchesManifest) {
    console.log(
      `[${index + 1}/${selectedObjects.length}] copy ${path} (${object.size} bytes)`,
    );
    const sourceChecksum = await uploadObject(object);
    const targetChecksum = await hashRemoteObject(
      process.env.TARGET_SUPABASE_URL,
      process.env.TARGET_SERVICE_ROLE_KEY,
      object,
    );
    if (sourceChecksum !== targetChecksum) {
      throw new Error(`${path}: target checksum does not match source checksum`);
    }
    writeTargetChecksum(object, sourceChecksum);
    copied += 1;
    copiedBytes += Number(object.size);
    verified += 1;
    continue;
  }

  console.log(
    `[${index + 1}/${selectedObjects.length}] verify ${path} (${object.size} bytes)`,
  );
  const [sourceChecksum, targetChecksum] = await Promise.all([
    hashRemoteObject(
      process.env.SOURCE_SUPABASE_URL,
      process.env.SOURCE_SERVICE_ROLE_KEY,
      object,
    ),
    hashRemoteObject(
      process.env.TARGET_SUPABASE_URL,
      process.env.TARGET_SERVICE_ROLE_KEY,
      object,
    ),
  ]);
  if (sourceChecksum !== targetChecksum) {
    throw new Error(`${path}: target checksum does not match source checksum`);
  }
  writeTargetChecksum(object, sourceChecksum);
  verified += 1;
}

console.log(
  JSON.stringify({
    buckets,
    sourceObjects: sourceObjects.length,
    selectedObjects: selectedObjects.length,
    copied,
    skipped,
    verified,
    copiedBytes,
  }),
);
