import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const apply = process.argv.includes('--apply');
const sql = postgres(databaseUrl, { max: 1 });

try {
  const [stats] = await sql<{
    legacy_stripe_rows: string;
    missing_kortix_rows: string;
    active_mismatches: string;
  }[]>`
    with legacy as (
      select *
      from (
        select *, row_number() over (partition by account_id order by coalesce(active, true) desc, id asc) as rn
        from basejump.billing_customers
        where provider = 'stripe'
      ) ranked
      where rn = 1
    )
    select
      (select count(*)::text from legacy) as legacy_stripe_rows,
      (
        select count(*)::text
        from legacy l
        left join kortix.billing_customers k on k.id = l.id
        where k.id is null
      ) as missing_kortix_rows,
      (
        select count(*)::text
        from legacy l
        join kortix.billing_customers k on k.account_id = l.account_id
        where k.id <> l.id
          and coalesce(k.provider, '') = 'stripe'
          and coalesce(k.active, true) = true
      ) as active_mismatches
  `;

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...stats }, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to sync basejump Stripe customers into kortix.billing_customers.');
    process.exit(0);
  }

  const [result] = await sql<{
    synced_rows: string;
    deactivated_conflicts: string;
  }[]>`
    with legacy as (
      select *
      from (
        select *, row_number() over (partition by account_id order by coalesce(active, true) desc, id asc) as rn
        from basejump.billing_customers
        where provider = 'stripe'
      ) ranked
      where rn = 1
    ), upserted as (
      insert into kortix.billing_customers (account_id, id, email, active, provider)
      select account_id, id, email, coalesce(active, true), provider
      from legacy
      on conflict (id) do update
      set
        account_id = excluded.account_id,
        email = excluded.email,
        active = excluded.active,
        provider = excluded.provider
      returning account_id, id
    ), deactivated as (
      update kortix.billing_customers k
      set active = false
      from legacy l
      where k.account_id = l.account_id
        and k.id <> l.id
        and coalesce(k.provider, '') = 'stripe'
        and coalesce(k.active, true) = true
      returning k.account_id, k.id
    )
    select
      (select count(*)::text from upserted) as synced_rows,
      (select count(*)::text from deactivated) as deactivated_conflicts
  `;

  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
}
