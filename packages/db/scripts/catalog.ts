import pg from 'pg';

/**
 * The one reader of the `kortix` schema catalog and the migration ledger.
 *
 * `schema-contract.ts`, `verify-live-schema.ts` and `migrate.ts status`
 * (`migration-status.ts`) read a database only through `readDatabase`. This
 * module owns the connection: it opens it, runs both reads, and closes it.
 * Each gate is a pure comparison over what `readDatabase` returns.
 *
 * Every read is read-only twice over: the session opens with
 * `default_transaction_read_only = on`, and the reads run inside
 * `BEGIN READ ONLY`. The transaction also pins one server connection, so a
 * transaction-mode pooler cannot move a read to a session without the setting.
 */

export const LEDGER_TABLE = 'kortix_migrations.pgmigrations';

export type RelationKind = 'table' | 'view';

export interface CatalogIndex {
  /** The indexed relation. */
  table: string;
  /** `pg_get_indexdef`, verbatim. */
  definition: string;
  unique: boolean;
  /** false = a failed CONCURRENTLY build. */
  valid: boolean;
  /** The index implements a PRIMARY KEY, UNIQUE or EXCLUDE constraint. */
  backsConstraint: boolean;
}

export interface CatalogConstraint {
  table: string;
  /** `pg_constraint.contype`: p, u, f, c or x. NOT NULL is not a row before PostgreSQL 18. */
  type: string;
  /** `pg_get_constraintdef`, verbatim. */
  definition: string;
  validated: boolean;
}

export interface Catalog {
  /** Relation name -> kind. A table is relkind r or p, a view is v or m. */
  relations: Map<string, RelationKind>;
  /** `relation.column` for every column of every relation above. */
  columns: Set<string>;
  /** `enum_type.label` */
  enumValues: Set<string>;
  /** Index name -> index, for every index on a relation above. */
  indexes: Map<string, CatalogIndex>;
  /** Constraint name -> constraint, for PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK and EXCLUDE. */
  constraints: Map<string, CatalogConstraint>;
}

/** Throws unless a `SHOW` answered `on`. */
export function assertReadOnlySetting(setting: string, value: string | undefined): void {
  if (value !== 'on') {
    throw new Error(
      `refusing to read the database: ${setting} is ${JSON.stringify(value ?? null)}, not "on". ` +
        'Catalog and ledger reads run only on a read-only session.',
    );
  }
}

/**
 * A `pg.Client` on a read-only session, inside an open `BEGIN READ ONLY`
 * transaction. `end()` discards the transaction. Only `withReadOnly` calls it.
 *
 * `default_transaction_read_only` travels as a startup parameter. `pg` lets an
 * `options=` query parameter in the URL replace it, and a connection pooler
 * can drop it, so the session is checked after connect: when it is not
 * read-only, a session `SET` is tried once; when it is still not read-only,
 * the client is closed and the call throws. Nothing is read before both
 * checks pass.
 */
