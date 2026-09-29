// Migration: connector_connections_owner_tunnel_unique  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the unique index kortix.ts declares as
// idx_connector_connections_owner_tunnel: at most one computer account per
// (connector, owner, machine). The API ensures each owner's machines as
// member accounts in every project they open and upserts on this index
// (connectors/sync.ts ensureProjectComputer), so two concurrent ensures can
// never create two accounts for one machine.
//
// Existing rows cannot collide: connector_connections.tunnel_id was added by
// 20260929014000000_computer_accounts.sql in the same release, and every
// writer since (device-auth approve, POST /projects/:id/computers, the
// 20260929014000400 backfill) reuses the owner's row for a machine it already
// holds. A collision would fail the build and leave an INVALID index; drop it
// by hand and dedupe first (see packages/db/MIGRATIONS.md).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. The one lock it holds (ShareUpdateExclusive) blocks no user.
//
// mixed-version-safe: adds a partial unique index over rows only this release
// writes (tunnel_id IS NOT NULL). The previous API never sets tunnel_id.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_connector_connections_owner_tunnel
      on kortix.connector_connections using btree (connector_id, owner_type, owner_id, tunnel_id)
      where tunnel_id is not null
  `);
};

export const down = false;
