import { existsSync } from 'node:fs'

/**
 * Whether THIS box is a Kortix sandbox image. The image carries platform state
 * the host deliberately reads from disk (`/etc/pt-env` with
 * `KORTIX_PROJECT_AUTO_CLONE=1`, `/opt/kortix/scaffold.git`, the baked agent,
 * the managed-skills and llm-catalog files, a git repo at /workspace), so some
 * suites below assert machine states that only a clean CI runner has. CI has
 * none of these files and runs every suite unchanged; on an image the suites
 * skip with a reason instead of failing on files that are identical at
 * `origin/main`.
 */
export function onSandboxImage(): boolean {
  try {
    return existsSync('/etc/pt-env') || existsSync('/opt/kortix/scaffold.git')
  } catch {
    return false
  }
}
