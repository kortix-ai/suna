import { Hono } from 'hono';
import { config } from '../../config';

const localBridgeRouter = new Hono();

function getMappedPorts(): Record<string, string> {
  const base = config.SANDBOX_PORT_BASE || 14000;
  return {
    '8000': String(base + 0),
    '3111': String(base + 1),
    '6080': String(base + 2),
    '6081': String(base + 3),
    '3210': String(base + 4),
    '9223': String(base + 5),
    '9224': String(base + 6),
    '22': String(base + 7),
  };
}

async function getLocalBridgeStatus() {
  const sandboxHealthUrl = config.SANDBOX_NETWORK
    ? `http://${config.SANDBOX_CONTAINER_NAME}:8000/kortix/health`
    : `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/kortix/health`;

  try {
    const health = await fetch(sandboxHealthUrl, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) {
      return { success: true, status: 'none', message: 'No local sandbox found' };
    }

    const payload = await health.json() as { status?: string; runtimeReady?: boolean; version?: string };
    if (payload.status === 'ok' && payload.runtimeReady === true) {
      return {
        success: true,
        status: 'ready',
        data: {
          name: config.SANDBOX_CONTAINER_NAME,
          mappedPorts: getMappedPorts(),
          version: payload.version || null,
        },
      };
    }

    return {
      success: true,
      status: 'creating',
      progress: 95,
      message: 'Sandbox container is running and finishing Kortix boot...',
    };
  } catch {
    return { success: true, status: 'none', message: 'No local sandbox found' };
  }
}

localBridgeRouter.get('/local-bridge/status', async (c) => {
  return c.json(await getLocalBridgeStatus());
});

export { localBridgeRouter };
