/**
 * An old OpenCode box's store as a Kortix session log.
 *
 * Lifted from `openCodeSessionLog` in the kortixd OpenCode adapter that #11155
 * deleted (`harness/open-code/session-log.ts` at f1b9251b4f^). It assembles the
 * v1 rows `{ info, parts }` from the store exactly as OpenCode's HTTP served
 * them, takes the attachment bytes out, runs `fromV1`, then sets what only the
 * store knows: seqs, producer, attachment refs, titles, todos, the harness.
 *
 * What differs from the daemon export:
 * - seqs are issued from 1 per thread in `fromV1` order. The daemon kept a seq
 *   map on the box; these boxes never journaled, so none exists, and with no
 *   revert the result equals the daemon's.
 * - no restore id map: a box with no session log was never restored into.
 * - attachment bytes come from `sidecars` (files the recovery downloaded),
 *   not from the box's disk.
 *
 * Pure: no database, no network. The caller uploads `blobs` and swaps each
 * `blob:<sha256>` ref for the stored object's ref (`withStoredRefs`).
 */
import { createHash } from 'node:crypto';
import { fromV1, type SessionLog, type SessionLogMessage, type V1Row } from '@kortix/api-contract/session-log';
import type { MessageRow, StoreSnapshot } from './opencode-store';

/** The 1×1 PNG the daemon's offload pass left in a row whose bytes moved to a sidecar file. */
const OFFLOAD_PLACEHOLDER_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const RECOVERY_ADAPTER_VERSION = '1.0.0-recovery';

type J = Record<string, any>;
type Resolved = { ref: string; bytes: number; sha256: string; mime: string; data: Buffer };

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const parse = (data: string): J | null => {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as J) : null;
  } catch {
    return null;
  }
};

/** Every sidecar path the store's file parts name: the files the recovery must download. */
export function sidecarPaths(store: StoreSnapshot): string[] {
  const paths = new Set<string>();
  const visit = (file: J) => {
    const marker = file?.kortix as { offloaded?: boolean; sidecar?: unknown } | undefined;
    if (marker?.offloaded && typeof marker.sidecar === 'string') paths.add(marker.sidecar);
  };
  for (const p of store.parts) {
    const part = parse(p.data);
    if (!part) continue;
    if (part.type === 'file') visit(part);
    for (const a of Array.isArray(part.state?.attachments) ? part.state.attachments : []) visit(a);
  }
  return [...paths];
}

/** Takes the bytes out of a file part, as the mirror did, and returns them resolved. */
function takeBytes(file: J, sidecars: ReadonlyMap<string, Buffer>): Resolved | null {
  const url = file.url;
  const marker = file.kortix as { offloaded?: boolean; sidecar?: string } | undefined;
  delete file.kortix; // OpenCode's HTTP dropped it, so the mirror never had it
  const mime = typeof file.mime === 'string' ? file.mime : 'application/octet-stream';
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  delete file.url;
  let bytes: Buffer | undefined;
  if (marker?.offloaded && typeof marker.sidecar === 'string') bytes = sidecars.get(marker.sidecar);
  else if (url !== OFFLOAD_PLACEHOLDER_URL) {
    const comma = url.indexOf(',');
    try {
      bytes = url.slice(0, comma).endsWith(';base64')
        ? Buffer.from(url.slice(comma + 1), 'base64')
        : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
    } catch {
      return null; // a malformed url stays unresolved, as the mirror held it
    }
  }
  if (!bytes) return null;
  const digest = sha256(bytes);
  return { ref: `blob:${digest}`, bytes: bytes.length, sha256: digest, mime, data: bytes };
}

export interface RecoveredLog {
  log: SessionLog;
  /** Attachment bytes by sha256, for the upload that turns each `blob:` ref into a stored ref. */
  blobs: Map<string, { mime: string; data: Buffer }>;
  messages: number;
}

