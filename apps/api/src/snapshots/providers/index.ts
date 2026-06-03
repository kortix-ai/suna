/**
 * Sandbox provider adapters.
 *
 * A provider builds and hosts the actual sandbox image. Today there's one:
 * Daytona. Future providers (e.g. Vercel Sandbox, local Docker) implement the
 * `SandboxProviderAdapter` interface and slot in here.
 *
 * The provider is identified by a stable string (`daytona`, `local`, …) that
 * lives on the template row. The session boot path resolves the adapter by
 * that string and delegates the actual snapshot build / state check.
 */

import { daytonaProvider } from './daytona';
import type { SandboxProviderAdapter } from './types';

export type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './types';

const ADAPTERS = new Map<string, SandboxProviderAdapter>();
ADAPTERS.set(daytonaProvider.id, daytonaProvider);

export function getSandboxProvider(id: string): SandboxProviderAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unknown sandbox provider: ${id}`);
  }
  return adapter;
}
