/** Local preparation only. No destination client and no migration/apply command. */
import { parseArgs } from 'node:util';
import { assertPreparationScope } from './scope';
import { constants, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectThread } from './projection';
import { Ledger, digest } from './ledger';
import { LegacySource, type JsonRow } from './source';

const TABLES = ['projects', 'threads', 'messages', 'resources', 'agents', 'agent_versions', 'agent_runs', 'file_uploads', 'knowledge_base_entries', 'knowledge_base_folders', 'documents', 'user_memories', 'agent_triggers'];

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'scope-file': { type: 'string', default: '.legacy-transfer/scope.json' }, 'source-ref': { type: 'string' }, 'key-env': { type: 'string' }, out: { type: 'string' },
    table: { type: 'string' }, pk: { type: 'string' }, schema: { type: 'string', default: 'public' },
    'thread-id': { type: 'string' }, 'runtime-version': { type: 'string' }, 'attachments-file': { type: 'string' }, 'page-size': { type: 'string', default: '250' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help) {
    console.log('Read-only: inspect | storage | export-table | export-thread | project-thread (local only)\nRequired: --source-ref REF --key-env ENV_NAME\nExports: --out /path/.legacy-transfer/REF [--table TABLE --pk COLUMN --schema public]\nThread: --thread-id UUID. No apply command exists.'); return;
  }
  if (!command || positionals.length !== 1 || !['inspect', 'storage', 'export-table', 'export-thread', 'project-thread'].includes(command)) throw new Error('Unknown command; remote writes are disabled');
  if (!values['source-ref']) throw new Error('--source-ref is required');
  const scope = await Bun.file(values['scope-file']).json();
  assertPreparationScope(scope, values['source-ref']);
  if (command === 'project-thread') {
    if (!values['source-ref'] || !values['thread-id'] || !values['runtime-version'] || !values.out) throw new Error('Local projection requires --source-ref, --thread-id, --runtime-version, and --out');
    if (!/^[0-9a-f-]{36}$/.test(values['thread-id'])) throw new Error('Invalid thread UUID');
    const ledger = new Ledger(values.out);
    try {
      const ref = values['source-ref']; const threadId = values['thread-id'];
      const saved = ledger.db.query('SELECT json FROM records WHERE source_ref=? AND source_table=? AND source_id=?').get(ref, 'public.threads', threadId) as { json: string } | null;
      if (!saved) throw new Error('Export the thread metadata first');
      const scope = JSON.stringify({ thread_id: `eq.${threadId}` });
      const exported = ledger.db.query("SELECT status,actual FROM exports WHERE source_ref=? AND source_table='public.messages' AND scope=?").get(ref, scope) as { status: string; actual: number } | null;
      if (exported?.status !== 'count-matched') throw new Error('A complete thread export is required');
      const records = ledger.db.query("SELECT r.json FROM records r JOIN export_records e USING(source_ref,source_table,source_id) WHERE e.source_ref=? AND e.source_table='public.messages' AND e.scope=?").all(ref, scope) as Array<{ json: string }>;
      if (records.length !== exported.actual) throw new Error('Export membership does not match its recorded count');
      const attachments = values['attachments-file'] ? await Bun.file(values['attachments-file']).json() : undefined;
      const thread = JSON.parse(saved.json);
      const projectRow = ledger.db.query('SELECT json FROM records WHERE source_ref=? AND source_table=? AND source_id=?').get(ref, 'public.projects', thread.project_id) as { json: string } | null;
      const project = projectRow ? JSON.parse(projectRow.json) : undefined;
      const result = projectThread({ ref, thread, project, rows: records.map(r => JSON.parse(r.json)), runtimeVersion: values['runtime-version'], attachments });
      for (const [suffix, data] of [['native', result.runtime], ['audit', result.audit]] as const) {
        const fd = openSync(join(values.out, threadId + '.' + suffix + '.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify(data, null, 2)); } finally { closeSync(fd); }
      }
      console.log(JSON.stringify({ source_rows: result.audit.source_rows, native_messages: result.audit.native_messages, unresolved: result.audit.unresolved.length, ready_for_apply: false }));
    } finally { ledger.close(); }
    return;
  }
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
    if (command === 'export-thread') {
      let found = 0;
      for await (const rows of source.rows('threads', 'thread_id', { filters: { and: `(thread_id.eq.${thread})` } })) {
        ledger.save(ref, 'public.threads', 'thread_id', rows); found += rows.length;
      }
      if (found !== 1) throw new Error('Expected exactly one source thread');
    }
    const table = command === 'export-thread' ? 'messages' : values.table;
    const pk = command === 'export-thread' ? 'message_id' : values.pk;
    if (!table || !pk) throw new Error('--table and --pk are required');
    const filters: Record<string, string> = command === 'export-thread' ? { thread_id: `eq.${thread}` } : {};
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
