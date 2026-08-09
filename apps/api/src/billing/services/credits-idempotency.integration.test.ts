import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000b711';
let client: ReturnType<typeof postgres> | null = null;

function testDb(): ReturnType<typeof postgres> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!client) client = postgres(url, { max: 16, prepare: false });
  return client;
}

async function cleanup(): Promise<void> {
  await testDb().begin(async (sql) => {
    await sql`delete from kortix.credit_ledger where account_id = ${ACCOUNT_ID}::uuid`;
    await sql`delete from kortix.credit_accounts where account_id = ${ACCOUNT_ID}::uuid`;
    await sql`delete from kortix.accounts where account_id = ${ACCOUNT_ID}::uuid`;
  });
}

async function walletBalance(): Promise<number> {
  const [row] = await testDb()`
    select balance_precise::float8 as balance
    from kortix.credit_accounts
    where account_id = ${ACCOUNT_ID}::uuid
  `;
  return Number(row?.balance);
}

async function matchingLedgerRows(): Promise<number> {
  const [row] = await testDb()`
    select count(*)::int as count
    from kortix.credit_ledger
    where account_id = ${ACCOUNT_ID}::uuid
      and idempotency_key like 'llm-gateway:idempotency-integration:%'
  `;
  return Number(row?.count);
}

async function debit(key: string, amount: number, sqlClient = testDb()): Promise<void> {
  const [row] = await sqlClient`
    select public.atomic_use_credits(
      ${ACCOUNT_ID}::uuid,
      ${amount}::numeric,
      'LLM idempotency integration debit',
      'llm_debit',
      ${key}
    ) as result
  `;
  expect(row?.result).toMatchObject({ success: true });
}

async function refund(key: string, amount: number, sqlClient = testDb()): Promise<void> {
  const [row] = await sqlClient`
    select public.atomic_add_credits(
      ${ACCOUNT_ID}::uuid,
      ${amount}::numeric,
      false,
      'LLM idempotency integration refund',
      null,
      'llm_reservation_refund',
      null,
      ${key}
    ) as result
  `;
  expect(row?.result).toMatchObject({ success: true });
}

describeWithDb('LLM wallet settlement idempotency — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    await testDb()`
      insert into kortix.accounts (account_id, name)
      values (${ACCOUNT_ID}::uuid, 'LLM wallet idempotency integration')
    `;
    await testDb()`
      insert into kortix.credit_accounts (
        account_id,
        daily_credits_balance_precise,
        expiring_credits_precise,
        non_expiring_credits_precise,
        balance_precise,
        tier
      ) values (${ACCOUNT_ID}::uuid, 0, 0, 1, 1, 'none')
    `;
  });

  afterEach(cleanup);
  afterAll(async () => {
    if (client) await client.end();
    client = null;
  });

  test('concurrent and restarted hold, debit, and refund retries move the wallet once per key', async () => {
    const holdKey = 'llm-gateway:idempotency-integration:request-1:hold';
    const debitKey = 'llm-gateway:idempotency-integration:request-1:settlement-debit';
    const refundKey = 'llm-gateway:idempotency-integration:request-1:settlement-refund';

    await Promise.all(Array.from({ length: 8 }, () => debit(holdKey, 0.01)));
    await Promise.all(Array.from({ length: 8 }, () => debit(debitKey, 0.02)));
    await Promise.all(Array.from({ length: 8 }, () => refund(refundKey, 0.004)));

    expect(await walletBalance()).toBeCloseTo(0.974, 10);
    expect(await matchingLedgerRows()).toBe(3);

    const url = process.env.TEST_DATABASE_URL!;
    const restartedClient = postgres(url, { max: 1, prepare: false });
    try {
      await debit(holdKey, 0.01, restartedClient);
      await debit(debitKey, 0.02, restartedClient);
      await refund(refundKey, 0.004, restartedClient);
    } finally {
      await restartedClient.end();
    }

    expect(await walletBalance()).toBeCloseTo(0.974, 10);
    expect(await matchingLedgerRows()).toBe(3);
  });
});
