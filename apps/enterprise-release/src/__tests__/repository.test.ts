import { afterEach, describe, expect, test } from 'bun:test';
import { constants, createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrustedRepository } from '../../../enterprise-updater/src/tuf-repository.ts';
import {
  bootstrapRepository,
  consistentTargetPath,
  keyIdFor,
  publishTargets,
  refreshTimestamp,
  type RepositoryKeys,
  type TufKey,
  type TufSigner,
} from '../repository.ts';

const roots: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class LocalSigner implements TufSigner {
  readonly key: TufKey;
  readonly keyId: string;
  private readonly privateKey: KeyObject;

  constructor() {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    this.key = { keytype: 'rsa', scheme: 'rsassa-pss-sha256', keyval: { public: publicPem } };
    this.keyId = keyIdFor(this.key);
  }

  sign(data: Buffer): string {
    return sign('sha256', data, {
      key: this.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('hex');
  }
}

function keys(): RepositoryKeys {
  return {
    root: [new LocalSigner(), new LocalSigner()],
    targets: new LocalSigner(),
    snapshot: new LocalSigner(),
    timestamp: new LocalSigner(),
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-tuf-repo-'));
  roots.push(root);
  return root;
}

function serve(root: string): URL {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      const file = Bun.file(join(root, path));
      return file.exists().then((exists) => exists ? new Response(file) : new Response('not found', { status: 404 }));
    },
  });
  return server.url;
}

describe('enterprise TUF repository', () => {
  test('builds a threshold-root repository consumed by the real updater client', async () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const stable = Buffer.from('{"version":"0.9.84-e1"}\n');
    publishTargets(root, signingKeys, [{
      path: 'channels/stable.json', bytes: stable,
      custom: { kind: 'kortix-enterprise-channel', channel: 'stable', version: '0.9.84-e1' },
    }], rootDigest(root), new Date('2026-07-13T01:00:00Z'));
    const rootBytes = readFileSync(join(root, 'metadata/1.root.json'));
    const client = await TrustedRepository.open({
      repositoryUrl: serve(root).toString(),
      trustedRootSha256: new Bun.CryptoHasher('sha256').update(rootBytes).digest('hex'),
      metadataDir: join(root, 'client-metadata'),
      targetDir: join(root, 'client-targets'),
    });
    expect((await client.readJsonTarget<{ version: string }>('channels/stable.json')).value.version).toBe('0.9.84-e1');
  });

  test('the real updater rejects tampered signed metadata', async () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const timestampPath = join(root, 'metadata/timestamp.json');
    const timestamp = JSON.parse(readFileSync(timestampPath, 'utf8'));
    timestamp.signed.version = 99;
    writeFileSync(timestampPath, `${JSON.stringify(timestamp)}\n`);
    const rootBytes = readFileSync(join(root, 'metadata/1.root.json'));
    await expect(TrustedRepository.open({
      repositoryUrl: serve(root).toString(),
      trustedRootSha256: new Bun.CryptoHasher('sha256').update(rootBytes).digest('hex'),
      metadataDir: join(root, 'client-metadata'),
      targetDir: join(root, 'client-targets'),
    })).rejects.toThrow();
  });

  test('the real updater rejects tampered bundle bytes before returning an installable artifact', async () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const target = 'releases/0.9.84-e1/supabase.tar.gz';
    const bundle = Buffer.from('certified Supabase bundle');
    const digest = createHash('sha256').update(bundle).digest('hex');
    publishTargets(root, signingKeys, [{ path: target, bytes: bundle }], rootDigest(root), new Date('2026-07-13T01:00:00Z'));
    writeFileSync(join(root, 'targets', consistentTargetPath(target, digest)), Buffer.from('tampered Supabase bundle'));

    const client = await TrustedRepository.open({
      repositoryUrl: serve(root).toString(),
      trustedRootSha256: rootDigest(root),
      metadataDir: join(root, 'client-metadata'),
      targetDir: join(root, 'client-targets'),
    });
    await expect(client.downloadArtifact({ target, sha256: digest, length: bundle.length })).rejects.toThrow();
  });

  test('refuses a single-key root', () => {
    const root = tempRoot();
    const signingKeys = keys();
    signingKeys.root = [new LocalSigner()];
    expect(() => bootstrapRepository(root, signingKeys)).toThrow('at least two independent signers');
  });

  test('refuses to re-sign a repository whose current online metadata was tampered', () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const targetsPath = join(root, 'metadata/targets.json');
    const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
    targets.signed.version = 99;
    writeFileSync(targetsPath, `${JSON.stringify(targets)}\n`);

    expect(() => publishTargets(root, signingKeys, [{
      path: 'channels/stable.json', bytes: Buffer.from('{}\n'),
    }], rootDigest(root))).toThrow('trusted targets signature threshold');
  });

  test('requires the offline-pinned initial root digest before signing online metadata', () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));

    expect(() => publishTargets(root, signingKeys, [{
      path: 'channels/stable.json', bytes: Buffer.from('{}\n'),
    }], 'f'.repeat(64))).toThrow('does not match metadata/1.root.json');
  });

  test('refuses an online KMS signer that is not authorized by the pinned root', () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const wrongKeys = { ...signingKeys, targets: new LocalSigner() };

    expect(() => publishTargets(root, wrongKeys, [{
      path: 'channels/stable.json', bytes: Buffer.from('{}\n'),
    }], rootDigest(root))).toThrow('targets signer is not authorized');
  });

  test('refreshes only timestamp metadata and remains consumable by the real updater', async () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));
    const snapshotBefore = readFileSync(join(root, 'metadata/snapshot.json'));
    const targetsBefore = readFileSync(join(root, 'metadata/targets.json'));

    const result = refreshTimestamp(
      root,
      signingKeys.timestamp,
      rootDigest(root),
      new Date('2026-07-13T06:00:00Z'),
    );

    expect(result).toEqual({ timestampVersion: 2, expires: '2026-07-20T06:00:00Z' });
    expect(readFileSync(join(root, 'metadata/snapshot.json'))).toEqual(snapshotBefore);
    expect(readFileSync(join(root, 'metadata/targets.json'))).toEqual(targetsBefore);

    const client = await TrustedRepository.open({
      repositoryUrl: serve(root).toString(),
      trustedRootSha256: rootDigest(root),
      metadataDir: join(root, 'client-metadata'),
      targetDir: join(root, 'client-targets'),
    });
    expect(client).toBeDefined();
  });

  test('refuses a timestamp refresh signer not authorized by the pinned root', () => {
    const root = tempRoot();
    const signingKeys = keys();
    bootstrapRepository(root, signingKeys, new Date('2026-07-13T00:00:00Z'));

    expect(() => refreshTimestamp(root, new LocalSigner(), rootDigest(root)))
      .toThrow('timestamp signer is not authorized');
  });
});

function rootDigest(root: string): string {
  return createHash('sha256').update(readFileSync(join(root, 'metadata/1.root.json'))).digest('hex');
}
