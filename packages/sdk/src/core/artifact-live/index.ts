/**
 * Live presence on an Artifact: the public names. The wire frames, the
 * parser and the limits stay internal; a host works with events and setters.
 * The ticket and agent-signal REST calls are in `rest/projects-client/artifact-live`.
 */
export {
  createArtifactLiveConnection,
  type ArtifactLiveConnection,
  type ArtifactLiveConnectionOptions,
  type ArtifactLiveConnectionStatus,
  type ArtifactLiveEvent,
  type ArtifactLiveSocket,
  type ArtifactLiveWebSocket,
} from './connection';
export type {
  ArtifactLiveAgentSignal,
  ArtifactLiveChange,
  ArtifactLiveColor,
  ArtifactLiveParticipant,
  ArtifactLivePosition,
  ArtifactLiveRange,
  ArtifactLiveStatus,
  ArtifactLiveTyping,
  ArtifactLiveView,
} from './protocol';
