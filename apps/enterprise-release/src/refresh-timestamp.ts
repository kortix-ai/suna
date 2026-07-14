#!/usr/bin/env bun

import { resolve } from 'node:path';

import { KmsTufSigner } from './kms-signer.ts';
import { refreshTimestamp } from './repository.ts';

const repositoryDir = resolve(process.argv[2] ?? 'enterprise-tuf-repository');
const region = requiredEnv('AWS_REGION', 'AWS_DEFAULT_REGION');
const result = refreshTimestamp(
  repositoryDir,
  KmsTufSigner.load(requiredEnv('KORTIX_TUF_TIMESTAMP_KEY_ARN'), region),
  requiredEnv('KORTIX_TUF_ROOT_SHA256'),
);

process.stdout.write(`${JSON.stringify({ repository: repositoryDir, ...result })}\n`);

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    if (process.env[name]) return process.env[name]!;
  }
  throw new Error(`missing ${names.join(' or ')}`);
}
