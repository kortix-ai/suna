-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Bootstrap-grants on account invitations                             ║
-- ║                                                                      ║
-- ║  Lets a project admin invite a non-Kortix-user "into project X as    ║
-- ║  Editor" in a single step. The project invite endpoint creates the   ║
-- ║  account invitation row with bootstrap_grants populated; the invite  ║
-- ║  acceptor reads the column, calls grantProjectRole for each entry,   ║
-- ║  and clears the column.                                              ║
-- ║                                                                      ║
-- ║  Shape (validated app-side):                                         ║
-- ║    [ { "project_id": "<uuid>",                                       ║
-- ║        "role": "manager" | "editor" | "viewer",                      ║
-- ║        "expires_at": "<iso-8601>"? } ]                               ║
-- ║                                                                      ║
-- ║  NULL = no project bootstrap (the existing account-only invite       ║
-- ║  case). Existing rows get NULL implicitly.                           ║
-- ╚══════════════════════════════════════════════════════════════════════╝

ALTER TABLE kortix.account_invitations
  ADD COLUMN IF NOT EXISTS bootstrap_grants jsonb;
