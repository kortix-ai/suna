// Live presence on an Artifact (flags `artifacts` + `artifact_comments`): the
// REST half. A viewer mints a one-use ticket and opens the WebSocket with it
// (`createArtifactLiveConnection`); an agent session names its place in the
// Artifact (`kortix artifacts focus`).

import { backendApi } from '../../http/api-client';
import type { ArtifactLiveAgentSignal } from '../../artifact-live/protocol';
import { unwrap } from './shared';

/** A one-use WebSocket ticket. It expires 60 s after `expires_at` was minted. */
export interface ArtifactLiveTicket {
  ticket: string;
  expires_at: string;
}

const live = (projectId: string, artifactId: string) =>
  `/workspaces/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/live`;

/**
 * Mint a ticket for `GET …/live?ticket=` (the WebSocket). It works once, within
 * 60 s. `403 feature_disabled` while the flags are off; `404` when the caller
 * cannot view the Artifact. Failures never reach `onError`: the live
 * connection retries and reports through its status.
 */
export async function createArtifactLiveTicket(projectId: string, artifactId: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactLiveTicket> {
  return unwrap(await backendApi.post<ArtifactLiveTicket>(`${live(projectId, artifactId)}/ticket`, undefined, { showErrors: false, signal: options.signal }));
}

/**
 * An agent session names its place in the Artifact: reading a thread, editing
 * near a quote, writing a reply, or `idle` (it leaves the presence list). Only a
 * session-bound token may call it; a person's token answers `403`.
 */
export async function signalArtifactLiveAgent(projectId: string, artifactId: string, signal: ArtifactLiveAgentSignal): Promise<void> {
  unwrap(await backendApi.post<unknown>(`${live(projectId, artifactId)}/agent`, signal));
}
