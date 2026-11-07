/**
 * Read a COPY of an old OpenCode box's store (`opencode.db`) into rows.
 *
 * Lifted from the kortixd reader that #11155 deleted
 * (`apps/kortix-sandbox-agent-server/src/harness/open-code/opencode-db.ts` at
 * f1b9251b4f^, `storeSnapshot`). Two changes: it opens a local copy that the
 * recovery owns (so it may write the WAL back into the file), and it needs only
 * `session`, `message` and `part`. The `event` tables the old probe required
 * served live paging, not the export, and an OpenCode 1.17 store may lack them.
 *
 * Schema (OpenCode 1.18.23): `message.data` and `part.data` hold the JSON
 * envelope; the id columns beside them are authoritative.
 */
import { Database } from 'bun:sqlite';

export interface StoreSessionRow {
  id: string;
  title: string | null;
  parent_id: string | null;
  version: string | null;
  time_created: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface TodoRow {
  session_id: string;
  content: string;
  status: string;
  priority: string;
  position: number;
}

export interface StoreSnapshot {
  sessions: StoreSessionRow[];
  /** Ordered by `(time_created, id)`, OpenCode's own order. */
  messages: MessageRow[];
  /** Ordered by `(message_id, id)`. */
  parts: PartRow[];
  todos: TodoRow[];
}

const REQUIRED: Record<string, string[]> = {
  session: ['id', 'title', 'time_created'],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
};

export class UnsupportedStoreError extends Error {}

/** Every session, message, part and todo row of the store at `path`, in one read transaction. */
export function readOpenCodeStore(path: string): StoreSnapshot {
  const db = new Database(path);
  try {
    const columns = (table: string) =>
      new Set(db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name));
    const tables = new Set(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    for (const [table, needed] of Object.entries(REQUIRED)) {
      if (!tables.has(table)) throw new UnsupportedStoreError(`no ${table} table`);
      const have = columns(table);
      const missing = needed.filter((c) => !have.has(c));
      if (missing.length) throw new UnsupportedStoreError(`${table} lacks ${missing.join(', ')}`);
    }
    const session = columns('session');
    const parent = session.has('parent_id') ? 'parent_id' : 'NULL AS parent_id';
    const version = session.has('version') ? 'version' : 'NULL AS version';
    const todo = tables.has('todo');
    return db.transaction(
      (): StoreSnapshot => ({
        sessions: db
          .query<StoreSessionRow, []>(`SELECT id, title, ${parent}, ${version}, time_created FROM session ORDER BY time_created, id`)
          .all(),
        messages: db
          .query<MessageRow, []>('SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY time_created, id')
          .all(),
        parts: db
          .query<PartRow, []>(
            'SELECT id, message_id, session_id, time_created, time_updated, data FROM part ORDER BY message_id, id',
          )
          .all(),
        todos: todo
          ? db
              .query<TodoRow, []>('SELECT session_id, content, status, priority, position FROM todo ORDER BY session_id, position')
              .all()
          : [],
      }),
    )();
  } finally {
    db.close();
  }
}
