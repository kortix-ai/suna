/**
 * Apple-metadata-free tar options for every archive that ships into a sandbox
 * image.
 *
 * A macOS build host puts `com.apple.provenance` on every file it touches, and
 * `node:fs` `cp` preserves it into the staged context (verified: `xattr -l` on a
 * staged copy). Apple's bsdtar then does NOT write `._name` sidecars — it
 * encodes the xattr as pax extended headers instead:
 *
 *   57 LIBARCHIVE.xattr.com.apple.provenance=AQIAfFksS3TKO4s
 *   49 SCHILY.xattr.com.apple.provenance=
 *
 * The remote image builder materializes those headers as AppleDouble sidecars on
 * extraction. The result is a poisoned image: 262 `._*` files inside
 * `/workspace` (including `._.git` and `.git/objects/pack/._pack-*.idx`, which
 * makes git itself log `index file … is too small`) and 423 more under
 * `/opt/kortix`. OpenCode's ToolRegistry then tries to BUNDLE `._tools` /
 * `._kortix.md` as source, hits their NUL bytes, and every `session/prompt`
 * dies with `BuildMessage: Unexpected NUL` — memoized for the process
 * lifetime, so the sandbox never recovers. Proven on sandbox
 * sbx_01KYR3WB727W48MD6A9AR8VW7Q: deleting the sidecars and restarting the
 * harness made every prompt succeed.
 *
 * So strip the metadata at the source. `--no-xattrs` is what removes the pax
 * headers (measured: 6 `provenance` hits in the archive without it, 0 with it);
 * `COPYFILE_DISABLE=1` is Apple's own opt-out; `--exclude=._*` catches a
 * context that somehow already holds sidecars.
 *
 * The flags are applied on darwin ONLY. Linux hosts never produce Apple
 * metadata, GNU tar's `--no-xattrs` is a no-op there, and BusyBox tar rejects
 * the flag outright (verified: `alpine:3.20` → unsupported, `debian:stable-slim`
 * GNU tar 1.35 → accepted) — so a self-hosted Alpine-based API must not have
 * its snapshot builds broken by a macOS-only concern.
 */
const APPLE_METADATA_TAR_FLAGS = ['--no-xattrs', '--exclude=._*'] as const;

/** True on the only platform that emits Apple metadata into an archive. */
function hostEmitsAppleMetadata(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * Tar flags to insert directly after the mode flags of a staging archive.
 * Empty off darwin.
 */
export function appleMetadataTarFlags(platform: string = process.platform): string[] {
  return hostEmitsAppleMetadata(platform) ? [...APPLE_METADATA_TAR_FLAGS] : [];
}

/**
 * Env for a staging tar. `COPYFILE_DISABLE` is read by Apple's libarchive and
 * ignored by GNU tar, so it is safe to set unconditionally.
 */
export function stagingTarEnv(base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, COPYFILE_DISABLE: '1' };
}

/** Complete argv for a staging archive: `tar <mode flags> <apple flags> <rest>`. */
export function stagingTarArgs(
  modeFlags: string[],
  rest: string[],
  platform: string = process.platform,
): string[] {
  return [...modeFlags, ...appleMetadataTarFlags(platform), ...rest];
}

/**
 * Archive a staged build context for upload to an image builder. The single
 * place the context tarball is produced, so the Apple-metadata guarantee above
 * cannot be bypassed by a new provider adapter.
 */
export async function tarBuildContext(contextDir: string, tarPath: string): Promise<void> {
  const tar = Bun.spawn(['tar', ...stagingTarArgs(['-czf', tarPath], ['-C', contextDir, '.'])], {
    env: stagingTarEnv(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await tar.exited) !== 0) {
    const stderr = (await new Response(tar.stderr).text()).trim();
    throw new Error(`tar build context failed${stderr ? `: ${stderr}` : ''}`);
  }
}
