import { config } from '../lib/config';
import { repoLabel, repoOgImage } from './slack/util';

// Repo previews on Slack and Teams cards: GitHub's social-preview image of the
// project repository. It exists only for a PUBLIC repository. For a private or
// missing one the image service answered `429` with a 42-byte HTML body, and
// minutes later `200` with the same generic 1200x630 placeholder for both
// (measured 2026-09-29). Teams drew a broken image beside every Kortix-hosted
// project, whose repo is always private, with its internal name under it.
//
// The image response cannot tell a real preview from a placeholder, so the
// repository page decides: `HEAD github.com/<owner>/<repo>` is 200 for a public
// repository and 404 for a private or missing one. Checked once per
// repository and cached. A Kortix-hosted repository is never checked.

/** A preview that loaded stays good for a day; a refusal is retried after an hour. */
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_ENTRIES = 500;

/** A Slack slash command must answer within 3 s, so it waits less for a first check. */
export const SLACK_PREVIEW_WAIT_MS = 1_000;

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const cache = new Map<string, { image: string | null; until: number }>();
const inflight = new Map<string, Promise<string | null>>();

/** Test hook. */
export function resetRepoPreviewCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * A repository in the org Kortix hosts project repositories in
 * (`MANAGED_GIT_GITHUB_OWNER`). It is private, and its name is internal:
 * `<slug>-<project id>`.
 */
export function isKortixHostedRepo(repoUrl: string, owner = config.MANAGED_GIT_GITHUB_OWNER): boolean {
  if (!owner) return false;
  const repoOwner = repoLabel(repoUrl).split('/')[0] ?? '';
  return repoOwner.toLowerCase() === owner.toLowerCase();
}

/** The repository as a person reads it: `owner/repo`, or "Hosted by Kortix". */
export function repoDisplayLabel(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  return isKortixHostedRepo(repoUrl) ? 'Hosted by Kortix' : repoLabel(repoUrl);
}

/** The preview when the repository is public, else null. */
async function probe(repoUrl: string, image: string, fetchImpl: FetchImpl): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://github.com/${repoLabel(repoUrl)}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 200 ? image : null;
  } catch {
    return null;
  }
}

function remember(repoUrl: string, image: string | null): void {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(repoUrl, { image, until: Date.now() + (image ? IMAGE_TTL_MS : MISS_TTL_MS) });
}

/**
 * The previews of public repositories, by repository URL. A repository missing from
 * the map shows no image. `waitMs` bounds the wait for a first probe: a Slack
 * slash command must answer within 3 s, so it shows what is already known and
 * the probe finishes in the background for the next card.
 */
export async function repoPreviewImages(
  repoUrls: Iterable<string | null | undefined>,
  opts: { waitMs?: number; fetchImpl?: FetchImpl } = {},
): Promise<Map<string, string>> {
  const fetchImpl = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const now = Date.now();
  const pending: Promise<unknown>[] = [];
  const wanted = new Set<string>();
  for (const repoUrl of repoUrls) {
    if (!repoUrl || wanted.has(repoUrl)) continue;
    wanted.add(repoUrl);
    if (isKortixHostedRepo(repoUrl)) continue;
    const url = repoOgImage(repoUrl);
    if (!url) continue;
    const hit = cache.get(repoUrl);
    if (hit && hit.until > now) continue;
    let running = inflight.get(repoUrl);
    if (!running) {
      running = probe(repoUrl, url, fetchImpl).then((image) => {
        remember(repoUrl, image);
        inflight.delete(repoUrl);
        return image;
      });
      inflight.set(repoUrl, running);
    }
    pending.push(running);
  }
  if (pending.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => {
        timer = setTimeout(resolve, opts.waitMs ?? PROBE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  const images = new Map<string, string>();
  for (const repoUrl of wanted) {
    const image = cache.get(repoUrl)?.image;
    if (image) images.set(repoUrl, image);
  }
  return images;
}
