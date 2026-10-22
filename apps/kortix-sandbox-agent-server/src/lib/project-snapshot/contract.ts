/**
 * The project snapshot: one commit's working tree in S3, verified on the way
 * in. Two services read it: workspace-provider builds the session checkout
 * from it, and config-provider builds a config release from its files.
 *
 *   descriptor (Git proxy, KORTIX_TOKEN)  →  two presigned GETs (no credential)
 *   boot object  →  stage FILE (sha256 + byte cap + inactivity watchdog on the
 *                   stream, tar headers guarded on a tee of the same stream)
 *                →  digest verified  →  native `tar` extraction (in-process
 *                   fallback)  →  marker / .git/config / HEAD verified
 *                →  (workspace-provider) activate
 *   hydration    →  `git index-pack --stdin` fed from the stream, sha256 on
 *                   the way, pack marked promisor
 *
 * Files: descriptor.ts (the descriptor), transfer.ts (one presigned GET),
 * archive.ts (guard + extract), verify.ts (the extracted stage), stage.ts
 * (the retry loop that yields a verified stage), hydrate.ts (the blob pack),
 * errors.ts (the failure classification).
 *
 * The boot object is the working tree plus a `.git` whose ONE pack holds the
 * commit and trees, no blobs, marked promisor. The box is a valid partial
 * clone the moment the tar is extracted, so nothing runs git on the boot path;
 * `git status` and the harness's project scan need no blob. Blobs arrive
 * through the hydration object after activation. Until then a missing blob is
 * fetched lazily through the proxy (slower, never broken).
 *
 * Nothing is written outside the stage before the whole object has been
 * hashed and every tar header has passed the guard; a failed attempt removes
 * its own stage file/dir and nothing else. The sandbox env carries only the
 * boot object's IDENTITY (KORTIX_PROJECT_SNAPSHOT_PIN = sha:sha256:bytes); the
 * URLs are minted per boot by the API and expire in minutes.
 *
 * Every failure is classified (errors.ts); the caller decides whether it
 * falls back. Nothing here falls back or touches the live workspace.
 */

export const PROJECT_SNAPSHOT_FORMAT = 'project-snapshot-v2'

export const PROJECT_SNAPSHOT_MARKER_PATH = '.git/kortix-project-snapshot.json'

const SHA_RE = /^[0-9a-f]{40}$/

export const SHA256_RE = /^[0-9a-f]{64}$/

export interface ProjectSnapshotPin {
  sha: string
  sha256: string
  bytes: number
}

/** `<sha>:<sha256>:<bytes>` → pin, or null when malformed. */
export function parseProjectSnapshotPin(raw: string | undefined): ProjectSnapshotPin | null {
  if (!raw) return null
  const [sha, sha256, bytesRaw] = raw.trim().split(':')
  const bytes = Number(bytesRaw)
  if (!sha || !sha256 || !SHA_RE.test(sha.toLowerCase()) || !SHA256_RE.test(sha256.toLowerCase())) return null
  if (!Number.isInteger(bytes) || bytes <= 0) return null
  return { sha: sha.toLowerCase(), sha256: sha256.toLowerCase(), bytes }
}

export interface SnapshotObjectRef {
  url: string
  sha256: string
  bytes: number
  expires_at: string
}

export interface ProjectSnapshotDescriptor {
  format: typeof PROJECT_SNAPSHOT_FORMAT
  commit_sha: string
  ref: string
  repository: { owner: string; name: string; external_id: string }
  /** Boot object: working tree + blobless .git, tar.gz. Its identity is the session pin. */
  tree: SnapshotObjectRef & { entries: number }
  /** Hydration object: the tip's blob pack. */
  blobs: SnapshotObjectRef
}
