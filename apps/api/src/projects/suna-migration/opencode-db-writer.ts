/**
 * Write normalized Suna conversations into an opencode.db (SQLite).
 *
 * opencode's exact message/part table DDL lives in its compiled runtime, not
 * this repo — so instead of hardcoding columns we INTROSPECT the target db
 * (PRAGMA table_info) and only set columns that exist. Known-good from the repo:
 *   session(id, title, slug, parent_id, project_id, time_archived, time_updated)  [legacy-migration-steps.ts]
 *   project(id, …)                                                                 [legacy-migration-rehydrate.ts]
 * message/part columns are discovered at runtime. This makes the writer adapt to
 * the opencode version in the sandbox rather than break on a schema bump.
 *
 * The opencode Part SHAPE (text / tool+state) comes from @opencode-ai/sdk@1.14.28.
 */
import { Database } from 'bun:sqlite';
import type { NormalizedMessage, NormalizedPart } from './agentpress-mapper';

export interface SessionToWrite {
  title: string;
  messages: NormalizedMessage[];
}

let counter = 0;
// opencode-style sortable id: prefix + base36(timestamp)+seq+rand. Exact prefix
// scheme is validated against a real db before apply.
function id(prefix: string, atMs: number): string {
  const t = Math.floor(atMs).toString(36).padStart(9, '0');
  const s = (counter++).toString(36).padStart(4, '0');
  const r = Math.floor(performance.now() * 1000 % 1e6).toString(36).padStart(4, '0');
  return `${prefix}_${t}${s}${r}`;
}

function tableColumns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch { return new Set(); }
}

// Insert, keeping only columns that exist on the table. Returns false if the
// table is unknown (so the caller can surface a schema mismatch).
function insertAdaptive(db: Database, table: string, cols: Set<string>, row: Record<string, unknown>): boolean {
  if (cols.size === 0) return false;
  const keys = Object.keys(row).filter((k) => cols.has(k));
  if (keys.length === 0) return false;
  const sql = `INSERT OR IGNORE INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const vals = keys.map((k) => {
    const v = row[k];
    return v === null || typeof v === 'number' || typeof v === 'bigint' ? v
      : typeof v === 'string' ? v : JSON.stringify(v);
  });
  db.query(sql).run(...(vals as any[]));
  return true;
}

function partObject(p: NormalizedPart, sessionID: string, messageID: string, atMs: number): { partId: string; data: any; type: string } {
  const partId = id('prt', atMs);
  if (p.type === 'text') {
    return { partId, type: 'text', data: { id: partId, sessionID, messageID, type: 'text', text: p.text } };
  }
  return {
    partId,
    type: 'tool',
    data: {
      id: partId, sessionID, messageID, type: 'tool',
      callID: p.callId, tool: p.name,
      state: p.output == null
        ? { status: 'error', error: 'no result captured (legacy migration)', input: p.input }
        : { status: 'completed', input: p.input, output: p.output, title: p.name, metadata: {} },
    },
  };
}

export interface WriteResult { sessions: number; messages: number; parts: number; unknownTables: string[]; }

/**
 * Create a project + sessions + messages + parts for one migrated workspace.
 * `projectId` must be the opencode projectID of the target workspace (the
 * rehydrate ship step re-keys it, so any stable value works pre-ship).
 */
export function writeConversations(dbPath: string, projectId: string, sessions: SessionToWrite[]): WriteResult {
  const db = new Database(dbPath);
  const res: WriteResult = { sessions: 0, messages: 0, parts: 0, unknownTables: [] };
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    const projectCols = tableColumns(db, 'project');
    const sessionCols = tableColumns(db, 'session');
    const messageCols = tableColumns(db, 'message');
    const partCols = tableColumns(db, 'part');
    for (const [name, cols] of [['message', messageCols], ['part', partCols]] as const) {
      if (cols.size === 0) res.unknownTables.push(name);
    }

    const now = Date.now();
    insertAdaptive(db, 'project', projectCols, { id: projectId, time_created: now, time_initialized: now });

    const tx = db.transaction(() => {
      for (const s of sessions) {
        const sessionID = id('ses', now);
        insertAdaptive(db, 'session', sessionCols, {
          id: sessionID, project_id: projectId, parent_id: null,
          title: s.title.slice(0, 200), slug: null,
          time_created: now, time_updated: now, time_archived: null,
        });
        res.sessions++;

        for (const m of s.messages) {
          const atMs = Date.parse(m.createdAt) || now;
          const messageID = id('msg', atMs);
          insertAdaptive(db, 'message', messageCols, {
            id: messageID, session_id: sessionID, role: m.role,
            time_created: atMs,
            data: { id: messageID, sessionID, role: m.role, time: { created: atMs } },
          });
          res.messages++;

          for (const p of m.parts) {
            const { partId, data, type } = partObject(p, sessionID, messageID, atMs);
            insertAdaptive(db, 'part', partCols, {
              id: partId, message_id: messageID, session_id: sessionID, type,
              time_created: atMs, data,
            });
            res.parts++;
          }
        }
      }
    });
    tx();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return res;
  } finally {
    db.close();
  }
}
