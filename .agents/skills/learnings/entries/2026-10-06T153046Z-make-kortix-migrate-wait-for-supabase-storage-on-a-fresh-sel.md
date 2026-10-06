---
recorded: 2026-10-06T15:30:46Z
incident_date: 2026-10-06
---
# Make kortix-migrate wait for Supabase storage on a fresh self-host database: it races storage-api's grants on storage.buckets

**Rule:** On a fresh self-host database, `kortix-migrate` must not run
before Supabase storage has finished its own setup. Give it a dependency on
`supabase-storage` being healthy, or retry the migration run.

**Trigger surface:** editing `apps/cli/src/self-host/assets/kortix-compose.yml`,
adding a migration that touches the `storage.*` schema, or building any
environment from an empty database.

**Incident:** 2026-10-06, a from-scratch rebuild of the pi-js branch
environment. `kortix-migrate` reached
`20260826212608172_storage_branding_bucket.sql` after storage-api had created
`storage.buckets` but before it granted `INSERT` to `postgres`:
`permission denied for table buckets`. The migration's guard checks only that
the table exists. Seconds later `postgres` held the grant, and a second
`compose up` passed. Persistent preview environments never start from an empty
database, so CI never exercised this. A fresh self-host install can hit it.

**Enforcement:** none yet: add `supabase-storage: { condition: service_healthy }`
to `kortix-migrate.depends_on` in `apps/cli/src/self-host/assets/kortix-compose.yml`,
proven by a fresh install. Meanwhile `apps/pi-worker-js/env/pi-js-host.sh`
retries `up` once.
