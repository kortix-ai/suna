// constraint-transition: commit ADD NOT VALID, VALIDATE, and DROP separately so validation never extends an ACCESS EXCLUSIVE lock
// mixed-version-safe: old code writes session, app, or monitor; the replacement accepts all old values plus environment

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '5s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    do $migration$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'sandbox_compute_sessions_workload_type_check_v2'
          and conrelid = 'kortix.sandbox_compute_sessions'::regclass
      ) then
        alter table kortix.sandbox_compute_sessions
          add constraint sandbox_compute_sessions_workload_type_check_v2
          check (workload_type in ('session', 'app', 'monitor', 'environment'))
          not valid;
      end if;
    end
    $migration$
  `);
  pgm.sql(`
    alter table kortix.sandbox_compute_sessions
      validate constraint sandbox_compute_sessions_workload_type_check_v2
  `);
  pgm.sql(`
    alter table kortix.sandbox_compute_sessions
      drop constraint if exists sandbox_compute_sessions_workload_type_check
  `);
};

export const down = false;
