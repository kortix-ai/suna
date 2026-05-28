-- Simplify the change-request layer: drop review + comment + revision history.
-- The CR is now just metadata around "merge head_ref into base_ref"; everything
-- else (commit history, diff against base) is derived live from git.
--
-- Git remains the source of truth for history — there's no value in mirroring
-- a revision row per push when `git log head_ref` answers the same question.

DROP TABLE IF EXISTS "kortix"."change_request_comments";
DROP TABLE IF EXISTS "kortix"."change_request_reviews";
DROP TABLE IF EXISTS "kortix"."change_request_revisions";
DROP TYPE  IF EXISTS "kortix"."change_request_review_state";
