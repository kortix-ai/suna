import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/schema/kortix.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['kortix'],
  // Only manage these specific tables. basejump.* and api_keys are managed
  // externally (the 0000_bootstrap baseline) and excluded from drizzle.
  // Credit/billing tables are now under kortix.* schema.
  tablesFilter: [
    'kortix.*',
  ],
  // Timestamp-prefixed migration filenames (e.g. 20260605T120000_add_foo.sql)
  // instead of sequential 0001/0002 — so two engineers branching off main don't
  // both produce a `0003_*.sql` and collide. (The meta/_journal.json ledger is
  // still a small shared file; resolve by re-running `db:generate` after merge.)
  migrations: {
    prefix: 'timestamp',
  },
});
