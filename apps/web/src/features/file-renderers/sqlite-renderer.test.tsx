import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const host = (tag: string) =>
  function Collaborator({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement(tag, props, children);
  };
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/input', () => ({ Input: host('input') }));
mock.module('@/components/ui/loading', () => ({ default: host('loading') }));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {}, successToast: () => {} }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
mock.module('ag-grid-react', () => ({ AgGridReact: host('grid') }));
mock.module('@/features/files/api/runtime-files', () => ({
  readFileAsBlob: async () => new Blob([createDatabaseBytes()]),
}));
mock.module('@/features/files/api/runtime-file-read', () => ({
  readRuntimeFileWithRetry: (_path: string, read: () => Promise<Blob>) => read(),
}));

const queries: string[] = [];
let masterFails = false;
let empty = false;
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
const schema = 'CREATE TABLE "a""table" (id INTEGER NOT NULL PRIMARY KEY, label TEXT DEFAULT \'seed\')';
// Use the real WASM database for all SQL. Only the outer master-query failure
// is injected: a valid SQLite file cannot naturally fail this fixed query.
class Database {
  constructor(bytes: Uint8Array) {
    const db = new SQL.Database(bytes);
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      queries.push(sql);
      if (masterFails && sql.includes('sqlite_master')) throw new Error('master unavailable');
      return exec(sql);
    };
    return db;
  }
}
mock.module('sql.js', () => ({ default: async () => ({ Database }) }));
const { SqliteRenderer } = await import('./sqlite-renderer');
let renderer: ReactTestRenderer | undefined;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = undefined;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});
function createDatabaseBytes() {
  const fixture = new SQL.Database();
  if (empty) fixture.exec('CREATE TABLE temporary_seed (id); DROP TABLE temporary_seed;');
  if (!empty) {
    fixture.exec(`${schema};
      INSERT INTO "a""table" (id, label) VALUES (1, NULL), (2, 'second');
      CREATE TABLE "b""table" (id INTEGER PRIMARY KEY);
      CREATE VIEW "v""view" AS SELECT * FROM missing_synthetic_table;`);
  }
  const bytes = fixture.export();
  fixture.close();
  return bytes;
}
async function mount() {
  queries.length = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {},
  } });
  await act(async () => { renderer = create(<SqliteRenderer filePath="/synthetic.db" fileName="synthetic.db" />); });
  if (!renderer) throw new Error('Missing renderer');
  return renderer;
}
async function click(view: ReactTestRenderer, label: string) {
  const button = view.root.findAllByType('button').find((node) => node.children.includes(label));
  if (!button) throw new Error(`Missing ${label}`);
  await act(() => button.props.onClick());
}
function sidebar(view: ReactTestRenderer) {
  return view.root.findAllByType('button').filter((node) =>
    node.findAllByType('span').some((span) => ['a"table', 'b"table', 'v"view'].includes(String(span.children[0]))));
}

test('mounted initialization reads quoted tables/views, counts, schema defaults and first selection', async () => {
  masterFails = false; empty = false;
  const view = await mount();
  expect(sidebar(view).map((node) => node.findAllByType('span').map((span) => span.children.join(''))))
    .toEqual([['a"table', '2'], ['b"table', '0'], ['v"view', '0']]);
  expect(sidebar(view)[0].props.className).toContain('bg-accent');
  expect(view.root.findByType('grid').props.columnDefs.map((col: { headerClass: string }) => col.headerClass))
    .toEqual(['font-semibold', '']);
  for (const name of ['a""table', 'b""table', 'v""view']) {
    expect(queries).toContain(`SELECT COUNT(*) FROM "${name}"`);
    expect(queries).toContain(`PRAGMA table_info("${name}")`);
  }
  await click(view, 'Schema');
  expect(view.root.findByType('pre').children).toEqual([schema]);
  const rows = view.root.findByType('tbody').findAllByType('tr');
  expect(rows[0].findAllByType('td')[5].children).toEqual(['—']);
  expect(rows[1].findAllByType('td')[5].children).toEqual(["'seed'"]);
  expect(rows[1].findAllByType('span').some((node) => node.children.includes('TEXT'))).toBe(true);
  await act(() => sidebar(view)[2].props.onClick());
  expect(view.root.findByType('tbody').findAllByType('tr')).toHaveLength(0);
});

test('mounted mutation refresh preserves selection and ignores outer metadata failures', async () => {
  masterFails = false; empty = false;
  const view = await mount();
  await act(() => sidebar(view)[1].props.onClick());
  await click(view, 'Query');
  await act(() => view.root.findByType('textarea').props.onChange({ target: { value: 'INSERT INTO "a""table" (id) VALUES (3)' } }));
  await click(view, 'i18nComplete.text00d60e31a4e6');
  expect(sidebar(view)[1].props.className).toContain('bg-accent');
  expect(sidebar(view)[0].findAllByType('span')[1].children).toEqual(['3']);
  masterFails = true;
  await act(() => view.root.findByType('textarea').props.onChange({ target: { value: 'UPDATE "a""table" SET label = NULL' } }));
  await click(view, 'i18nComplete.text00d60e31a4e6');
  expect(sidebar(view)[1].props.className).toContain('bg-accent');
  expect(sidebar(view)).toHaveLength(3);
  masterFails = false;
});

test('mounted initialization surfaces master failure and handles empty master results', async () => {
  masterFails = true; empty = false;
  const view = await mount();
  expect(view.root.findAllByType('p').some((node) => node.children.includes('master unavailable'))).toBe(true);
  masterFails = false; empty = true;
  await act(() => view.root.findByType('button').props.onClick());
  expect(view.root.findByType('h3').children).toEqual(['componentsFileRenderersSqliteRenderer.line772JsxTextEmptyDatabase']);
  empty = false;
});
