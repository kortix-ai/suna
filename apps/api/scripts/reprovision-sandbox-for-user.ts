/**
 * Comp re-provision: spin up a fresh sandbox for a user whose machine
 * never came up (or got removed upstream) without re-charging them.
 *
 * Updates the existing sandbox row in place — same accountId, same name,
 * same stripe_subscription_item_id — and only swaps externalId / baseUrl
 * for a freshly provisioned justavps machine. Stripe is never touched.
 *
 * Usage:
 *   bun run scripts/reprovision-sandbox-for-user.ts <email>            # dry run
 *   bun run scripts/reprovision-sandbox-for-user.ts <email> --apply    # do it
 *   bun run scripts/reprovision-sandbox-for-user.ts --sandbox <id> --apply
 *
 * Requires DATABASE_URL and JUSTAVPS_* env vars.
 */

import { sql as drizzleSql, eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { getProvider } from '../src/platform/providers';
import { JustAVPSProvider } from '../src/platform/providers/justavps';
import { reprovisionFailedJustAvpsSandbox } from '../src/platform/services/sandbox-reinitialize';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sandboxFlagIdx = args.indexOf('--sandbox');
const sandboxIdArg = sandboxFlagIdx >= 0 ? args[sandboxFlagIdx + 1]?.trim() : undefined;
const skipIdx = sandboxFlagIdx >= 0 ? sandboxFlagIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx);
const email = positional[0]?.trim().toLowerCase();

if (!email && !sandboxIdArg) {
  console.error('Usage:');
  console.error('  bun run scripts/reprovision-sandbox-for-user.ts <email> [--apply]');
  console.error('  bun run scripts/reprovision-sandbox-for-user.ts --sandbox <sandboxId> [--apply]');
  process.exit(1);
}

async function findSandboxByEmail(targetEmail: string) {
  const accountRows = await db.execute(drizzleSql`
    select au.account_id::text as account_id
    from auth.users u
    join basejump.account_user au on au.user_id = u.id
    where lower(u.email) = ${targetEmail}
    limit 1
  `);
  const list = (accountRows as any).rows ?? (Array.isArray(accountRows) ? accountRows : []);
  const accountId: string | undefined = list[0]?.account_id;
  if (!accountId) return null;

  const rows = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.accountId, accountId))
    .orderBy(drizzleSql`${sandboxes.createdAt} desc`);
  return rows.find((r) => r.status !== 'archived') ?? null;
}

async function findSandboxById(id: string) {
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, id)).limit(1);
  return row ?? null;
}

const target = sandboxIdArg
  ? await findSandboxById(sandboxIdArg)
  : await findSandboxByEmail(email!);

if (!target) {
  console.error(sandboxIdArg
    ? `No sandbox found for id ${sandboxIdArg}`
    : `No sandbox found for ${email}`);
  process.exit(2);
}

const sandbox = (target as typeof sandboxes.$inferSelect);

if (sandbox.provider !== 'justavps') {
  console.error(`Sandbox provider is ${sandbox.provider}, this script only supports justavps.`);
  process.exit(3);
}

const provider = getProvider('justavps') as InstanceType<typeof JustAVPSProvider>;
const providerStatus = sandbox.externalId ? await provider.getStatus(sandbox.externalId).catch(() => null) : null;

console.log('---- target sandbox ----');
console.log(`sandbox_id:     ${sandbox.sandboxId}`);
console.log(`account_id:     ${sandbox.accountId}`);
console.log(`name:           ${sandbox.name}`);
console.log(`db_status:      ${sandbox.status}`);
console.log(`external_id:    ${sandbox.externalId ?? '(none)'}`);
console.log(`base_url:       ${sandbox.baseUrl ?? '(none)'}`);
console.log(`provider says:  ${providerStatus ?? '(unknown)'}`);
const meta = (sandbox.metadata as Record<string, unknown>) ?? {};
console.log(`server_type:    ${meta.serverType ?? '(unknown)'}`);
console.log(`location:       ${meta.location ?? '(unknown)'}`);
console.log(`tier_key:       ${meta.tier_key ?? '(unknown)'}`);
const stripeSub = (meta as any).stripe_subscription_id ?? sandbox.stripeSubscriptionItemId ?? '(none)';
console.log(`stripe ref:     ${stripeSub}`);
console.log(`prov_error:     ${meta.provisioningError ?? '(none)'}`);
console.log('------------------------');

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to provision a fresh machine on justavps');
  console.log('and update this row in place. Stripe will not be touched.');
  process.exit(0);
}

console.log('\nProvisioning a fresh justavps machine for this sandbox row...');
const refreshed = await reprovisionFailedJustAvpsSandbox({
  db,
  sandbox,
  provider,
  userId: sandbox.accountId,
});

if (!refreshed) {
  console.error('Reprovision returned no row — check logs above for failure.');
  process.exit(4);
}

console.log('\n---- after ----');
console.log(`status:        ${refreshed.status}`);
console.log(`external_id:   ${refreshed.externalId}`);
console.log(`base_url:      ${refreshed.baseUrl}`);
console.log('---------------');
console.log('\nDone. The user can now access their sandbox.');
