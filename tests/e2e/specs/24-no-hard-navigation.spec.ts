import { type Locator, type Page, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:13738/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eNoHardNav123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

/**
 * Clicking a menu item must never reload the document.
 *
 * Next 16.3 silently degrades a client navigation into a full page load when
 * the RSC fetch it runs at click time returns the wrong thing — a non-flight or
 * non-2xx body, a build id that differs from the client bundle's, a redirect
 * payload, or a rejected fetch
 * (node_modules/next/dist/client/components/router-reducer/fetch-server-response.js
 * lines 148 / 177 / 181 / ~205). A prefetched `<Link>` never runs that fetch; a
 * `<button onClick={() => router.push(href)}>` runs it cold on every click.
 *
 * The unit-level tripwire is src/lib/navigation/nav-contract.test.ts. This spec
 * is the behavioral half: it drives the real controls in a real browser and
 * proves the document survived.
 *
 * The sentinel is the whole mechanism. A value written onto `window` cannot
 * survive a document load — the JS context is destroyed and rebuilt. So if it
 * is still there after the click, and the URL changed, the navigation was soft.
 * `performance.getEntriesByType('navigation')` would also work, but it does not
 * distinguish "reloaded once" from "reloaded twice", and it is cleared by the
 * very reload we are hunting.
 */
const SENTINEL = "__kortixSoftNavSentinel";

async function armSentinel(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, unknown>)[key] = "armed";
  }, SENTINEL);
  // Prove the sentinel is actually set before relying on its absence later.
  await expect
    .poll(() =>
      page.evaluate(
        (key) => (window as unknown as Record<string, unknown>)[key],
        SENTINEL,
      ),
    )
    .toBe("armed");
}

async function sentinelSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === "armed",
    SENTINEL,
  );
}

/**
 * A nav control must BE an anchor, not merely behave like one on a good day.
 *
 * This is the assertion that actually catches the bug. A `<button>` calling
 * `router.push` still performs a soft navigation on the happy path — the reload
 * only appears once the cold RSC fetch it runs answers wrong (build-id skew
 * after a deploy, an auth bounce, a 401, a network blip). None of those
 * reproduce on demand in a test run, so asserting "the page did not reload"
 * would pass against the very code we are fixing.
 *
 * The anchor is the invariant that removes the exposure: an anchor's
 * destination is in the DOM at render time, so Next prefetches it and the click
 * never runs that fetch at all.
 */
async function expectAnchor(
  control: Locator,
  label: string,
  expectedHref: RegExp,
): Promise<void> {
  const tag = await control.evaluate((el) => el.tagName);
  expect(
    tag,
    `${label}: this control is a <${tag.toLowerCase()}>, not an anchor. ` +
      "A button + router.push runs the RSC fetch cold on every click, which is " +
      "what turns a menu click into a full page reload under deploy skew or an " +
      "auth bounce. Render it as <Link> via the primitive's `asChild` prop — " +
      "see apps/web/eslint-rules/no-router-push-for-static-href.mjs.",
  ).toBe("A");
  const href = await control.getAttribute("href");
  expect(href ?? "", `${label}: anchor has no usable href`).toMatch(
    expectedHref,
  );
}

/**
 * Arm, click, assert the URL moved, assert the document never reloaded.
 *
 * The sentinel is the second half of the proof. It cannot catch a latent
 * `router.push` (see `expectAnchor`), but it does catch the unconditional
 * cases — a `window.location.*` call, or a converted control that lost its
 * anchor and fell back to a document navigation.
 *
 * `label` names the control the way a user would, so a failure reads as
 * "Customize tab bar hard-refreshed the page" rather than "expected true".
 */
async function expectSoftNavigation(
  page: Page,
  label: string,
  click: () => Promise<void>,
  expectedUrl: RegExp,
): Promise<void> {
  await armSentinel(page);
  const before = page.url();

  await click();
  await expect(page, `${label}: URL did not change`).toHaveURL(expectedUrl, {
    timeout: 30_000,
  });

  const survived = await sentinelSurvived(page);
  expect(
    survived,
    `${label}: the document RELOADED (${before} -> ${page.url()}). ` +
      "A menu click must be a client-side navigation. The control is most " +
      "likely a <button> calling router.push instead of a prefetching <Link> " +
      "— see apps/web/eslint-rules/no-router-push-for-static-href.mjs.",
  ).toBe(true);
}

function sidebar(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}

