/**
 * Write normalized Suna conversations into an opencode.db (SQLite) that opencode
 * will actually serve.
 *
 * The schema below is opencode's REAL schema, captured verbatim from a live
 * opencode.db (a completed legacy-migration archive). Getting this exactly right
 * matters: the rehydrate ship REPLACES opencode's db with this one, so opencode
 * reads OUR schema. A hand-trimmed/minimal schema (missing NOT NULL columns like
 * session.directory/version or the message/part `data` blob, or the
 * __drizzle_migrations bookkeeping) makes opencode fail to list the sessions —
 * the session opens to "This session is not accessible right now".
 *
 * We seed __drizzle_migrations with the exact rows a real db carries so
 * opencode's (name-based) migrator treats every migration as already applied and
 * never re-runs a CREATE TABLE against our pre-built tables.
 *
 * Row SHAPES (message.data / part.data JSON) also mirror real opencode rows —
 * see the per-builder comments.
 */
import { Database } from 'bun:sqlite';
import type { NormalizedMessage, NormalizedPart } from './agentpress-mapper';

const WORKSPACE_DIR = '/workspace';
const OPENCODE_VERSION = '1.2.25';

const REAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id INTEGER PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric,
  name text,
  applied_at TEXT
);
CREATE TABLE IF NOT EXISTS \`project\` (
  \`id\` text PRIMARY KEY,
  \`worktree\` text NOT NULL,
  \`vcs\` text,
  \`name\` text,
  \`icon_url\` text,
  \`icon_color\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_initialized\` integer,
  \`sandboxes\` text NOT NULL,
  \`commands\` text
);
CREATE TABLE IF NOT EXISTS \`message\` (
  \`id\` text PRIMARY KEY,
  \`session_id\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS \`part\` (
  \`id\` text PRIMARY KEY,
  \`message_id\` text NOT NULL,
  \`session_id\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS \`permission\` (
  \`project_id\` text PRIMARY KEY,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS \`session\` (
  \`id\` text PRIMARY KEY,
  \`project_id\` text NOT NULL,
  \`parent_id\` text,
  \`slug\` text NOT NULL,
  \`directory\` text NOT NULL,
  \`title\` text NOT NULL,
  \`version\` text NOT NULL,
  \`share_url\` text,
  \`summary_additions\` integer,
  \`summary_deletions\` integer,
  \`summary_files\` integer,
  \`summary_diffs\` text,
  \`revert\` text,
  \`permission\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_compacting\` integer,
  \`time_archived\` integer,
  \`workspace_id\` text,
  CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS \`todo\` (
  \`session_id\` text NOT NULL,
  \`content\` text NOT NULL,
  \`status\` text NOT NULL,
  \`priority\` text NOT NULL,
  \`position\` integer NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
  CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS \`session_share\` (
  \`session_id\` text PRIMARY KEY,
  \`id\` text NOT NULL,
  \`secret\` text NOT NULL,
  \`url\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`message_session_idx\` ON \`message\` (\`session_id\`);
CREATE INDEX IF NOT EXISTS \`part_message_idx\` ON \`part\` (\`message_id\`);
CREATE INDEX IF NOT EXISTS \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX IF NOT EXISTS \`session_project_idx\` ON \`session\` (\`project_id\`);
CREATE INDEX IF NOT EXISTS \`session_parent_idx\` ON \`session\` (\`parent_id\`);
CREATE INDEX IF NOT EXISTS \`todo_session_idx\` ON \`todo\` (\`session_id\`);
CREATE TABLE IF NOT EXISTS \`control_account\` (
  \`email\` text NOT NULL,
  \`url\` text NOT NULL,
  \`access_token\` text NOT NULL,
  \`refresh_token\` text NOT NULL,
  \`token_expiry\` integer,
  \`active\` integer NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
);
CREATE TABLE IF NOT EXISTS \`workspace\` (
  \`id\` text PRIMARY KEY,
  \`branch\` text,
  \`project_id\` text NOT NULL,
  \`type\` text NOT NULL,
  \`name\` text,
  \`directory\` text,
  \`extra\` text,
  CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);
CREATE TABLE IF NOT EXISTS \`account\` (
  \`id\` text PRIMARY KEY,
  \`email\` text NOT NULL,
  \`url\` text NOT NULL,
  \`access_token\` text NOT NULL,
  \`refresh_token\` text NOT NULL,
  \`token_expiry\` integer,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`account_state\` (
  \`id\` integer PRIMARY KEY NOT NULL,
  \`active_account_id\` text,
  \`active_org_id\` text,
  FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON UPDATE no action ON DELETE set null
);
`;

// The migration journal a real, working opencode.db carries. opencode's migrator
// keys on `name`, so seeding these makes it treat all migrations as applied.
const DRIZZLE_MIGRATIONS: Array<[number, number, string]> = [
  [1, 1769552633000, '20260127222353_familiar_lady_ursula'],
  [2, 1770830228000, '20260211171708_add_project_commands'],
  [3, 1770993676000, '20260213144116_wakeful_the_professor'],
  [4, 1772056728000, '20260225215848_workspace'],
  [5, 1772228279000, '20260227213759_add_session_workspace_id'],
  [6, 1772310750000, '20260228203230_blue_harpoon'],
  [7, 1772579546000, '20260303231226_add_workspace_fields'],
  [8, 1773097200000, '20260309230000_move_org_to_state'],
];

