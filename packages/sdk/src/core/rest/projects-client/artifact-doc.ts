// Live co-editing of an Artifact doc (KRTX-3670, flag `artifact_comments`,
// `type = 'doc'` only): the REST half. Each tab POSTs its Yjs updates; the
// server stores them under a per-Artifact `seq`, pings the live socket with
// `changed {what: 'doc'}`, and every tab GETs the updates after its last seq.
// One tab holds a lease and writes the Markdown file. The server keeps the
// Yjs bytes opaque, and so does the SDK: updates are `Uint8Array`, base64 on
// the wire. `createArtifactDocSync` (`core/artifact-doc/sync`) drives these
// calls; a host rarely calls them directly.
//
// Every seed starts a new `epoch`. A reset (`resetArtifactDoc`), or the GC of a
// doc nobody holds, deletes the state and its rows; the next open seeds it
// again from the file. A tab that sees the doc unseeded or under another
// epoch drops its Yjs state and starts over.
//
// Every call reports failures to the caller only, never to the global
// `onError`: the sync engine retries, and a toast per keystroke is noise.
// `html` Artifacts answer `400 not_a_doc`; with the flag off, the routes answer
// as the comment routes do. `413 doc_too_large`: the doc's stored updates
// passed their limit; the host edits without co-editing.

import { backendApi } from '../../http/api-client';
import { decodeBase64, encodeBase64 } from '../../artifact-doc/base64';
import { unwrap } from './shared';

/** One stored update: Yjs bytes and the seq the server gave them. */
export interface ArtifactDocUpdate {
  seq: number;
  update: Uint8Array;
}

/** `GET …/doc`: one page of the updates after a seq, and the doc state. */
export interface ArtifactDocPage {
  /** False until a tab seeds the doc (`seedArtifactDoc`); everything else is then empty. */
  seeded: boolean;
  /** The random id of the current seed; null when not seeded. A different epoch is a different Yjs doc. */
  epoch: string | null;
  /** The highest seq the server has given. */
  latest_seq: number;
  /** The updates with `seq > after`, ascending. A compacted row holds every seq at or below its own. */
  updates: ArtifactDocUpdate[];
  /** True when the page stopped at its size limit (~8 MiB): read the next page after the last seq. */
  has_more: boolean;
  /**
   * The last flush: every update with `seq` at or below it is in the Markdown
   * file, whose text was `markdown` (only with `base: true`) at `version`.
   */
  flushed: { seq: number; version: string | null; markdown?: string } | null;
  /** The tab that writes the file, while its lease runs. */
  lease: { holder: string; expires_at: string } | null;
}

/** The first state of a doc: the Yjs update built from the file's Markdown, that Markdown, and its `entry_version`. */
export interface ArtifactDocSeed {
  update: Uint8Array;
  markdown: string;
  version: string;
}

/** `POST …/doc/lease`: whether this holder leads, and who holds the lease until when (null when free). */
export interface ArtifactDocLease {
  leader: boolean;
  holder: string | null;
  expires_at: string | null;
}

/** `POST …/doc/flushed`: the leader wrote `markdown` as `version`, and it holds every update up to `seq`. */
export interface ArtifactDocFlush {
  holder: string;
  seq: number;
  version: string;
  markdown: string;
  /** The epoch the tab loaded. A different current epoch answers `409 epoch_mismatch`. */
  epoch?: string | null;
}

/** `{ epoch }` when there is one: the server checks it and answers `409 epoch_mismatch` when the doc was seeded again. */
const epochField = (epoch: string | null | undefined) => (typeof epoch === 'string' ? { epoch } : {});

interface WirePage {
  seeded: boolean;
  epoch?: string | null;
  latest_seq: unknown;
  updates?: Array<{ seq: unknown; update: unknown }>;
  has_more?: boolean;
  flushed: { seq: unknown; version: string | null; markdown?: string } | null;
  lease: { holder: string; expires_at: string } | null;
}

const doc = (projectId: string, artifactId: string) =>
  `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/doc`;

/** A `bigint` column may arrive as a JSON number or a decimal string. */
function toSeq(value: unknown, field: string): number {
  const seq = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError(`Artifact doc: ${field} is not a sequence number`);
  }
  return seq;
}

function toUpdate(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new TypeError('Artifact doc: an update is not a base64 string');
  return decodeBase64(value);
}

function toPage(raw: WirePage): ArtifactDocPage {
  return {
    seeded: raw.seeded === true,
    epoch: typeof raw.epoch === 'string' ? raw.epoch : null,
    latest_seq: toSeq(raw.latest_seq, 'latest_seq'),
    updates: (raw.updates ?? []).map((row) => ({ seq: toSeq(row.seq, 'seq'), update: toUpdate(row.update) })),
    has_more: raw.has_more === true,
    flushed: raw.flushed ? { ...raw.flushed, seq: toSeq(raw.flushed.seq, 'flushed.seq') } : null,
    lease: raw.lease ?? null,
  };
}

