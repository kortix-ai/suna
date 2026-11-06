// Scrub the host sandbox's injected env for every API test process.
// Same order as src/index.ts: zod 4 gives `.openapi()` only to schemas built after this.
import '@hono/zod-openapi';
import { scrubHostSandboxEnv } from '@kortix/shared/test-sandbox-env';

scrubHostSandboxEnv();
