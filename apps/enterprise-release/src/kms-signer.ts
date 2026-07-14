import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessRunner } from '../../enterprise-updater/src/process.ts';
import { keyIdFor, type TufKey, type TufSigner } from './repository.ts';

interface PublicKeyResponse {
  PublicKey?: string;
  KeyUsage?: string;
  SigningAlgorithms?: string[];
}

interface SignResponse {
  Signature?: string;
}

export class KmsTufSigner implements TufSigner {
  readonly key: TufKey;
  readonly keyId: string;

  private constructor(
    private readonly keyArn: string,
    key: TufKey,
    private readonly region: string,
    private readonly runner = new ProcessRunner(),
  ) {
    this.key = key;
    this.keyId = keyIdFor(key);
  }

  static load(keyArn: string, region: string, runner = new ProcessRunner()): KmsTufSigner {
    if (!/^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/.test(keyArn)) throw new Error('invalid KMS signing key ARN');
    const response = awsJson<PublicKeyResponse>(runner, region, ['kms', 'get-public-key', '--key-id', keyArn]);
    if (!response.PublicKey || response.KeyUsage !== 'SIGN_VERIFY' || !response.SigningAlgorithms?.includes('RSASSA_PSS_SHA_256')) {
      throw new Error(`KMS key ${keyArn} is not an RSA PSS SHA-256 signing key`);
    }
    const publicPem = createPublicKey({ key: Buffer.from(response.PublicKey, 'base64'), format: 'der', type: 'spki' })
      .export({ format: 'pem', type: 'spki' }).toString();
    return new KmsTufSigner(keyArn, {
      keytype: 'rsa', scheme: 'rsassa-pss-sha256', keyval: { public: publicPem },
    }, region, runner);
  }

  sign(data: Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-tuf-sign-'));
    const digestPath = join(dir, 'digest.bin');
    try {
      writeFileSync(digestPath, createHash('sha256').update(data).digest(), { mode: 0o600 });
      const response = awsJson<SignResponse>(this.runner, this.region, [
        'kms', 'sign', '--key-id', this.keyArn, '--message-type', 'DIGEST',
        '--signing-algorithm', 'RSASSA_PSS_SHA_256', '--message', `fileb://${digestPath}`,
      ]);
      if (!response.Signature) throw new Error(`KMS key ${this.keyArn} returned no signature`);
      return Buffer.from(response.Signature, 'base64').toString('hex');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function awsJson<T>(runner: ProcessRunner, region: string, args: string[]): T {
  const output = runner.run('aws', [...args, '--region', region, '--output', 'json']);
  return JSON.parse(output) as T;
}
