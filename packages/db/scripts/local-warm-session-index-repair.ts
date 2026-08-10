import pg from 'pg';

const INDEX_NAME = 'idx_project_sessions_one_available_warm';

export interface LocalWarmSessionIndexRepairResult {
  repaired: boolean;
  discardedDuplicates: number;
}

/**
 * Repair historical loopback databases that recorded the warm-session index
 * migration after PostgreSQL left an invalid index behind.
 *
 * The API reads the newest available row first. Keep that row and mark every
 * older duplicate as discarded. A table lock makes the data repair and the
 * non-concurrent local index rebuild atomic with respect to API writes.
 */
export async function repairLocalWarmSessionIndex(
  databaseUrl: string,
): Promise<LocalWarmSessionIndexRepairResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const {
      rows: [schema],
    } = await client.query<{ ready: boolean }>(`
      select to_regclass('kortix.project_sessions') is not null
         and exists (
           select 1
             from information_schema.columns
            where table_schema = 'kortix'
              and table_name = 'project_sessions'
              and column_name = 'metadata'
         ) as ready
    `);
    if (!schema?.ready) return { repaired: false, discardedDuplicates: 0 };

    const {
      rows: [index],
    } = await client.query<{ valid: boolean | null }>(`
      select i.indisvalid as valid
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
       where n.nspname = 'kortix'
         and c.relname = '${INDEX_NAME}'
    `);
    if (index?.valid === true) return { repaired: false, discardedDuplicates: 0 };

    await client.query('begin');
    try {
      await client.query('lock table kortix.project_sessions in share row exclusive mode');
      const repaired = await client.query(`
        with ranked as (
          select session_id,
                 row_number() over (
                   partition by project_id, created_by
                   order by created_at desc, session_id desc
                 ) as position
            from kortix.project_sessions
           where created_by is not null
             and metadata->'warm_session'->>'state' = 'available'
             and coalesce(metadata->>'deletedAt', '') = ''
        )
        update kortix.project_sessions as session
           set metadata = jsonb_set(
                 coalesce(session.metadata, '{}'::jsonb),
                 '{warm_session}',
                 coalesce(session.metadata->'warm_session', '{}'::jsonb)
                   || jsonb_build_object(
                        'state', 'discarded',
                        'discarded_at', clock_timestamp(),
                        'discard_reason', 'duplicate_repair'
                      ),
                 true
               ),
               updated_at = clock_timestamp()
          from ranked
         where ranked.session_id = session.session_id
           and ranked.position > 1
      `);

      await client.query(`drop index if exists kortix.${INDEX_NAME}`);
      await client.query(`
        create unique index ${INDEX_NAME}
          on kortix.project_sessions (project_id, created_by)
         where created_by is not null
           and metadata->'warm_session'->>'state' = 'available'
           and coalesce(metadata->>'deletedAt', '') = ''
      `);
      await client.query('commit');
      return {
        repaired: true,
        discardedDuplicates: repaired.rowCount ?? 0,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    await client.end();
  }
}
