import { hydrateEnvironmentSecret } from '@kortix/shared';

// This module must be the first import in index.ts. Observability and provider
// modules read process.env during module evaluation.
hydrateEnvironmentSecret();
