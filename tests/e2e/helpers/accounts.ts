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
 * (run 32231251280) — a stack trace that
 * names neither the 503 nor the endpoint. Asserting the status and the shape
 * first turns that into "GET /accounts answered 503, body …".
 *
 * `createApiResultClient` already retries a transient 5xx, so reaching this
 * assertion means the outage outlasted the whole retry budget.
 *
 * No account is created at sign-up any more (Workspaces D3): a seeded user
 * with no owned account gets one here, explicitly, through `POST /accounts`.
 * The name stays for the callers; the account is the user's own, not a
 * "personal" one whose id is the user id.
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
  if (personalAccount?.account_id) return personalAccount.account_id;
  const created = await api<AccountSummary>(token, "POST", "/accounts", {
    name: "E2E workspace",
  });
  expect(
    created.status,
    `POST /accounts answered ${created.status}: ${JSON.stringify(created.json)}`,
  ).toBe(201);
  expect(created.json?.account_id, "POST /accounts returned no account_id").toBeTruthy();
  return created.json?.account_id as string;
}

type JsonClient = <T>(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus?: number | number[],
) => Promise<T>;

/**
 * The account a freshly signed-in user owns, created through `POST /accounts`
 * when there is none. No account exists at sign-up (Workspaces D3), so a
 * journey that needs one makes it explicitly. For `createApiJsonClient`.
 */
export async function ensureOwnedAccount(api: JsonClient, token: string): Promise<string> {
  const accounts = await api<AccountSummary[]>(token, "GET", "/accounts");
  const own = accounts.find(
    (a) => a.personal_account || a.is_primary_owner || a.account_role === "owner",
  );
  if (own) return own.account_id;
  const created = await api<AccountSummary>(token, "POST", "/accounts", { name: "E2E workspace" }, 201);
  return created.account_id;
}
