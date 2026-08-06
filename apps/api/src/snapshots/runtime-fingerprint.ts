/**
 * Re-export shim. Runtime artifact hashing is shared by the API snapshot
 * identity and the CLI build attestation.
 */
export {
  buildArtifactContentDigest,
  buildCliConnectorSourceDigest,
  buildRuntimeArtifactFingerprint,
  CLI_CONNECTOR_RUNTIME_FILES,
  cliConnectorRuntimeArtifacts,
} from '@kortix/shared/sandbox-runtime-artifact';
export type {
  RuntimeArtifact,
  RuntimeArtifactFingerprintInput,
} from '@kortix/shared/sandbox-runtime-artifact';
