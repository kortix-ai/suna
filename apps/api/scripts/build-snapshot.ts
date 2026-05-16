#!/usr/bin/env bun
/**
 * Legacy JustAVPS snapshot builder.
 *
 * Repo-first Kortix v1 provisions sessions through apps/api provider
 * implementations and uses the provider-neutral apps/sandbox image. The old
 * host-level JustAVPS snapshot flow is intentionally disabled so it cannot
 * keep the legacy instance/runtime path alive.
 */

console.error([
  'apps/api/scripts/build-snapshot.ts is disabled for repo-first Kortix v1.',
  '',
  'Build the v1 sandbox image instead:',
  '  docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .',
  '',
  'For cloud, publish that image and point the Daytona snapshot/provider',
  'configuration at it. Do not use the legacy JustAVPS snapshot bootstrap.',
].join('\n'));

process.exit(1);
