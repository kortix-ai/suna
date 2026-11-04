/**
 * Inside a managed sandbox the PLATFORM owns the binaries. The invariants
 * below make that true rather than aspirational, and each belongs to every
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

/** The image-baked managed `kortix-*` skill overlay the daemon overlays at boot. */
export const SANDBOX_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills';

/**
 * Where a box records which runtime assets it is running.
 *
 * Same constant as the daemon's `DEFAULT_STATE_PATH`
 * (apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-assets.ts);
 * `platform-binaries.test.ts` asserts the two spellings still agree.
 */
export const SANDBOX_RUNTIME_ASSETS_STATE_PATH = '/opt/kortix/runtime-assets-state.json';

/**
 * Bake the bookkeeping at IMAGE BUILD, not at first reconcile.
 *
 * Baking the CLI, the daemon and the skill overlay is only half of "this box
 * is current". Until this file exists the box answers `runtime.running` with
 * nulls, so the control plane cannot tell a fresh box from a months-old one —
 * measured at ~140 s on a cold preview box (boot 23:41:53, first pass complete
 * 23:44:15). And the pass that closes the window is not free: with no recorded
 * overlay hash the skills check cannot short-circuit, so every cold box
 * downloads an overlay it already carries and hashes ~210 MB of binaries to
 * learn that nothing changed.
 *
 * The verb runs the daemon binary the image just baked, so the digests,
 * the sizes and the mtimes describe the files that are actually there, and
 * the overlay hash comes from the daemon's own `overlayHash` rather than a
 * second implementation. It fails the build when an artifact is missing.
 */
export const SANDBOX_RUNTIME_ASSETS_STATE_COMMAND = 'kortix-agent bake-runtime-assets-state';
