/**
 * The names the composer uses for the session runtime's lists. The data comes
 * from `@kortix/sdk/react` (`useRuntimeConfig`, `useRuntimeCommands`,
 * `useRuntimeProviders`); this module only names the shapes.
 */
import type { PickerProviderListInput, projectConfigAgentsToRuntimeAgents } from '@kortix/sdk';

/** The composer's agent (web's `threadAgents` → `composerSelectableAgents`). */
export type Agent = ReturnType<typeof projectConfigAgentsToRuntimeAgents>[number];

export type { Command, FlatModel } from '@kortix/sdk';

/** A provider list in the shape the model picker reads. */
export type ProviderListResponse = NonNullable<PickerProviderListInput['runtimeProviders']>;
