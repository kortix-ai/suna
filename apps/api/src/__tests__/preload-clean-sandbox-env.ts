// Scrub the host sandbox's injected env for every API test process. See
// packages/shared/src/host-config/test-sandbox-env.ts.
import { scrubHostSandboxEnv } from '@kortix/shared/test-sandbox-env';

scrubHostSandboxEnv();
