import { expect } from "@playwright/test";

export interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role?: string;
}

type ResultClient = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: T | null }>;

/**
 * The account a freshly seeded user owns.
 *
 * Every browser journey starts here, and until now each one wrote
 * `accounts.json?.find(...)` inline. When staging answered
 * `503 MAINTENANCE_MODE` the body was an object, `.find` was undefined, and the
 * release gate reported `TypeError: _accounts$json.find is not a function`
 * (run 32231251280, `12-sandbox-templates.spec.ts:94`) — a stack trace that
 * names neither the 503 nor the endpoint. Asserting the status and the shape
 * first turns that into "GET /accounts answered 503, body …".
 *
 * `createApiResultClient` already retries a transient 5xx, so reaching this
 * assertion means the outage outlasted the whole retry budget.
 */
export async function resolvePersonalAccountId(
  api: ResultClient,
  token: string,
): Promise<string> {
  const accounts = await api<AccountSummary[]>(token, "GET", "/accounts");
  expect(
    accounts.status,
    `GET /accounts answered ${accounts.status}: ${JSON.stringify(accounts.json)}`,
  ).toBe(200);
  expect(
    Array.isArray(accounts.json),
    `GET /accounts must return an array, got ${JSON.stringify(accounts.json)}`,
  ).toBe(true);
  const personalAccount = (accounts.json ?? []).find(
    (account) =>
      account.personal_account ||
      account.is_primary_owner ||
      account.account_role === "owner",
  );
  expect(
    personalAccount?.account_id,
    "the seeded user must own a personal account",
  ).toBeTruthy();
  return personalAccount?.account_id as string;
}
