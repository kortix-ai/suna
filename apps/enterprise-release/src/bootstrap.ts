#!/usr/bin/env bun

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { KmsTufSigner } from './kms-signer.ts';
import { bootstrapRepository } from './repository.ts';

const output = resolve(process.argv[2] ?? 'enterprise-tuf-repository');
const region = requiredEnv('AWS_REGION', 'AWS_DEFAULT_REGION');
const rootArns = requiredEnv('KORTIX_TUF_ROOT_KEY_ARNS').split(',').map((value) => value.trim()).filter(Boolean);
if (rootArns.length < 2) throw new Error('KORTIX_TUF_ROOT_KEY_ARNS must contain at least two KMS key ARNs');
mkdirSync(output, { recursive: true, mode: 0o700 });
bootstrapRepository(output, {
  root: rootArns.map((arn) => KmsTufSigner.load(arn, region)),
  targets: KmsTufSigner.load(requiredEnv('KORTIX_TUF_TARGETS_KEY_ARN'), region),
  snapshot: KmsTufSigner.load(requiredEnv('KORTIX_TUF_SNAPSHOT_KEY_ARN'), region),
  timestamp: KmsTufSigner.load(requiredEnv('KORTIX_TUF_TIMESTAMP_KEY_ARN'), region),
});
process.stdout.write(`${JSON.stringify({ repository: output, root_version: 1, root_threshold: 2 })}\n`);

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    if (process.env[name]) return process.env[name]!;
  }
  throw new Error(`missing ${names.join(' or ')}`);
}
