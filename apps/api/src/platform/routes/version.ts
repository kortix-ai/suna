import { Hono } from 'hono';
import { SANDBOX_VERSION } from '../../config';

type VersionChannel = 'stable' | 'dev';

function detectVersionChannel(version: string | null | undefined): VersionChannel {
  return version?.startsWith('dev-') ? 'dev' : 'stable';
}

export const versionRouter = new Hono();

versionRouter.get('/', (c) => {
  return c.json({
    version: SANDBOX_VERSION,
    channel: detectVersionChannel(SANDBOX_VERSION),
  });
});