async function connectReadOnly(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    const show = async (setting: 'default_transaction_read_only' | 'transaction_read_only') =>
      (await client.query<Record<string, string>>(`SHOW ${setting}`)).rows[0]?.[setting];
    let value = await show('default_transaction_read_only');
    if (value !== 'on') {
      await client.query('SET default_transaction_read_only = on');
      value = await show('default_transaction_read_only');
    }
    assertReadOnlySetting('default_transaction_read_only', value);
    await client.query('BEGIN READ ONLY');
    assertReadOnlySetting('transaction_read_only', await show('transaction_read_only'));
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

/**
 * Runs `read` on a client from `connectReadOnly` and always closes the client.
 *
 * Test seam: the gates call `readDatabase`, never this. Tests use it to prove
 * the session refuses writes.
 */
export async function withReadOnly<T>(databaseUrl: string, read: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connectReadOnly(databaseUrl);
  try {
    return await read(client);
  } finally {
    await client.end();
  }
}

/**
 * One row of JSON arrays: every relation (with its columns), enum label,
 * index and constraint in one schema. A schema that does not exist returns no
 * row.
 */
const CATALOG_SQL = `
  SELECT
    (SELECT coalesce(json_agg(json_build_object(
              'name', c.relname,
              'kind', CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END,
              'columns', (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]')
                            FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))), '[]')
       FROM pg_class c
      WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm')) AS relations,
    (SELECT coalesce(json_agg(json_build_object('type', t.typname, 'label', e.enumlabel)), '[]')
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = n.oid) AS enums,
    (SELECT coalesce(json_agg(json_build_object(
              'name', i.relname,
              'table', t.relname,
              'definition', pg_get_indexdef(x.indexrelid),
              'unique', x.indisunique,
              'valid', x.indisvalid,
              'backsConstraint', EXISTS (
                SELECT 1 FROM pg_constraint k
                 WHERE k.conindid = x.indexrelid AND k.contype IN ('p', 'u', 'x')))), '[]')
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.relnamespace = n.oid AND t.relkind IN ('r', 'p', 'm')) AS indexes,
    (SELECT coalesce(json_agg(json_build_object(
              'name', k.conname,
              'table', t.relname,
              'type', k.contype,
              'definition', pg_get_constraintdef(k.oid),
              'validated', k.convalidated)), '[]')
       FROM pg_constraint k
       JOIN pg_class t ON t.oid = k.conrelid
      WHERE t.relnamespace = n.oid AND k.contype IN ('p', 'u', 'f', 'c', 'x')) AS constraints
  FROM pg_namespace n
  WHERE n.nspname = $1
`;

export interface CatalogRow {
  relations: Array<{ name: string; kind: RelationKind; columns: string[] }>;
  enums: Array<{ type: string; label: string }>;
  indexes: Array<CatalogIndex & { name: string }>;
  constraints: Array<CatalogConstraint & { name: string }>;
}

/** Pure: the catalog query's row as a `Catalog`. No row (no schema) is an empty catalog. */
export function catalogFromRow(row: CatalogRow | undefined): Catalog {
  const catalog: Catalog = {
    relations: new Map(),
    columns: new Set(),
    enumValues: new Set(),
    indexes: new Map(),
    constraints: new Map(),
  };
  if (!row) return catalog;
  for (const relation of row.relations) {
    catalog.relations.set(relation.name, relation.kind);
    for (const column of relation.columns) catalog.columns.add(`${relation.name}.${column}`);
  }
  for (const { type, label } of row.enums) catalog.enumValues.add(`${type}.${label}`);
  for (const { name, ...index } of row.indexes) catalog.indexes.set(name, index);
  for (const { name, ...constraint } of row.constraints) catalog.constraints.set(name, constraint);
  return catalog;
}

async function readCatalog(client: pg.Client, schema = 'kortix'): Promise<Catalog> {
  const { rows } = await client.query<CatalogRow>(CATALOG_SQL, [schema]);
  return catalogFromRow(rows[0]);
}

/**
 * Applied migration names in ledger run order (`ORDER BY run_on, id`: the
 * order node-pg-migrate `up --check-order` compares). An absent ledger table
 * reads as empty. A ledger the role cannot read throws.
 */
async function readLedger(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return [];
  const ledger = await client.query<{ name: string }>(`SELECT name FROM ${LEDGER_TABLE} ORDER BY run_on, id`);
  return ledger.rows.map((row) => row.name);
}

export interface Database {
  /** The catalog of one schema. */
  catalog: Catalog;
  /** Applied migration names in ledger run order; empty when there is no ledger table. */
  ledger: string[];
}

/**
 * The one entry point of the schema gates: the catalog of `schema` and the
 * migration ledger, read in one `BEGIN READ ONLY` transaction on one
 * read-only session, which is closed before this returns.
 */
export async function readDatabase(databaseUrl: string, schema = 'kortix'): Promise<Database> {
  return withReadOnly(databaseUrl, async (client) => ({
    catalog: await readCatalog(client, schema),
    ledger: await readLedger(client),
  }));
}
