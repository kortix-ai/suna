/**
 * Deployment provider registry.
 *
 * Public entry point is `getProvider(name)`. New providers register
 * themselves by adding a single line to the `PROVIDERS` map below.
 */
import { ValidationError } from '../../errors';
import { freestyleProvider } from './freestyle';
import type { DeploymentProvider } from './types';

export const DEFAULT_PROVIDER_NAME = 'freestyle';

const PROVIDERS: Record<string, DeploymentProvider> = {
  [freestyleProvider.name]: freestyleProvider,
};

export function getProvider(name: string | null | undefined): DeploymentProvider {
  const key = (name || DEFAULT_PROVIDER_NAME).trim().toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new ValidationError(
      `Unknown deployment provider "${name}". Known: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return provider;
}

export type { DeploymentProvider, DeploymentRequest } from './types';
