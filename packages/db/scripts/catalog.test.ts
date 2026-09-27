import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertReadOnlySetting, catalogFromRow } from './catalog';

const scriptsDir = import.meta.dir;
const source = (file: string) => readFileSync(join(scriptsDir, file), 'utf8');

describe('catalogFromRow', () => {
  test('no row (the schema does not exist) is an empty catalog', () => {
    expect(catalogFromRow(undefined)).toEqual({
      relations: new Map(),
      columns: new Set(),
      enumValues: new Set(),
      indexes: new Map(),
      constraints: new Map(),
    });
  });

  test('keys relations, columns, enum values, indexes and constraints by name', () => {
    const catalog = catalogFromRow({
      relations: [
        { name: 'accounts', kind: 'table', columns: ['account_id', 'name'] },
        { name: 'account_members', kind: 'view', columns: ['account_id'] },
      ],
      enums: [{ type: 'sandbox_provider', label: 'platinum' }],
      indexes: [
        { name: 'accounts_pkey', table: 'accounts', definition: 'CREATE UNIQUE INDEX accounts_pkey ON kortix.accounts USING btree (account_id)', unique: true, valid: true, backsConstraint: true },
      ],
      constraints: [
        { name: 'accounts_pkey', table: 'accounts', type: 'p', definition: 'PRIMARY KEY (account_id)', validated: true },
      ],
    });
    expect(catalog.relations).toEqual(new Map([['accounts', 'table'], ['account_members', 'view']]));
    expect(catalog.columns).toEqual(new Set(['accounts.account_id', 'accounts.name', 'account_members.account_id']));
    expect(catalog.enumValues).toEqual(new Set(['sandbox_provider.platinum']));
    expect(catalog.indexes.get('accounts_pkey')).toEqual({
      table: 'accounts',
      definition: 'CREATE UNIQUE INDEX accounts_pkey ON kortix.accounts USING btree (account_id)',
      unique: true,
      valid: true,
      backsConstraint: true,
    });
    expect(catalog.constraints.get('accounts_pkey')).toEqual({
      table: 'accounts',
      type: 'p',
      definition: 'PRIMARY KEY (account_id)',
      validated: true,
    });
  });
});

describe('assertReadOnlySetting', () => {
  test('passes only on "on"', () => {
    expect(() => assertReadOnlySetting('default_transaction_read_only', 'on')).not.toThrow();
    for (const value of ['off', '', undefined]) {
      expect(() => assertReadOnlySetting('default_transaction_read_only', value)).toThrow(
        /refusing to read the database: default_transaction_read_only/,
      );
    }
  });
});

describe('catalog.ts is the only catalog and ledger reader of the schema gates', () => {
  test('schema-contract, verify-live-schema and migration-status open no connection of their own', () => {
    for (const file of ['schema-contract.ts', 'verify-live-schema.ts', 'migration-status.ts']) {
      const text = source(file);
      expect(text, file).not.toMatch(/from 'pg'/);
      expect(text, file).not.toMatch(/\bpg_(class|index|constraint|attribute|namespace)\b|information_schema|pgmigrations/);
    }
  });

  test('the gates read through readDatabase and hold no client lifecycle', () => {
    for (const file of ['schema-contract.ts', 'verify-live-schema.ts', 'migration-status.ts']) {
      const text = source(file);
      const imported = [...text.matchAll(/import \{([^}]*)\} from '\.\/catalog'/g)]
        .flatMap((match) => match[1]!.split(','))
        .map((name) => name.trim())
        .filter((name) => name && !name.startsWith('type '));
      expect(imported, file).toEqual(['readDatabase']);
      expect(text, file).toMatch(/\breadDatabase\(/);
      expect(text, file).not.toMatch(/withReadOnly|connectReadOnly|\bclient\.|\.end\(\)/);
    }
  });

  test('catalog.ts exports one database entry point and one test seam', () => {
    // Every exported value: functions, consts, lets, vars and classes. Types and interfaces are not values.
    const exported = [
      ...source('catalog.ts').matchAll(/^export (?:async )?(?:function\*?|const|let|var|class) (\w+)/gm),
    ]
      .map((m) => m[1])
      .sort();
    expect(exported).toEqual(['assertReadOnlySetting', 'catalogFromRow', 'readDatabase', 'withReadOnly']);
    // No re-export or export list can add a value the pattern above misses.
    expect(source('catalog.ts')).not.toMatch(/^export (?:\{|\*|default\b)/m);
  });

  test('BEGIN READ ONLY is issued only by connectReadOnly', () => {
    const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.filter((f) => source(f).includes('BEGIN READ ONLY'))).toEqual(['catalog.ts']);
    const catalog = source('catalog.ts');
    const body = catalog.slice(catalog.indexOf('async function connectReadOnly'), catalog.indexOf('export async function withReadOnly'));
    const issued = (text: string) => text.split("query('BEGIN READ ONLY')").length - 1;
    expect(issued(body)).toBe(1);
    expect(issued(catalog)).toBe(1);
  });
});