/** The whole store as a session log. `rootId` null lets `fromV1` pick the latest root. */
export function recoverSessionLog(input: {
  sessionId: string;
  rootId: string | null;
  store: StoreSnapshot;
  sidecars?: ReadonlyMap<string, Buffer>;
}): RecoveredLog {
  const { store } = input;
  const sidecars = input.sidecars ?? new Map<string, Buffer>();
  const partRows = new Map<string, StoreSnapshot['parts']>();
  for (const p of store.parts) (partRows.get(p.message_id) ?? partRows.set(p.message_id, []).get(p.message_id)!).push(p);
  const attachments = new Map<string, Resolved>();
  const rows: V1Row[] = [];
  for (const row of store.messages as MessageRow[]) {
    const info = parse(row.data);
    if (!info) continue; // a row whose envelope does not parse cannot be attributed
    const parts: J[] = [];
    for (const p of partRows.get(row.id) ?? []) {
      const part = parse(p.data);
      if (!part) continue;
      const full: J = { ...part, id: p.id, messageID: row.id, sessionID: row.session_id };
      if (full.type === 'file') {
        const r = takeBytes(full, sidecars);
        if (r) attachments.set(p.id, r);
      }
      const files = full.state?.attachments;
      if (Array.isArray(files)) {
        full.state = {
          ...full.state,
          attachments: files.map((a: J, i: number) => {
            const copy = { ...a };
            const r = takeBytes(copy, sidecars);
            if (r) attachments.set(`${p.id}#${i}`, r);
            return copy;
          }),
        };
      }
      parts.push(full);
    }
    rows.push({ runtime_session_id: row.session_id, info: { ...info, id: row.id, sessionID: row.session_id }, parts } as unknown as V1Row);
  }

  const log = fromV1({ session_id: input.sessionId, root_id: input.rootId, rows }, { harness: 'opencode' });
  const sessions = new Map(store.sessions.map((s) => [s.id, s]));
  const root = sessions.get(input.rootId ?? '') ?? store.sessions.find((s) => !s.parent_id);
  const version = root?.version ?? store.sessions.find((s) => s.version)?.version ?? 'unknown';
  const producer = { harness: 'opencode', harness_version: version, adapter_version: RECOVERY_ADAPTER_VERSION };
  let messages = 0;
  for (const thread of log.threads) {
    thread.title = sessions.get(thread.thread_id)?.title ?? null;
    let seq = 0;
    for (const m of thread.messages as SessionLogMessage[]) {
      messages++;
      m.seq = ++seq;
      m.producer = producer;
      for (const b of m.blocks) {
        const r = b.type === 'attachment' ? attachments.get(b.id) : undefined;
        if (b.type === 'attachment' && r) Object.assign(b, { ref: r.ref, bytes: r.bytes, sha256: r.sha256 });
        if (b.type !== 'tool_call') continue;
        let i = 0;
        for (const c of b.result?.content ?? []) {
          if (c.type !== 'attachment') continue;
          const t = attachments.get(`${b.id}#${i++}`);
          if (t) Object.assign(c, { ref: t.ref, sha256: t.sha256 });
        }
      }
    }
  }
  const created = root?.time_created;
  log.title = root?.title ?? null;
  if (typeof created === 'number') log.created_at = new Date(created).toISOString();
  log.restore_grade = 'native';
  delete log.grade_counts;
  log.harness = { current: 'opencode', history: [{ harness: 'opencode', version, from_seq: 1, at: log.created_at }] };
  const rootThread = log.threads.find((t) => !t.parent_thread_id)?.thread_id;
  log.todos = store.todos
    .filter((t) => t.session_id === rootThread)
    .map((t) => ({
      content: t.content,
      status: t.status as SessionLog['todos'][number]['status'],
      priority: t.priority as SessionLog['todos'][number]['priority'],
    }));
  return {
    log,
    blobs: new Map([...attachments.values()].map((r) => [r.sha256, { mime: r.mime, data: r.data }])),
    messages,
  };
}

/** Every attachment of a message whose ref the upload may replace. */
export function attachmentsOf(message: SessionLogMessage): Array<{ ref?: string; mime: string }> {
  return message.blocks.flatMap((b) =>
    b.type === 'attachment'
      ? [b]
      : b.type === 'tool_call'
        ? [...(b.result?.content ?? []), ...(b.result?.model_content ?? [])].filter((c) => c.type === 'attachment')
        : [],
  ) as Array<{ ref?: string; mime: string }>;
}
