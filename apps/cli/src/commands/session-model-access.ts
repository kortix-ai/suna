import { ApiError, type ApiClient } from '../api/client.ts';

/** The server's picker catalog includes only models connected for this caller.
 * Enablement is display-only: a hidden model can still run. */
export async function requireConnectedModel(client: ApiClient, projectId: string): Promise<void> {
  let catalog: { models: Record<string, unknown> };
  try {
    catalog = await client.get(`/projects/${projectId}/model-picker`);
  } catch (error) {
    // Native-provider projects and older self-hosted APIs have no gateway picker.
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
  if (Object.keys(catalog.models).length === 0) {
    throw new Error('No model connected — connect one to start chatting. Run `kortix models ls` to check model access.');
  }
}
