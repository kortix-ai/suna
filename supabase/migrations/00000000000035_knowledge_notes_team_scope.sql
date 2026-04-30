-- Extend knowledge_notes with team-scope columns.
-- Depends on migration 34 (knowledge_notes base table).

ALTER TABLE kortix.knowledge_notes
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'team')),
  ADD COLUMN category TEXT
    CHECK (category IN ('design_system', 'component_library', 'brand_guidelines') OR category IS NULL),
  ADD COLUMN sandbox_id UUID REFERENCES kortix.sandboxes(sandbox_id) ON DELETE CASCADE;

-- Index: team notes by sandbox + category
CREATE INDEX IF NOT EXISTS knowledge_notes_team_idx
  ON kortix.knowledge_notes(sandbox_id, category)
  WHERE scope = 'team';

-- ─── RLS update ─────────────────────────────────────────────────────────────
-- Drop the single-policy owner RLS from migration 34 and replace with
-- scope-aware policies.

DROP POLICY IF EXISTS knowledge_notes_owner ON kortix.knowledge_notes;

-- SELECT: personal own OR team member
CREATE POLICY knowledge_notes_select ON kortix.knowledge_notes
  FOR SELECT
  USING (
    (scope = 'personal' AND user_id = auth.uid())
    OR (
      scope = 'team'
      AND sandbox_id IN (
        SELECT sandbox_id FROM kortix.sandbox_members
        WHERE user_id = auth.uid()
      )
    )
  );

-- INSERT: personal own OR team admin
CREATE POLICY knowledge_notes_insert ON kortix.knowledge_notes
  FOR INSERT
  WITH CHECK (
    (scope = 'personal' AND user_id = auth.uid())
    OR (
      scope = 'team'
      AND sandbox_id IN (
        SELECT sandbox_id FROM kortix.sandbox_members
        WHERE user_id = auth.uid()
          AND account_role = 'owner'
      )
    )
  );

-- UPDATE / DELETE: same as INSERT
CREATE POLICY knowledge_notes_update ON kortix.knowledge_notes
  FOR UPDATE
  USING (
    (scope = 'personal' AND user_id = auth.uid())
    OR (
      scope = 'team'
      AND sandbox_id IN (
        SELECT sandbox_id FROM kortix.sandbox_members
        WHERE user_id = auth.uid()
          AND account_role = 'owner'
      )
    )
  );

CREATE POLICY knowledge_notes_delete ON kortix.knowledge_notes
  FOR DELETE
  USING (
    (scope = 'personal' AND user_id = auth.uid())
    OR (
      scope = 'team'
      AND sandbox_id IN (
        SELECT sandbox_id FROM kortix.sandbox_members
        WHERE user_id = auth.uid()
          AND account_role = 'owner'
      )
    )
  );
