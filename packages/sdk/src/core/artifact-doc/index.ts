/**
 * Live co-editing of an Artifact doc (KRTX-3670): the sync engine. The REST
 * calls it drives are in `rest/projects-client/artifact-doc`; the base64
 * codec stays internal.
 */
export {
  createArtifactDocSync,
  type ArtifactDocBase,
  type ArtifactDocResetReason,
  type ArtifactDocSync,
  type ArtifactDocSyncClient,
  type ArtifactDocSyncOptions,
  type ArtifactDocSyncStatus,
} from './sync';
