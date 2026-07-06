import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

// NOTE: Credit/billing tables (creditAccounts, creditLedger, creditUsage,
// creditPurchases, accountDeletionRequests) have been moved to kortix.ts
// under the 'kortix' schema. Do NOT re-add them here.

// ─── Public schema tables ───────────────────────────────────────────────────
// These are pushed by drizzle-kit (schemaFilter includes 'public').

export const apiKeys = pgTable(
  'api_keys',
  {
    keyId: uuid('key_id').defaultRandom().primaryKey().notNull(),
    publicKey: varchar('public_key', { length: 64 }).notNull(),
    secretKeyHash: varchar('secret_key_hash', { length: 64 }).notNull(),
    accountId: uuid('account_id').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    status: text('status').default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_api_keys_account_id').on(table.accountId),
    index('idx_api_keys_public_key').on(table.publicKey),
  ],
);

