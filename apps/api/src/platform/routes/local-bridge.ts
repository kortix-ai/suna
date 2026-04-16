import { Hono } from 'hono';
import { db } from '../../shared/db';
import {
  ensureGenericLocalSandboxRecord,
  serializeLocalSandbox,
} from '../services/local-sandbox-record';

const localBridgeRouter = new Hono();

localBridgeRouter.get('/local-bridge/status', async (c) => {
  const sandbox = await ensureGenericLocalSandboxRecord(db);

  if (!sandbox) {
    return c.json({ success: true, status: 'none', data: null });
  }

  return c.json({
    success: true,
    status: 'ready',
    data: serializeLocalSandbox(sandbox),
  });
});

export { localBridgeRouter };
