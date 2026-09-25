/**
 * Inside a managed sandbox the PLATFORM owns the binaries. Two image
 * invariants make that true rather than aspirational, and both belong to every
 * image definition — the standard layer (platform default + every custom
 * template), the meta-agent image, and the hand-maintained
 * apps/sandbox/Dockerfile. `platform-binaries.test.ts` asserts all three.
 */

/**
 * Let the daemon REPLACE the CLI it converges.
 *
 * runtime-assets.ts writes the downloaded binary to a temp file NEXT TO
 * /usr/local/bin/kortix and renames it into place — rename(2) is only atomic
 * within one filesystem, so the temp file cannot live elsewhere. Both the
 * create and the rename take their permission from the DIRECTORY, which is
 * root-owned by default while the daemon runs as `kortix`. Every digest
 * mismatch therefore failed with EACCES and the box reported
 * `components.cli: failed`, observed on a fresh Platinum box. `COPY --chown`
 * on the file never fixed it, because the write is a directory write.
 *
 * Handing the directory to `kortix` grants no new privilege: the image already
 * gives that user NOPASSWD:ALL sudo. The file is named explicitly as well so
 * the owner is right on the images that gunzip it as root.
 *
 * Runs as root. Single line, no heredoc: E2B's Dockerfile parser cannot read
 * heredocs.
 */
export const SANDBOX_CLI_OWNERSHIP_COMMAND =
  'chown kortix:kortix /usr/local/bin /usr/local/bin/kortix';

/** Where every `opencode` invocation reads its global config. */
export const SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH =
  '/home/kortix/.config/opencode/opencode.json';

/**
 * Pin OpenCode's own autoupdate off for EVERY caller in the box.
 *
 * `autoupdate: false` previously reached opencode only through
 * OPENCODE_CONFIG, which the daemon sets on the process IT spawns. A human
 * typing `opencode` in the Session terminal inherits no such var (the daemon
 * keeps it out of the sourced agent-env file on purpose) and ran with
 * autoupdate ON. That update is a plain `pnpm add -g`, which skips the
 * postinstall: the launcher becomes a 479-byte stub, the old global dir is
 * deleted, and /opt/kortix/opencode.current dangles. Session dead. That is the
 * 2026-08-22 and 2026-08-25 incident shape.
 *
 * The global config file is read by every invocation, including one that has
 * OPENCODE_CONFIG pointing at another file — verified directly against
 * opencode 1.18.23, which still parses and reports errors from this path with
 * OPENCODE_CONFIG set. So the daemon's own child keeps working unchanged: it
 * already sets the same value.
 *
 * Owned by `kortix`, not root: the agent has NOPASSWD sudo anyway, so
 * root-owning it buys no boundary, and a writable path avoids inventing a new
 * EACCES for anything opencode may want to write here. Runs as root (it must
 * create the directory as `kortix`), single line, no heredoc.
 */
export const SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND =
  'install -d -o kortix -g kortix -m 0755 /home/kortix/.config /home/kortix/.config/opencode' +
  ` && echo '{"autoupdate":false}' > ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}` +
  ` && chown kortix:kortix ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}` +
  ` && chmod 0644 ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}`;
