import 'server-only';

/**
 * The agent-written weekly summaries. Each Monday the `changelog-weekly`
 * trigger of the Kortix company project stores 1–5 highlights for every
 * closed week in `briefs.json` on the ref `refs/kortix/changelog-weekly` of
 * this repo. That ref is data only: no branch, never deployed. The page reads
 * it with the releases, so a new summary appears within one cache lifetime
 * (1 h) and needs no deploy.
 */
const REPO = 'kortix-ai/suna';
const REF = 'kortix/changelog-weekly';

/** Week id (`2026-W42`) → its highlight lines. */
export type WeeklyBriefs = Record<string, string[]>;

interface BriefsFile {
  version: number;
  weeks: Record<string, { highlights?: { text?: unknown }[] }>;
}

/**
 * Never throws: a missing ref (404), a GitHub error or a malformed file
 * returns `{}`, and the page shows the highlights it picks from the release
 * notes instead.
 */
export async function readWeeklyBriefs(fetchImpl: typeof fetch = fetch): Promise<WeeklyBriefs> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kortix-web',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const ref = await fetchImpl(`https://api.github.com/repos/${REPO}/git/ref/${REF}`, {
      headers,
      cache: 'no-store',
    });
    if (!ref.ok) return {};
    const sha = ((await ref.json()) as { object?: { sha?: string } }).object?.sha;
    if (!sha) return {};
    const res = await fetchImpl(
      `https://api.github.com/repos/${REPO}/contents/briefs.json?ref=${sha}`,
      { headers: { ...headers, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' },
    );
    if (!res.ok) return {};
    const file = (await res.json()) as BriefsFile;
    if (file?.version !== 1 || typeof file.weeks !== 'object' || !file.weeks) return {};
    const briefs: WeeklyBriefs = {};
    for (const [week, brief] of Object.entries(file.weeks)) {
      const lines = (brief?.highlights ?? [])
        .map((h) => (typeof h?.text === 'string' ? h.text.trim() : ''))
        .filter(Boolean);
      if (lines.length > 0) briefs[week] = lines;
    }
    return briefs;
  } catch {
    return {};
  }
}
