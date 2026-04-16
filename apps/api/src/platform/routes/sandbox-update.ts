/**
 * Sandbox update routes — Docker image-based updates.
 *
 * Routes:
 *   POST /v1/platform/sandbox/:id/update         — start update for a specific sandbox
 *   GET  /v1/platform/sandbox/:id/update/status   — poll progress
 *   POST /v1/platform/sandbox/:id/update/reset    — reset failed status
 *
 *   POST /v1/platform/sandbox/update              — legacy (local_docker fallback)
 *   GET  /v1/platform/sandbox/update/status        — legacy
 *   POST /v1/platform/sandbox/update/reset         — legacy
 */

import { Hono } from 'hono';
import { db } from '../../shared/db';
import {
  LocalDockerProvider,
  getSandboxUpdateStatus,
  resetSandboxUpdateStatus,
} from '../providers/local-docker';
import { getProvider, type ProviderName } from '../providers';
import { combinedAuth as authMiddleware } from '../../middleware/auth';
import { resolveAccountId } from '../../shared/resolve-account';
import {
  executeUpdate,
  getUpdateStatus,
  resetUpdateStatus,
  requestUpdateCancellation,
} from '../../update';
import type { AuthVariables } from '../../types';
import { findAccessibleSandboxForUser } from '../services/sandbox-access';

// ── Per-sandbox routes: /sandbox/:id/update/* ────────────────────────────────

export const sandboxIdUpdateRouter = new Hono<{ Variables: AuthVariables }>();
sandboxIdUpdateRouter.use('/*', authMiddleware);

async function findOwnedSandbox(userId: string, sandboxId: string) {
  const { sandbox } = await findAccessibleSandboxForUser({
    db,
    userId,
    sandboxId,
    resolveAccountId,
  });
  return sandbox;
}

sandboxIdUpdateRouter.post('/', async (c) => {
  const sandboxId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const targetVersion = body?.version;

  if (!targetVersion || typeof targetVersion !== 'string') {
    return c.json({ success: false, error: 'Missing or invalid version' }, 400);
  }

  const userId = c.get('userId');
  const sandbox = await findOwnedSandbox(userId, sandboxId);

  if (!sandbox) {
    return c.json({ success: false, error: 'Sandbox not found' }, 404);
  }

  if (sandbox.provider === 'local_docker') {
    let provider: LocalDockerProvider;
    try {
      const p = getProvider('local_docker' as ProviderName);
      if (!(p instanceof LocalDockerProvider)) {
        return c.json({ success: false, error: 'local_docker provider not available' }, 400);
      }
      provider = p;
    } catch {
      return c.json({ success: false, error: 'local_docker provider not available' }, 400);
    }

    const currentStatus = getSandboxUpdateStatus();
    if (currentStatus.phase !== 'idle' && currentStatus.phase !== 'complete' && currentStatus.phase !== 'failed') {
      return c.json({
        success: false,
        error: `Update already in progress (phase: ${currentStatus.phase})`,
        status: currentStatus,
      }, 409);
    }

    provider.updateSandbox(targetVersion).catch((err) => {
      console.error('[SANDBOX-UPDATE] Local Docker update failed:', err.message || err);
    });

    return c.json({
      success: true,
      started: true,
      message: `Update to v${targetVersion} started. Poll GET /status for progress.`,
      targetVersion,
      sandboxId: sandbox.sandboxId,
      provider: 'local_docker',
    });
  }

  // Any remote provider — uses toolbox exec for docker commands
  const status = await getUpdateStatus(sandbox.sandboxId);
  if (status.phase !== 'idle' && status.phase !== 'complete' && status.phase !== 'failed') {
    return c.json({
      success: false,
      error: `Update already in progress (phase: ${status.phase})`,
      status,
    }, 409);
  }

  executeUpdate(sandbox.sandboxId, targetVersion).catch((err) => {
    console.error('[SANDBOX-UPDATE] Update failed:', err.message || err);
  });

  return c.json({
    success: true,
    started: true,
    message: `Update to v${targetVersion} started. Poll GET /status for progress.`,
    targetVersion,
    sandboxId: sandbox.sandboxId,
    provider: sandbox.provider,
  });
});

