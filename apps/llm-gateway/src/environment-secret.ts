import { hydrateEnvironmentSecret } from '@kortix/shared';

// This module must be the first import in main.ts. Server and observability
// modules read process.env during module evaluation.
hydrateEnvironmentSecret();
