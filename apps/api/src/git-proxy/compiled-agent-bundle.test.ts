import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCompiledAgentBundle,
  resetCompiledAgentBundleForTests,
} from './compiled-agent-bundle';

const roots: string[] = [];
const originalOverride = process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;

beforeEach(() => {
  resetCompiledAgentBundleForTests();
});

afterEach(async () => {
  resetCompiledAgentBundleForTests();
  if (originalOverride === undefined) delete process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;
  else process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = originalOverride;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getCompiledAgentBundle', () => {
  test('loads and fingerprints a verified prebuilt daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-agent-bundle-'));
    roots.push(root);
    const path = join(root, 'server.mjs');
    const source = 'console.log("kortix-sandbox-agent-server starting");\n';
    await writeFile(path, source);
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = path;

    const bundle = await getCompiledAgentBundle();

    expect(bundle.source).toBe(source);
    expect(bundle.size).toBe(Buffer.byteLength(source));
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a file that is not the daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-agent-bundle-'));
    roots.push(root);
    const path = join(root, 'server.mjs');
    await writeFile(path, 'process.exit(0);\n');
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = path;

    await expect(getCompiledAgentBundle()).rejects.toThrow('has no daemon entrypoint');
  });
});
