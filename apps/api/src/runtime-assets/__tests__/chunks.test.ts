/**
 * Content-addressed chunks for the two ~105 MB binaries.
 *
 * THE MEASUREMENT THIS IS BUILT ON. Two `bun --compile` linux-x64 CLI builds
 * that differ only in `KORTIX_CLI_VERSION` share 100 of 102 one-MiB chunks
 * (98.0%); the CLI and the daemon share 89 of 102 (87.3%), because ~90 MB of
 * each is the embedded Bun runtime — but only when the SAME Bun compiled both.
 * The shipped API image compiles them with two different pins and measures 0
 * of 111 shared on a real deploy; see manifest.ts. So a changed CLI is ~2 MiB of new bytes,
 * not 105 MB — but only if the API can name the chunks and serve one.
 *
 * FIXED-SIZE, not content-defined. A 400-byte source addition to apps/cli also
 * moved exactly 2 of 102 chunks, because `bun --compile` pads its output to a
 * fixed length (106,727,552 B before and after), so nothing downstream shifts.
 * Rolling-hash chunking has nothing left to recover here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CHUNK_SIZE,
  _resetRuntimeAssetsCache,
  runtimeChunkManifest,
  runtimeChunkSource,
} from '../manifest';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const AGENT_BIN_ENV = 'KORTIX_SNAPSHOT_AGENT_BIN_PATH';
const ENTRYPOINT_ENV = 'KORTIX_SANDBOX_ENTRYPOINT_PATH';
const dirs: string[] = [];
const original = new Map(
  [CLI_BIN_ENV, AGENT_BIN_ENV, ENTRYPOINT_ENV].map((k) => [k, process.env[k]]),
);

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function stage(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-chunks-test-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** A body whose chunk boundaries are predictable: byte `i` repeats per chunk. */
const filled = (chunks: number[], tail = 0) => {
  const out = Buffer.alloc(chunks.length * RUNTIME_CHUNK_SIZE + tail);
  chunks.forEach((value, i) => out.fill(value, i * RUNTIME_CHUNK_SIZE, (i + 1) * RUNTIME_CHUNK_SIZE));
  if (tail > 0) out.fill(0xff, chunks.length * RUNTIME_CHUNK_SIZE);
  return out;
};

beforeEach(() => {
  process.env[ENTRYPOINT_ENV] = join(tmpdir(), 'runtime-chunks-unset-entrypoint');
  _resetRuntimeAssetsCache();
});

afterEach(async () => {
  for (const [k, v] of original) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetRuntimeAssetsCache();
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('runtimeChunkManifest', () => {
  test('names every chunk in order, and the whole-file digest that stays the authority', async () => {
    const body = filled([1, 2, 3], 17);
    process.env[CLI_BIN_ENV] = await stage('kortix', body);
    process.env[AGENT_BIN_ENV] = join(tmpdir(), 'runtime-chunks-unset-agent');

    const manifest = await runtimeChunkManifest('cli');

    expect(manifest).not.toBeNull();
    expect(manifest!.sha256).toBe(sha(body));
    expect(manifest!.size).toBe(body.length);
    expect(manifest!.chunk_size).toBe(RUNTIME_CHUNK_SIZE);
    // A trailing partial chunk is a chunk. 3 full + 1 of 17 bytes.
    expect(manifest!.chunks).toHaveLength(4);
    expect(manifest!.chunks[0]).toBe(sha(body.subarray(0, RUNTIME_CHUNK_SIZE)));
    expect(manifest!.chunks[3]).toBe(sha(body.subarray(3 * RUNTIME_CHUNK_SIZE)));
  });

  test('a component the image does not carry has no chunk manifest', async () => {
    process.env[CLI_BIN_ENV] = join(tmpdir(), 'runtime-chunks-unset-cli');
    process.env[AGENT_BIN_ENV] = join(tmpdir(), 'runtime-chunks-unset-agent');
    expect(await runtimeChunkManifest('cli')).toBeNull();
  });
});

describe('runtimeChunkSource', () => {
  test('ONE store serves both binaries: a chunk the CLI and the daemon share resolves either way', async () => {
    // The real overlap is the ~90 MB embedded Bun runtime. Here: chunk 7.
    const cli = filled([7, 1]);
    const agent = filled([7, 2]);
    process.env[CLI_BIN_ENV] = await stage('kortix', cli);
    process.env[AGENT_BIN_ENV] = await stage('kortix-agent', agent);

    const shared = sha(cli.subarray(0, RUNTIME_CHUNK_SIZE));
    const cliOnly = sha(cli.subarray(RUNTIME_CHUNK_SIZE));
    const agentOnly = sha(agent.subarray(RUNTIME_CHUNK_SIZE));

    const sharedSource = await runtimeChunkSource(shared);
    expect(sharedSource).toEqual({
      path: process.env[CLI_BIN_ENV]!,
      offset: 0,
      length: RUNTIME_CHUNK_SIZE,
    });
    expect((await runtimeChunkSource(cliOnly))?.offset).toBe(RUNTIME_CHUNK_SIZE);
    expect((await runtimeChunkSource(agentOnly))?.path).toBe(process.env[AGENT_BIN_ENV]);
  });

  test('an unknown chunk resolves to nothing — the caller answers 404, never a guess', async () => {
    process.env[CLI_BIN_ENV] = await stage('kortix', filled([1]));
    process.env[AGENT_BIN_ENV] = join(tmpdir(), 'runtime-chunks-unset-agent');
    expect(await runtimeChunkSource(sha(Buffer.from('nothing on this image')))).toBeNull();
  });
});
