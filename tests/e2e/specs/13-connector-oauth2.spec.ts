import { expect, test } from "@playwright/test";
import { resolvePersonalAccountId } from "../helpers/accounts";
import { seedDatabaseProject } from "../helpers/database";
import { createApiResultClient } from "../helpers/http";
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const password = "E2eConnectorOauth123!";
const api = createApiResultClient(apiBase);
const authOptions = { supabaseUrl, password };

test.describe("13 — Custom connector OAuth2", () => {
  test.setTimeout(180_000);

  let user: AuthUser;
  let session: AuthSession;
  let projectId: string;
  let accountId: string;

  test.beforeAll(async () => {
    const email = `e2e-connector-oauth-${Date.now()}@kortix.test`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);
    accountId = await resolvePersonalAccountId(api, session.access_token);
    projectId = await seedDatabaseProject({
      accountId,
      userId: user.id,
      name: `e2e-connector-oauth-${Date.now()}`,
    });
  });

  test.afterAll(async () => {
    if (projectId && session) {
      await api(session.access_token, "DELETE", `/projects/${projectId}`).catch(
        () => {},
      );
    }
    if (user?.id) await deleteAuthUser(user.id, authOptions);
  });

  test("shows every OAuth2 client-credentials strategy during connector creation", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await installBrowserSessionDirect(
      page,
      session,
      "/favicon.png",
      authOptions,
    );
    await selectAccountForUi(page, accountId);
    await page.goto(`/projects/${projectId}`, {
      waitUntil: "domcontentloaded",
    });
    await dismissOnboarding(page);

    // A user opens Customize from the sidebar. This is a real link, so
    // navigation also works before client hydration completes.
    //
    // The row lands on AGENTS, not on an index. Customize is agent-centric
    // (Marko, 2026-09-01: the agent is the object a person is granted), so
    // `ProjectCustomizeNavItem` points at the first capability tab the caller
    // may open — `capabilityTabHref(projectId, tab)`. The former index at
    // `/customize` still resolves and redirects here, which is why every
    // bookmark keeps working; it is simply no longer where the sidebar goes.
    // Reaching Connectors is then one hop along the capability TAB BAR rather
    // than a card on a chooser page.
    const customizeLink = page.getByRole("link", { name: /^Customize$/i });
    await expect(customizeLink).toHaveAttribute(
      "href",
      `/projects/${projectId}/customize/agents`,
    );
    await customizeLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/customize/agents$`),
    );
    const connectorsTab = page.getByRole("link", { name: /^Connectors/i });
    await expect(connectorsTab).toHaveAttribute(
      "href",
      `/projects/${projectId}/customize/connectors`,
    );
    await connectorsTab.click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/customize/connectors$`),
    );
    await page
      .getByRole("button", { name: /^Add a custom connector$/i })
      .click();
    await expect(
      page.getByRole("dialog", { name: /^Add a custom connector$/i }),
    ).toBeVisible();

    const authSelect = page.getByRole("combobox", { name: /^Auth$/ });
    await authSelect.click();
    await expect(page.getByRole("option", { name: "OAuth 2.0" })).toBeVisible();
    await page.getByRole("option", { name: "OAuth 2.0" }).click();

    await expect(page.getByLabel("Token URL")).toBeVisible();
    await expect(page.getByLabel("Client ID")).toBeVisible();
    await expect(page.getByLabel("Client secret")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Add connector/i }),
    ).toBeDisabled();

    const methodSelect = page.getByRole("combobox", {
      name: "Token authentication",
    });
    await methodSelect.click();
    await expect(
      page.getByRole("option", { name: "Client secret in body" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Client secret with Basic" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Public client" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Client secret JWT" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Private key JWT" }),
    ).toBeVisible();
    await page.getByRole("option", { name: "Private key JWT" }).click();

    await expect(page.getByLabel("Private key PEM")).toBeVisible();
    await expect(
      page.getByLabel("Certificate SHA-256 thumbprint"),
    ).toBeVisible();
    await expect(page.getByLabel("Client secret")).toHaveCount(0);
    expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });
});
