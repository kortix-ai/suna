/**
 * Re-export shim. Runtime artifact hashing is shared by the API snapshot
 * identity and the CLI build attestation.
 */
export {
  buildArtifactContentDigest,
  buildCliExecutorSourceDigest,
  buildRuntimeArtifactFingerprint,
  CLI_EXECUTOR_RUNTIME_FILES,
  cliExecutorRuntimeArtifacts,
} from '@kortix/shared/sandbox-runtime-artifact';
export type {
  RuntimeArtifact,
  RuntimeArtifactFingerprintInput,
} from '@kortix/shared/sandbox-runtime-artifact';