sandboxIdUpdateRouter.get('/status', async (c) => {
  const sandboxId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  const sandbox = await findOwnedSandbox(userId, sandboxId);

  if (!sandbox) {
    return c.json({ success: false, error: 'Sandbox not found' }, 404);
  }

  if (sandbox.provider === 'local_docker') {
    return c.json(getSandboxUpdateStatus());
  }

  return c.json(await getUpdateStatus(sandbox.sandboxId));
});

sandboxIdUpdateRouter.post('/reset', async (c) => {
  const sandboxId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  const sandbox = await findOwnedSandbox(userId, sandboxId);

  if (!sandbox) {
    return c.json({ success: false, error: 'Sandbox not found' }, 404);
  }

  if (sandbox.provider === 'local_docker') {
    resetSandboxUpdateStatus();
    return c.json({ success: true, message: 'Update status reset to idle' });
  }

  await resetUpdateStatus(sandbox.sandboxId);
  return c.json({ success: true, message: 'Update status reset' });
});

sandboxIdUpdateRouter.post('/cancel', async (c) => {
  const sandboxId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  const sandbox = await findOwnedSandbox(userId, sandboxId);

  if (!sandbox) {
    return c.json({ success: false, error: 'Sandbox not found' }, 404);
  }

  if (sandbox.provider === 'local_docker') {
    return c.json({ success: false, error: 'Cancelling local updates is not supported' }, 400);
  }

  const status = await getUpdateStatus(sandbox.sandboxId);
  if (status.phase !== 'backing_up') {
    return c.json({
      success: false,
      error: 'Cancellation is only available while the pre-update backup is running',
      status,
    }, 409);
  }

  const next = await requestUpdateCancellation(sandbox.sandboxId);
  return c.json({ success: true, message: 'Cancellation requested', status: next });
});

// ── Legacy routes: /sandbox/update/* (no sandbox ID, picks most recent) ──────

const sandboxUpdateRouter = new Hono<{ Variables: AuthVariables }>();
sandboxUpdateRouter.use('/*', authMiddleware);

sandboxUpdateRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const targetVersion = body?.version;

  if (!targetVersion || typeof targetVersion !== 'string') {
    return c.json({ success: false, error: 'Missing or invalid version' }, 400);
  }

  let provider: LocalDockerProvider;
  try {
    const p = getProvider('local_docker' as ProviderName);
    if (!(p instanceof LocalDockerProvider)) {
      return c.json({ success: false, error: 'Use /sandbox/:id/update for non-local providers' }, 400);
    }
    provider = p;
  } catch {
    return c.json({ success: false, error: 'local_docker provider not available' }, 400);
  }

  const currentStatus = getSandboxUpdateStatus();
  if (currentStatus.phase !== 'idle' && currentStatus.phase !== 'complete' && currentStatus.phase !== 'failed') {
    return c.json({
      success: false,
      error: `Update already in progress (phase: ${currentStatus.phase})`,
      status: currentStatus,
    }, 409);
  }

  provider.updateSandbox(targetVersion).catch((err) => {
    console.error('[SANDBOX-UPDATE] Local Docker update failed:', err.message || err);
  });

  return c.json({
    success: true,
    started: true,
    message: `Update to v${targetVersion} started. Poll GET /status for progress.`,
    targetVersion,
    provider: 'local_docker',
  });
});

sandboxUpdateRouter.get('/status', async (c) => {
  return c.json(getSandboxUpdateStatus());
});

sandboxUpdateRouter.post('/reset', async (c) => {
  resetSandboxUpdateStatus();
  return c.json({ success: true, message: 'Update status reset to idle' });
});

sandboxUpdateRouter.post('/cancel', async (c) => {
  return c.json({ success: false, error: 'Cancelling local updates is not supported' }, 400);
});

export { sandboxUpdateRouter };
