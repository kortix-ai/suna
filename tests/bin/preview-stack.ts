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
// The images are normally built from the very commit being deployed. A hand
// deploy iterating on the TOOLING (tests/, .github/) may point at images built
// from an earlier commit whose product code is identical — PREVIEW_IMAGE_SHA —
// and at another Docker Hub namespace — PREVIEW_IMAGE_REPO. The API reports
// KORTIX_COMMIT from its environment (apps/api/src/index.ts), so the deploy's
// health check still sees the checkout's SHA. Both default to the CI shape.
const imageSha = process.env.PREVIEW_IMAGE_SHA?.trim() || sha;
if (!/^[0-9a-f]{40}$/.test(imageSha)) throw new Error('PREVIEW_IMAGE_SHA must be a full Git SHA');
const imageRepo = process.env.PREVIEW_IMAGE_REPO?.trim() || 'kortix';
if (!/^[a-z0-9][a-z0-9._/-]*$/.test(imageRepo)) {
  throw new Error('PREVIEW_IMAGE_REPO must be a registry namespace such as kortix');
}
const envPath = join(instanceDir, '.env');
const configured = applyPreviewEnvironment(
  await readFile(envPath, 'utf8'),
  {
    origin,
    sha,
    apiImage: `${imageRepo}/kortix-api:pr-${imageSha}`,
    gatewayImage: `${imageRepo}/kortix-gateway:pr-${imageSha}`,
    frontendImage: `${imageRepo}/kortix-frontend:pr-${imageSha}`,
  },
  secrets,
  // A gate keeps the default (fail before boot); the bootstrap sets 0 for a
  // branch environment, which is a place to work, not a gate.
  { requireManagedGit: process.env.PREVIEW_REQUIRE_MANAGED_GIT?.trim() !== '0' },
);

await mkdir(stateDir, { recursive: true });
await writeFile(envPath, configured.runtimeEnv, { mode: 0o600 });
await chmod(envPath, 0o600);
const testEnvPath = join(instanceDir, '.env.test');
await writeFile(testEnvPath, configured.testEnv, { mode: 0o600 });
await chmod(testEnvPath, 0o600);
await writeFile(join(stateDir, 'Caddyfile.preview'), buildPreviewCaddyfile(new URL(origin).host), { mode: 0o644 });
await writeFile(
  join(stateDir, 'docker-compose.preview.yml'),
  buildPreviewComposeOverlay(
    '/workspace/suna/tests/test-results',
    join(stateDir, 'Caddyfile.preview'),
  ),
  { mode: 0o644 },
);

console.log(`[preview-stack] configured origin=${origin} sha=${sha}`);
