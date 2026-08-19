import { type Page, expect, test } from "@playwright/test";

import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import {
  type AuthEmailAction,
  createDisposableInbox,
  emailProviderStatus,
} from "../helpers/inbox";
import { deleteAuthUser } from "../helpers/session-auth";

const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const authOptions = {
  supabaseUrl,
  envFiles: ["apps/api/.env", "apps/web/.env"],
};

interface UserRow {
  id: string;
}

interface AccountRow {
  account_id: string;
}

async function requestEmailAuthentication(page: Page, email: string) {
  await page.goto("/auth", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Welcome to Kortix" }),
  ).toBeVisible();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { __ENV_LOGGED__?: boolean }).__ENV_LOGGED__,
    ),
  );
  await page.getByLabel("Email").fill(email);
  const sentAt = new Date();
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  let submitted = false;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
    const formRequest = page
      .waitForRequest(
        (request) =>
          request.method() === "POST" && new URL(request.url()).pathname === "/auth",
        { timeout: 2_000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.getByLabel("Email").press("Enter");
    submitted = await formRequest;
    if (!submitted) {
      await expect(continueButton).toBeEnabled();
    }
  }
  expect(submitted, "the hydrated auth form sends POST /auth").toBe(true);
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  return sentAt;
}

async function completeEmailAuthentication(page: Page, action: AuthEmailAction) {
  if (action.kind === "link") {
    await page.goto(action.value, { waitUntil: "domcontentloaded" });
  } else {
    await page.getByLabel("Digit 1").fill(action.value);
  }
  await expect(page).not.toHaveURL(/\/auth(?:[/?]|$)/, { timeout: 60_000 });
}

test.describe("01 - Account authentication", () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    const { available, reason } = await emailProviderStatus();
    test.skip(!available, `email provider unavailable: ${reason}`);
  });

  test("a new user creates an account from the delivered email, clears the session, and logs in again", async ({
    page,
  }) => {
    const inbox = await createDisposableInbox();
    const email = inbox.email;
    let userId: string | null = null;
    const accountIds: string[] = [];

    try {
      await test.step("A new email receives a real signup message", async () => {
        const sentAt = await requestEmailAuthentication(page, email);
        const action = await inbox.waitForAuthAction(sentAt);
        const accountsResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === "/v1/accounts" && response.status() === 200;
        });
        await completeEmailAuthentication(page, action);
        const accounts = (await accountsResponse).json() as Promise<
          Array<{ account_id?: string }>
        >;
        for (const account of await accounts) {
          if (account.account_id) accountIds.push(account.account_id);
        }
        const rows = await queryDatabaseRows<UserRow>(
          "select id::text from auth.users where lower(email) = lower($1) limit 1",
          [email],
        );
        userId = rows[0]?.id ?? null;
        expect(userId).toBeTruthy();
      });

      await test.step("The test clears the browser session", async () => {
        await page.context().clearCookies();
        await page.goto("/favicon.png", { waitUntil: "domcontentloaded" });
        await page.evaluate(() => {
          window.localStorage.clear();
          window.sessionStorage.clear();
        });
        await page.context().clearCookies();
      });

      await test.step("The existing user receives a second email and logs in again", async () => {
        const sentAt = await requestEmailAuthentication(page, email);
        const action = await inbox.waitForAuthAction(sentAt);
        await completeEmailAuthentication(page, action);
      });
    } finally {
      if (!userId) {
        const rows = await queryDatabaseRows<UserRow>(
          "select id::text from auth.users where lower(email) = lower($1) limit 1",
          [email],
        ).catch(() => []);
        userId = rows[0]?.id ?? null;
      }
      if (userId) {
        const rows = await queryDatabaseRows<AccountRow>(
          "select distinct account_id::text from kortix.account_members where user_id = $1::uuid",
          [userId],
        ).catch(() => []);
        for (const row of rows) {
          if (!accountIds.includes(row.account_id)) accountIds.push(row.account_id);
        }
      }
      for (const accountId of accountIds) {
        await runDatabaseSql(
          "delete from kortix.accounts where account_id = $1::uuid",
          [accountId],
        );
      }
      if (userId) {
        await deleteAuthUser(userId, authOptions);
      }
      await inbox.dispose();
    }
  });
});