/**
 * Read the doc state and one page of the updates with `seq > after`
 * (default 0). `base: true` adds the last flushed Markdown. Throws
 * `RangeError` for an `after` that is not an integer ≥ 0, and `TypeError` for
 * a page that is not one (a bad seq or base64).
 */
export async function getArtifactDoc(
  projectId: string,
  artifactId: string,
  options: { after?: number; base?: boolean; signal?: AbortSignal } = {},
): Promise<ArtifactDocPage> {
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('getArtifactDoc: after must be an integer ≥ 0');
  const raw = unwrap(
    await backendApi.get<WirePage>(`${doc(projectId, artifactId)}?after=${after}${options.base ? '&base=true' : ''}`, {
      showErrors: false,
      signal: options.signal,
    }),
  );
  return toPage(raw);
}

/**
 * Create the doc state from its first update, built from the file. It starts a
 * new epoch (null when the server does not report it). `409 doc_seeded`:
 * another tab seeded it first; drop this seed (never apply it) and read the
 * doc instead.
 */
export async function seedArtifactDoc(projectId: string, artifactId: string, seed: ArtifactDocSeed): Promise<{ seq: number; epoch: string | null }> {
  const raw = unwrap(
    await backendApi.post<{ seq: unknown; epoch?: unknown }>(
      `${doc(projectId, artifactId)}/seed`,
      { update: encodeBase64(seed.update), markdown: seed.markdown, version: seed.version },
      { showErrors: false },
    ),
  );
  return { seq: toSeq(raw.seq, 'seq'), epoch: typeof raw.epoch === 'string' ? raw.epoch : null };
}

/**
 * Append one Yjs update (at most 512 KiB). `epoch`: the epoch the tab loaded.
 * Refusals: `409 doc_not_seeded`, `409 epoch_mismatch`, `413
 * update_too_large`, `413 doc_too_large`, `400 invalid_update`, `429` past the
 * per-user rate. `keepalive` lets the request outlive a closing tab (bodies
 * up to ~64 KiB).
 */
export async function pushArtifactDocUpdate(
  projectId: string,
  artifactId: string,
  update: Uint8Array,
  options: { keepalive?: boolean; epoch?: string | null } = {},
): Promise<{ seq: number }> {
  const raw = unwrap(
    await backendApi.post<{ seq: unknown }>(`${doc(projectId, artifactId)}/updates`, { update: encodeBase64(update), ...epochField(options.epoch) }, {
      showErrors: false,
      keepalive: options.keepalive === true,
    }),
  );
  return { seq: toSeq(raw.seq, 'seq') };
}

/**
 * Take, renew or (`release: true`) give up the lease of the tab that writes
 * the Markdown file. The lease runs 15 s; renew it every 5 s. Taking it works
 * when it is free, expired or already this holder's. `epoch`: the epoch the
 * tab loaded (`409 epoch_mismatch` when the doc was seeded again).
 */
export async function leaseArtifactDoc(
  projectId: string,
  artifactId: string,
  input: { holder: string; release?: boolean; epoch?: string | null },
  options: { keepalive?: boolean } = {},
): Promise<ArtifactDocLease> {
  const body = { holder: input.holder, ...(input.release ? { release: true } : {}), ...epochField(input.epoch) };
  const raw = unwrap(
    await backendApi.post<ArtifactDocLease>(`${doc(projectId, artifactId)}/lease`, body, {
      showErrors: false,
      keepalive: options.keepalive === true,
    }),
  );
  return { leader: raw.leader === true, holder: raw.holder ?? null, expires_at: raw.expires_at ?? null };
}

/**
 * Record a flush of the leader. The server keeps it only when `seq` is at
 * least the stored `flushed_seq`, and answers the stored value. `409
 * not_leader`: this holder does not hold the lease.
 */
export async function markArtifactDocFlushed(projectId: string, artifactId: string, flush: ArtifactDocFlush): Promise<{ flushed_seq: number }> {
  const raw = unwrap(
    await backendApi.post<{ flushed_seq: unknown }>(
      `${doc(projectId, artifactId)}/flushed`,
      { holder: flush.holder, seq: flush.seq, version: flush.version, markdown: flush.markdown, ...epochField(flush.epoch) },
      { showErrors: false },
    ),
  );
  return { flushed_seq: toSeq(raw.flushed_seq, 'flushed_seq') };
}

/**
 * Delete the doc state and every stored update, for a doc whose updates the
 * host cannot apply (a poisoned update). Allowed for the lease holder, or
 * while the lease is free or expired; else `409 not_leader`. Every open tab
 * then sees the doc unseeded and starts over from the file.
 */
export async function resetArtifactDoc(projectId: string, artifactId: string, input: { holder: string }): Promise<void> {
  unwrap(await backendApi.post<unknown>(`${doc(projectId, artifactId)}/reset`, { holder: input.holder }, { showErrors: false }));
}
