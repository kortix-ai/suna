-- Migration: backfill_app_display_listed
--
-- An App is on the Apps page only when registered with `display.listed: true`
-- (the default became false). Every App that exists today keeps its card: each
-- one without a `listed` key gets `listed: true`. An App that set
-- `listed: false` keeps it.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: kortix.apps, one row per App (thousands, not millions). No DDL in this file, so no ACCESS EXCLUSIVE: the UPDATE takes row locks only, on rows an App edit rarely touches, and one statement finishes in well under the 30 s statement_timeout.
update kortix.apps
set display = display || '{"listed": true}'::jsonb
where not (display ? 'listed');
