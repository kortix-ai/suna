-- kortix grants — no RLS; access control is enforced at the API layer
-- (service_role). Runs after 0001 creates the tables. The ALTER DEFAULT
-- PRIVILEGES lines cover tables added by FUTURE generated migrations too, so new
-- kortix tables inherit grants automatically — you never touch grants again.
grant usage on schema kortix to anon, authenticated, service_role;
--> statement-breakpoint
grant all on all tables in schema kortix to service_role;
--> statement-breakpoint
grant select, insert, update on all tables in schema kortix to authenticated;
--> statement-breakpoint
grant select on all tables in schema kortix to anon;
--> statement-breakpoint
grant usage, select on all sequences in schema kortix to anon, authenticated, service_role;
--> statement-breakpoint
alter default privileges in schema kortix grant all on tables to service_role;
--> statement-breakpoint
alter default privileges in schema kortix grant select, insert, update on tables to authenticated;
--> statement-breakpoint
alter default privileges in schema kortix grant select on tables to anon;
--> statement-breakpoint
alter default privileges in schema kortix grant usage, select on sequences to anon, authenticated, service_role;
