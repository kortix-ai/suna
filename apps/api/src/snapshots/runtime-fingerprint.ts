/**
 * Re-export shim. Runtime artifact hashing is shared by the API snapshot
 * identity and the CLI build attestation.
 */
export {
  buildRuntimeArtifactFingerprint,
  cliConnectorRuntimeArtifacts,
} from '@kortix/shared/sandbox-runtime-artifact';