/** Create a fresh opencode.db at `path` with opencode's real schema + migration
 *  journal. Replaces the old hand-authored minimal schema. */
export function seedOpencodeSchema(path: string): void {
  const d = new Database(path);
  try {
    d.exec(REAL_SCHEMA_SQL);
    const appliedAt = new Date(0).toISOString();
    const ins = d.query('INSERT OR IGNORE INTO "__drizzle_migrations" (id, hash, created_at, name, applied_at) VALUES (?, ?, ?, ?, ?)');
    for (const [id, createdAt, name] of DRIZZLE_MIGRATIONS) ins.run(id, '', createdAt, name, appliedAt);
  } finally {
    d.close();
  }
}

export interface SessionToWrite {
  title: string;
  messages: NormalizedMessage[];
}

let counter = 0;
// opencode-style id: prefix + 12-hex(timestamp) + 4-hex(seq) + 10 random. The
// time+seq prefix keeps ids lexically chronological so opencode orders
// messages/parts correctly; the random tail keeps them unique.
function id(prefix: string, atMs: number): string {
  const t = Math.floor(atMs).toString(16).padStart(12, '0');
  const s = (counter++).toString(16).padStart(4, '0');
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}_${t}${s}${r}`;
}

function slugFromTitle(title: string, fallback: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

// message.data — mirrors real opencode rows. opencode validates required keys
// on read (e.g. info.agent), so BOTH roles must carry agent/model — a user
// message with only role+time makes opencode 400 ("Missing key … [info][agent]")
// and the whole thread fails to render.
function messageData(role: 'user' | 'assistant', atMs: number, parentId: string): Record<string, unknown> {
  if (role === 'user') return {
    role: 'user',
    time: { created: atMs },
    summary: { diffs: [] },
    agent: 'kortix',
    model: { providerID: 'kortix', modelID: 'unknown' },
  };
  return {
    role: 'assistant',
    time: { created: atMs, completed: atMs },
    // opencode requires parentID on assistant messages (the user message that
    // started the turn). Missing it 400s the whole thread on read.
    parentID: parentId,
    modelID: 'unknown', providerID: 'unknown', mode: 'kortix', agent: 'kortix',
    path: { cwd: WORKSPACE_DIR, root: WORKSPACE_DIR },
    cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
  };
}

// part.data — text or tool, exactly the shape opencode persists.
function partData(p: NormalizedPart, atMs: number): Record<string, unknown> {
  if (p.type === 'text') return { type: 'text', text: p.text };
  const state = p.output == null
    ? { status: 'error', error: 'no result captured (legacy migration)', input: p.input, time: { start: atMs, end: atMs } }
    : { status: 'completed', input: p.input, output: p.output, title: p.name, metadata: { truncated: false }, time: { start: atMs, end: atMs } };
  return { type: 'tool', callID: p.callId, tool: p.name, state };
}

export interface WriteResult { sessions: number; messages: number; parts: number; unknownTables: string[]; sessionIds: Array<{ id: string; title: string }>; }

/**
 * Create a project + sessions + messages + parts for one migrated workspace.
 * `projectId` is the opencode projectID; the rehydrate ship re-keys project.id
 * and session.project_id to the live workspace's id, so any stable value works.
 */
export function writeConversations(dbPath: string, projectId: string, sessions: SessionToWrite[]): WriteResult {
  const db = new Database(dbPath);
  const res: WriteResult = { sessions: 0, messages: 0, parts: 0, unknownTables: [], sessionIds: [] };
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    const now = Date.now();

    db.query(`INSERT OR IGNORE INTO "project" (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands)
              VALUES (?, ?, 'git', '', '', '', ?, ?, ?, '[]', NULL)`).run(projectId, WORKSPACE_DIR, now, now, now);

    const insSession = db.query(`INSERT OR IGNORE INTO "session"
      (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
    const insMessage = db.query(`INSERT OR IGNORE INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`);
    const insPart = db.query(`INSERT OR IGNORE INTO "part" (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`);

    const tx = db.transaction(() => {
      let sIdx = 0;
      for (const s of sessions) {
        const sessionID = id('ses', now);
        const title = s.title.slice(0, 200) || 'Untitled';
        res.sessionIds.push({ id: sessionID, title });
        insSession.run(sessionID, projectId, slugFromTitle(title, `session-${sIdx++}`), WORKSPACE_DIR, title, OPENCODE_VERSION, now, now);
        res.sessions++;

        let lastUserMessageId: string | null = null;
        for (const m of s.messages) {
          const atMs = Date.parse(m.createdAt) || now;
          const messageID = id('msg', atMs);
          // parentID for an assistant message is the user message that started
          // the turn; fall back to itself if a session somehow opens on assistant.
          const parentId = m.role === 'user' ? messageID : (lastUserMessageId ?? messageID);
          insMessage.run(messageID, sessionID, atMs, atMs, JSON.stringify(messageData(m.role, atMs, parentId)));
          if (m.role === 'user') lastUserMessageId = messageID;
          res.messages++;

          for (const p of m.parts) {
            const partId = id('prt', atMs);
            insPart.run(partId, messageID, sessionID, atMs, atMs, JSON.stringify(partData(p, atMs)));
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
