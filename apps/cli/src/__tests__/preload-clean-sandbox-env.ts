// Scrub the host sandbox's injected env for every CLI test process.
import { scrubHostSandboxEnv } from '@kortix/shared/test-sandbox-env';

scrubHostSandboxEnv();
