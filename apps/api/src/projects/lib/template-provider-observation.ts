/** How a project's provider pin shapes its sandbox template and snapshot reads. */
import { resolveConfiguredProjectProviderPin } from '../../snapshots/provider-coverage';

export function templateProviderObservation(metadata: unknown) {
  const selectedProvider = resolveConfiguredProjectProviderPin(
    metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null,
  );
  return {
    selectedProvider,
    providerMode: selectedProvider ? 'pinned' as const : 'automatic' as const,
    listOptions: { selectedProvider, includeProviderCoverage: true } as const,
  };
}
