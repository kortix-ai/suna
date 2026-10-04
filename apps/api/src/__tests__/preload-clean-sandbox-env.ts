// Scrub the host sandbox's injected env for every API test process.
import { scrubHostSandboxEnv } from '@kortix/shared/test-sandbox-env';

scrubHostSandboxEnv();
