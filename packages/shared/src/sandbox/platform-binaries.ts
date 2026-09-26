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
 * gives that user NOPASSWD:ALL sudo.
 *
 * THE DIRECTORY ONLY. Naming the file as well cost a full duplicate of the CLI
 * in the image. On apps/sandbox/Dockerfile the CLI arrives in an earlier layer
 * via `COPY --from=cli-builder --chown=kortix:kortix`, so it is ALREADY owned
 * by `kortix` and the chown changes nothing — but chown writes an inode, and an
 * inode write in a later layer forces overlayfs to copy the whole file up into
 * that layer. Measured on `linux/arm64` with a 105,000,000-byte stand-in: the
 * `RUN` layer is 105,000,000 bytes with the file named and 0 bytes without it,
 * and the image is 307,221,347 vs 202,221,347 bytes.
 *
 * Dropping it loses nothing. Replacement is `rename(2)` into this directory,
 * which takes its permission from the DIRECTORY; the file's own owner never
 * entered into it. On the two images that `gunzip` the CLI as root in the same
 * `RUN` the file simply stays root-owned at 0755 — replaceable, not writable in
 * place, which is the weaker privilege and the one the platform actually wants.
 *
 * This change and the supervised gate in apps/cli ship together on purpose.
 * Measured on a real box: with this directory writable, kortix.com/install
 * does not fall back to ~/.local/bin — it REPLACES /usr/local/bin/kortix with
 * a symlink to a public build. Making the CLI replaceable by the daemon makes
 * it replaceable by that installer too, so the gate that stops the CLI from
 * offering the installer is not optional.
 *
 * Runs as root. Single line, no heredoc: E2B's Dockerfile parser cannot read
 * heredocs.
 */
export const SANDBOX_CLI_OWNERSHIP_COMMAND = 'chown kortix:kortix /usr/local/bin';

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
  // `mkdir -p`, not `install -d -m 0755`: /home/kortix/.config already exists
  // at 0700 on a built image, and `install -d` would chmod it to 0755. Nothing
  // in a single-user sandbox depends on that being private, but loosening a
  // mode is not this command's job.
  'mkdir -p /home/kortix/.config/opencode' +
  ' && chown kortix:kortix /home/kortix/.config /home/kortix/.config/opencode' +
  ` && echo '{"autoupdate":false}' > ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}` +
  ` && chown kortix:kortix ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}` +
  ` && chmod 0644 ${SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH}`;
