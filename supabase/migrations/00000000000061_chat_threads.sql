-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  chat_threads                                                              ║
-- ║                                                                            ║
-- ║  Maps a single chat thread (Slack thread_ts, Telegram reply chain, etc.)   ║
-- ║  to the Kortix session that owns it. On the first @mention the webhook    ║
-- ║  router spawns a new project_session and writes a row here. On every       ║
-- ║  subsequent message in the same thread it finds the row and delivers the   ║
-- ║  follow-up to the same running sandbox — no new session, no fresh         ║
-- ║  opencode context, no lost conversation memory.                           ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS kortix.chat_threads (
  thread_row_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  platform          varchar(32) NOT NULL,
  workspace_id      varchar(128) NOT NULL,
  thread_id         varchar(256) NOT NULL,
  session_id        text NOT NULL REFERENCES kortix.project_sessions(session_id) ON DELETE CASCADE,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  last_message_at   timestamptz NOT NULL DEFAULT now()
);

-- Lookup key: one row per (platform, workspace, thread). On Slack the
-- workspace_id is team_id and thread_id is the parent message ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_thread
  ON kortix.chat_threads (platform, workspace_id, thread_id);

CREATE INDEX IF NOT EXISTS idx_chat_threads_project
  ON kortix.chat_threads (project_id);

CREATE INDEX IF NOT EXISTS idx_chat_threads_session
  ON kortix.chat_threads (session_id);