async function openWorkspacePicker(page: Page): Promise<Locator> {
  const trigger = sidebar(page).getByRole("button", {
    name: "Switch workspace",
    exact: true,
  });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Switch Workspace", exact: true })
    .click();
  const picker = page.getByRole("menu", {
    name: "Switch Workspace",
    exact: true,
  });
  await expect(picker).toBeVisible();
  return picker;
}

test.describe("24 — a menu click never reloads the document", () => {
  test("every product-shell nav control performs a soft navigation", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(300_000);

    const runId = Date.now().toString(36);
    const email = `e2e-no-hard-nav-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    const projectIds: string[] = [];

    // A hard reload usually announces itself as a fresh document load. Count
    // them independently of the sentinel so a failure names both symptoms.
    const documentLoads: string[] = [];
    page.on("load", () => documentLoads.push(page.url()));

    try {
      const accounts = await api<AccountSummary[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      const account = accounts.find(
        (item) =>
          item.personal_account ||
          item.is_primary_owner ||
          item.account_role === "owner",
      );
      if (!account) throw new Error("the seeded user owns no account");

      const first = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Nav First ${runId}`,
      });
      const second = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Nav Second ${runId}`,
      });
      projectIds.push(first.id, second.id);

      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${first.id}`,
        authOptions,
      );
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${first.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);

      const loadsAfterBoot = documentLoads.length;

      // 1. Switching workspace from the sidebar picker. Every row here was a
      //    <DropdownMenuItem onSelect={() => router.push(...)}> and the file
      //    imported no next/link at all.
      const picker = await openWorkspacePicker(page);
      const secondRow = picker.getByRole("menuitem", {
        name: `Nav Second ${runId}`,
      });
      await expectAnchor(
        secondRow,
        "sidebar workspace picker row",
        new RegExp(`/projects/${second.id}`),
      );
      // The "Account settings" row above the list, same menu, same conversion.
      await expectAnchor(
        picker.getByRole("menuitem", { name: "Account settings" }),
        'workspace picker "Account settings" row',
        /\/accounts\//,
      );
      await expectSoftNavigation(
        page,
        "sidebar workspace picker row",
        async () => {
          await secondRow.click();
        },
        new RegExp(`/projects/${second.id}`),
      );
      await dismissOnboarding(page);

      // 2. Customize — the sidebar entry that already shipped as a prefetching
      //    Link. It is the control the others are being brought up to match, so
      //    it doubles as the positive control for this whole spec.
      await expectSoftNavigation(
        page,
        "sidebar Customize entry",
        async () => {
          await sidebar(page)
            .getByRole("link", { name: /customize/i })
            .first()
            .click();
        },
        /\/customize/,
      );

      // 3. The Customize tab bar. It rendered <Link prefetch={false}>, so every
      //    tab switch paid a cold RSC fetch.
      const tabBar = page.getByRole("navigation").filter({ hasText: /agent/i });
      const secondTab = tabBar.getByRole("link").nth(1);
      if (await secondTab.isVisible().catch(() => false)) {
        const tabHref = await secondTab.getAttribute("href");
        if (tabHref) {
          await expectSoftNavigation(
            page,
            "Customize tab bar",
            async () => {
              await secondTab.click();
            },
            new RegExp(tabHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );
        }
      }

      // 4. Back to the project home, then the sidebar "New" entry — the control
      //    that started this investigation. It calls the no-options branch of
      //    useNewProjectSession, whose destination is the static project home.
      await page.goto(`/projects/${second.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);

      const newEntry = sidebar(page)
        .getByRole("link", { name: /^new$/i })
        .or(sidebar(page).getByRole("button", { name: /^new$/i }))
        .first();
      if (await newEntry.isVisible().catch(() => false)) {
        await expectAnchor(
          newEntry,
          'sidebar "New" entry',
          new RegExp(`/projects/${second.id}`),
        );
        await expectSoftNavigation(
          page,
          'sidebar "New" entry',
          async () => {
            await newEntry.click();
          },
          new RegExp(`/projects/${second.id}`),
        );
      }

      // The independent symptom: no control above may have produced a document
      // load. `page.goto` in step 4 is the one deliberate reload, so allow
      // exactly that many.
      const deliberateReloads = 1;
      expect(
        documentLoads.length - loadsAfterBoot,
        `document loads fired by menu clicks: ${documentLoads
          .slice(loadsAfterBoot)
          .join(", ")}`,
      ).toBeLessThanOrEqual(deliberateReloads);
    } finally {
      for (const id of projectIds) {
        await deleteDatabaseProject(env, id).catch(() => undefined);
      }
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
