#!/usr/bin/env bun
/**
 * Legacy JustAVPS SSH bridge helper.
 *
 * The repo-first v1 runtime does not expose the old host/container bridge as a
 * production path. Session access goes through project-scoped API auth and the
 * signed sandbox proxy. This helper stays as a clear guard instead of importing
 * deleted legacy provider/update modules.
 */

console.error([
  'apps/api/scripts/apply-justavps-ssh-bridge.ts is disabled for repo-first Kortix v1.',
  '',
  'Use /v1/projects/:projectId/sessions and /v1/p/<external_id>/8000/*',
  'through the signed proxy instead of the legacy JustAVPS SSH bridge.',
].join('\n'));

process.exit(1);
