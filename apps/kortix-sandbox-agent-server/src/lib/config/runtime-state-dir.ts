/**
 * Durable daemon state must live under the runtime user's home directory.
 * Platinum replaces /run after image creation and starts the entrypoint as
 * `kortix`, so image-time ownership and root-only entrypoint repairs cannot
 * make /var/run/kortix reliable.
 *
 * Host-level: every harness keeps its durable pins and spools under this
 * directory, in its own subdirectory.
 */
export const DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY = '/home/kortix/.local/state/kortix'

export function resolveKortixRuntimeStateDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.KORTIX_RUNTIME_STATE_DIR?.trim() || DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY
}
