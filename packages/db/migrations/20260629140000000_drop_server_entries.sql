-- Up Migration
--
-- Drop the legacy multi-instance "server entries" registry. The frontend
-- instance/server switcher and the apps/api /v1/servers CRUD that read and
-- wrote this table were removed in this change; nothing references
-- kortix.server_entries anymore (it is no longer modeled in kortix.ts). Its
-- only column-level dependency was the sandbox_provider enum, which other
-- tables still use, so the enum is left intact.

DROP TABLE IF EXISTS kortix.server_entries CASCADE;

-- Down Migration
-- Forward-only: the multi-instance server registry is discontinued and
-- intentionally not recreatable.
