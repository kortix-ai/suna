#!/usr/bin/env bun
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  applyPreviewEnvironment,
  buildPreviewCaddyfile,
  buildPreviewComposeOverlay,
} from '../src/core/preview-stack';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const instanceDir = resolve(required('PREVIEW_INSTANCE_DIR'));
const stateDir = resolve(required('PREVIEW_STATE_DIR'));
const origin = required('PREVIEW_ORIGIN');
const sha = required('PREVIEW_SHA');
const secretsFile = resolve(required('PREVIEW_SECRETS_FILE'));
const secrets = JSON.parse(await readFile(secretsFile, 'utf8')) as Record<string, string>;
const envPath = join(instanceDir, '.env');
const configured = applyPreviewEnvironment(
  await readFile(envPath, 'utf8'),
  {
    origin,
    sha,
    apiImage: `kortix/kortix-api:pr-${sha}`,
    gatewayImage: `kortix/kortix-gateway:pr-${sha}`,
    frontendImage: `kortix/kortix-frontend:pr-${sha}`,
  },
  secrets,
);

await mkdir(stateDir, { recursive: true });
await writeFile(envPath, configured.runtimeEnv, { mode: 0o600 });
await chmod(envPath, 0o600);
const testEnvPath = join(instanceDir, '.env.test');
await writeFile(testEnvPath, configured.testEnv, { mode: 0o600 });
await chmod(testEnvPath, 0o600);
await writeFile(join(stateDir, 'Caddyfile.preview'), buildPreviewCaddyfile(), { mode: 0o644 });
await writeFile(
  join(stateDir, 'docker-compose.preview.yml'),
  buildPreviewComposeOverlay(
    '/workspace/suna/tests/test-results',
    join(stateDir, 'Caddyfile.preview'),
  ),
  { mode: 0o644 },
);

console.log(`[preview-stack] configured origin=${origin} sha=${sha}`);
