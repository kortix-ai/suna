-- Make access_requests.email unique so duplicate signup submissions are idempotent.
-- The existing non-unique index is dropped and replaced with a unique index.
-- ON CONFLICT (email) DO NOTHING in the application layer then silently deduplicates.

DROP INDEX IF EXISTS kortix.idx_access_requests_email;

ALTER TABLE kortix.access_requests
  ADD CONSTRAINT access_requests_email_unique UNIQUE (email);
