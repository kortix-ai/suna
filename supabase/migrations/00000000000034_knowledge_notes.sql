-- Knowledge notes — user-scoped searchable note store.
-- Full-text search via generated tsvector column + GIN index.
-- RLS ensures users only see their own notes.

CREATE TABLE IF NOT EXISTS kortix.knowledge_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL DEFAULT '/',
  title        TEXT NOT NULL,
  content_md   TEXT NOT NULL DEFAULT '',
  search_vec   TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content_md, ''))
  ) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_notes_user_idx    ON kortix.knowledge_notes(user_id);
CREATE INDEX IF NOT EXISTS knowledge_notes_folder_idx  ON kortix.knowledge_notes(user_id, folder_path);
CREATE INDEX IF NOT EXISTS knowledge_notes_search_idx  ON kortix.knowledge_notes USING GIN(search_vec);

-- RLS
ALTER TABLE kortix.knowledge_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_notes_owner ON kortix.knowledge_notes
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
