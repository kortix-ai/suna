/** Local preparation only. No destination client and no migration/apply command. */
import { parseArgs } from 'node:util';
import { Ledger, digest } from './ledger';
import { LegacySource, type JsonRow } from './source';

const TABLES = ['projects', 'threads', 'messages', 'resources', 'agents', 'agent_versions', 'agent_runs', 'file_uploads', 'knowledge_base_entries', 'knowledge_base_folders', 'documents', 'user_memories', 'agent_triggers'];

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'source-ref': { type: 'string' }, 'key-env': { type: 'string' }, out: { type: 'string' },
    table: { type: 'string' }, pk: { type: 'string' }, schema: { type: 'string', default: 'public' },
    'thread-id': { type: 'string' }, 'page-size': { type: 'string', default: '250' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help) {
    console.log('Read-only: inspect | storage | export-table | export-thread\nRequired: --source-ref REF --key-env ENV_NAME\nExports: --out /path/.legacy-transfer/REF [--table TABLE --pk COLUMN --schema public]\nThread: --thread-id UUID. No apply command exists.'); return;
  }
  if (!command || positionals.length !== 1 || !['inspect', 'storage', 'export-table', 'export-thread'].includes(command)) throw new Error('Unknown command; remote writes are disabled');
  if (!values['source-ref'] || !values['key-env']) throw new Error('--source-ref and --key-env are required');
  const ref = values['source-ref'];
  const source = new LegacySource(ref, process.env[values['key-env']] ?? '');
  if (command === 'inspect') {
    const schema = await source.schema() as { definitions?: Record<string, { properties?: Record<string, unknown> }> };
    const result: JsonRow = { source_ref: ref, observed_at: new Date().toISOString(), tables: {}, buckets: [] };
    for (const table of TABLES) {
      if (!schema.definitions?.[table]) { (result.tables as JsonRow)[table] = { exposed: false }; continue; }
      try { (result.tables as JsonRow)[table] = { exposed: true, count: await source.count(table), columns: Object.keys(schema.definitions[table].properties ?? {}) }; }
      catch (error) { (result.tables as JsonRow)[table] = { exposed: true, error: (error as Error).message }; }
    }
    result.buckets = (await source.buckets()).map(b => ({ id: b.id, public: b.public, file_size_limit: b.file_size_limit }));
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (!values.out) throw new Error('--out is required');
  const ledger = new Ledger(values.out);
  try {
    if (command === 'storage') {
      for (const bucket of await source.buckets()) {
        const name = String(bucket.id); let count = 0; let bytes = 0;
        ledger.begin(ref, `storage.${name}`, '{}', -1);
        for await (const rows of source.objects(name)) {
          ledger.save(ref, `storage.${name}`, 'name', rows);
          count += rows.length;
          for (const row of rows) {
            const meta = row.metadata as JsonRow | undefined;
            const size = Number(meta?.size ?? meta?.contentLength);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Missing object size in ${name}`);
            bytes += size;
          }
        }
        ledger.finish(ref, `storage.${name}`, '{}', count, count);
        console.log(JSON.stringify({ source_ref: ref, bucket: name, objects: count, bytes, contents_downloaded: false }));
      }
      return;
    }
    const thread = values['thread-id'];
    if (command === 'export-thread' && (!thread || !/^[0-9a-f-]{36}$/.test(thread))) throw new Error('--thread-id must be a UUID');
    const table = command === 'export-thread' ? 'messages' : values.table;
    const pk = command === 'export-thread' ? 'message_id' : values.pk;
    if (!table || !pk) throw new Error('--table and --pk are required');
    const filters = command === 'export-thread' ? { thread_id: `eq.${thread}` } : {};
    const scope = JSON.stringify(filters);
    const expected = await source.count(table, values.schema, filters);
    ledger.begin(ref, `${values.schema}.${table}`, scope, expected);
    let actual = 0;
    const types: Record<string, number> = {};
    for await (const rows of source.rows(table, pk, { schema: values.schema, filters, pageSize: Number(values['page-size']) })) {
      ledger.save(ref, `${values.schema}.${table}`, pk, rows, scope);
      actual += rows.length;
      for (const row of rows) if (typeof row.type === 'string') types[row.type] = (types[row.type] ?? 0) + 1;
    }
    // Re-count after reading. Matching counts still do not prove snapshot consistency.
    const after = await source.count(table, values.schema, filters);
    ledger.finish(ref, `${values.schema}.${table}`, scope, actual, expected, after);
    console.log(JSON.stringify({ source_ref: ref, table, expected, actual, count_after: after, types, scope_sha256: digest(scope), status: 'count-matched; not a transactional snapshot', destination_writes: 0 }));
  } finally { ledger.close(); }
}

if (import.meta.main) main(Bun.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
