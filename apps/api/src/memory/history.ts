/**
 * A page's history, read from Drive commits: no table. A Drive
 * commit is the whole drive, so the newest 100 commits may reach back hours,
 * not weeks, on a busy drive. Older versions: Files → Versions (admins).
 *
 * The file at each commit is stated (8 at a time); a run of commits with the
 * same file version is one entry, dated and authored by the commit that made it.
 */
import type { MemoryAuthor, MemoryVersion } from '@kortix/api-contract';
import type { VolumeCommit, VolumeFileStat } from '../drives/volumes';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { agentSegmentOf, pagePath, parsePage, versionIdOf, volumeOps } from './files';
import type { Layer } from './layers';

const COMMITS = 100;
const ENTRIES = 20;
const CONCURRENCY = 8;
const CACHE_MAX = 5000;

// replica-local: a file at a commit never changes, so its stat and text are cached by (drive, commit, path).
const stats = new Map<string, VolumeFileStat | null>();
// replica-local: see `stats`.
const texts = new Map<string, string | null>();

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

async function statAt(layer: Layer, path: string, commit: string): Promise<VolumeFileStat | null> {
  const key = `${layer.drive.driveId}\n${commit}\n${path}`;
  if (stats.has(key)) return stats.get(key)!;
  return remember(stats, key, await volumeOps().stat(layer.drive, path, commit));
}

async function textAt(layer: Layer, path: string, commit: string): Promise<string | null> {
  const key = `${layer.drive.driveId}\n${commit}\n${path}`;
  if (texts.has(key)) return texts.get(key)!;
  return remember(texts, key, (await volumeOps().read(layer.drive, path, { at: commit }))?.text ?? null);
}

/** A commit's author as memory names it: a session's sync is an agent, a Files write a person. */
function commitAuthor(commit: VolumeCommit): MemoryAuthor {
  if (commit.author?.kind === 'sandbox' || commit.kind === 'merge' || commit.kind === 'fast') return { kind: 'agent', user_id: null, name: null, agent: null };
  if (commit.author?.kind === 'api_key' || commit.author?.kind === 'user') return { kind: 'person', user_id: null, name: null, agent: null };
  return { kind: 'system', user_id: null, name: null, agent: null };
}

/** One distinct version of the file: the commit that made it, or an absence (`stat` null). */
export interface Run {
  commit: VolumeCommit;
  stat: VolumeFileStat | null;
}

/**
 * Collapse newest-first `(commit, stat)` pairs into runs of one file version
 * (pure). A run is named by its oldest commit: the one that wrote that version.
 */
export function runsOf(pairs: readonly Run[]): Run[] {
  const versionOf = (stat: VolumeFileStat | null) => (stat ? (stat.version ?? `${stat.mtime}:${stat.size}`) : null);
  const runs: Run[] = [];
  for (const pair of pairs) {
    const last = runs[runs.length - 1];
    if (last && versionOf(last.stat) === versionOf(pair.stat)) runs[runs.length - 1] = pair;
    else runs.push(pair);
  }
  return runs;
}

async function fileRuns(layer: Layer, path: string): Promise<Run[]> {
  const commits = await volumeOps().commits(layer.drive, COMMITS);
  const pairs: Run[] = await mapWithConcurrency(commits, CONCURRENCY, async (commit) => ({ commit, stat: await statAt(layer, path, commit.id) }));
  // Fewer commits than asked: this is the drive's whole history, and before its first commit no file existed.
  if (commits.length < COMMITS && commits.length > 0) {
    const first = commits[commits.length - 1]!;
    pairs.push({ commit: { ...first, id: `before:${first.id}` }, stat: null });
  }
  return runsOf(pairs);
}

export async function pageHistory(layer: Layer, rel: string): Promise<{ versions: MemoryVersion[] }> {
  const path = pagePath(layer, rel);
  const runs = await fileRuns(layer, path);
  const live = runs.map((run, i) => ({ run, i })).filter(({ run }) => run.stat !== null);
  const versions = await mapWithConcurrency(live.slice(0, ENTRIES), CONCURRENCY, async ({ run, i }): Promise<MemoryVersion> => {
    const page = parsePage((await textAt(layer, path, run.commit.id)) ?? '', rel, agentSegmentOf(layer));
    const older = runs[i + 1];
    return {
      version_id: versionIdOf(layer.key, rel, run.commit.id),
      version_no: Date.parse(run.commit.created_at),
      op: older && older.stat === null ? 'create' : 'update',
      author: page.updatedBy ?? commitAuthor(run.commit),
      created_at: run.commit.created_at,
      snapshot: { type: page.type, title: page.title, summary: page.summary, body: page.body, related: page.related, deleted: false },
    };
  });
  return { versions };
}
