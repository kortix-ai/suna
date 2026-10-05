/**
 * Boot artifacts: one release's prebuilt sandbox runtime (the daemon, the
 * `kortix` CLI, the OpenCode binary, the managed skills) on a Platinum volume,
 * tagged per release by scripts/boot-artifacts/publish.ts. Every Platinum
 * session box mounts the configured tag read-only at a fixed path, and its
 * entrypoint and daemon take those files instead of downloading them, so a box
 * whose image is older than the release still boots on the release.
 *
 * One setting, `KORTIX_BOOT_ARTIFACTS=<volume>@<tag>`. The mount is an
 * optimization and never a reason a session fails to start: a tag that does
 * not resolve is left out (and logged), and the box boots from its image.
 */
import { config } from '../../config';
import { isPlatinumConfigured, platinumFetch } from '../../shared/platinum';

export const BOOT_ARTIFACTS_MOUNT_PATH = '/opt/kortix-artifacts';

export interface BootArtifactsMount {
  mountPath: string;
  volume: string;
  ref: string;
}

/** `<volume>@<tag>` from the setting, or null when unset or malformed. */
export function parseBootArtifacts(raw: string | undefined | null): { volume: string; ref: string } | null {
  const value = (raw ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { volume: value.slice(0, at), ref: value.slice(at + 1) };
}

const CHECK_TTL_MS = 5 * 60_000;
let checked: { key: string; ok: boolean; at: number } | null = null;

/**
 * The read-only mount every Platinum session box gets, or null. The tag is
 * checked against Platinum (cached five minutes) so a typo or an unpublished
 * release costs one log line, not every session.
 */
export async function bootArtifactsMount(): Promise<BootArtifactsMount | null> {
  const parsed = parseBootArtifacts(config.KORTIX_BOOT_ARTIFACTS);
  if (!parsed || !isPlatinumConfigured()) return null;
  const key = `${parsed.volume}@${parsed.ref}`;
  if (!checked || checked.key !== key || Date.now() - checked.at > CHECK_TTL_MS) {
    let ok = false;
    try {
      const res = await platinumFetch(
        `/v1/volumes/${encodeURIComponent(parsed.volume)}/commits/${encodeURIComponent(parsed.ref)}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      ok = res.ok;
      if (!ok) console.warn(`[boot-artifacts] ${key} does not resolve (${res.status}); sessions boot from their image`);
    } catch (err) {
      // Platinum unreachable: the create below fails on its own; keep the last answer.
      console.warn('[boot-artifacts] checking the tag failed:', err instanceof Error ? err.message : err);
      ok = checked?.key === key ? checked.ok : false;
    }
    checked = { key, ok, at: Date.now() };
  }
  return checked.ok ? { mountPath: BOOT_ARTIFACTS_MOUNT_PATH, ...parsed } : null;
}

export function _resetBootArtifactsForTests(): void {
  checked = null;
}
