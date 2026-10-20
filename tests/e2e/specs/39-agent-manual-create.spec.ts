import { expect, test } from "@playwright/test";
import { createApiJsonClient } from "../helpers/http";
import {
  createManifestProject,
  type ManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import {
  dismissOnboarding,
  dismissWelcomeCard,
  selectAccountForUi,
} from "../helpers/ui";

const api = createApiJsonClient(
  process.env.E2E_API_URL || "http://localhost:8008/v1",
);
const auth = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "ManualAgentTest123!",
};

test("39 — manual agent creation and editing require no model", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const databaseUrl =
    process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("E2E database is required");
  const email = `manual-agent-${Date.now()}@example.test`;
  const owner = await createAuthUser(email, auth);
  let project: ManifestProject | undefined;
  try {
    const session = await signIn(email, auth);
    const accounts = await api<
      Array<{ account_id: string; personal_account: boolean }>
    >(session.access_token, "GET", "/accounts");
    const accountId =
      accounts.find((account) => account.personal_account)?.account_id ??
      accounts[0]?.account_id;
    if (!accountId) throw new Error("personal account is required");
    project = await createManifestProject({
      api,
      accessToken: session.access_token,
      accountId,
      userId: owner.id,
      name: "Manual agent test",
      databaseUrl,
      manifestVersion: 3,
    });
    const route = `/projects/${project.id}/customize/agents`;
    await installBrowserSessionDirect(page, session, route, auth);
    await selectAccountForUi(page, accountId);
    await page.goto(route);
    await dismissOnboarding(page);
    await dismissWelcomeCard(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: /Set up manually/ }).click();
    const dialog = page.getByRole("dialog", { name: "Create an agent" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("manual-helper");
    await dialog
      .getByLabel("Instructions", { exact: true })
      .fill("Review synthetic examples.");
    const endpoint = `/projects/${project.id}/agents/manual-helper/config`;
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(endpoint),
    );
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().headers()["if-none-match"]).toBe("*");
    const collision = await fetch(`${process.env.E2E_API_URL}${endpoint}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        "If-None-Match": "*",
      },
      body: JSON.stringify({ behavior: { prompt: "Must not overwrite" } }),
    });
    expect(collision.status).toBe(409);
    expect(response.request().postDataJSON()).toEqual({
      behavior: { prompt: "Review synthetic examples." },
    });
    await expect(page).toHaveURL(new RegExp("/customize/agents/manual-helper"));
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    const instructions = page.getByRole("textbox", {
      name: "Instructions",
      exact: true,
    });
    await expect(instructions).toHaveValue("Review synthetic examples.");
    await instructions.fill("Review updated synthetic examples.");
    const edited = page.waitForResponse(
      (result) =>
        result.request().method() === "PUT" && result.url().endsWith(endpoint),
    );
    await page.getByRole("button", { name: /^Save/ }).click();
    expect((await edited).status()).toBe(200);
    const persisted = await api<{
      block: { behavior: { prompt: string; model?: string } };
    }>(session.access_token, "GET", endpoint);
    expect(persisted.block.behavior.prompt).toBe(
      "Review updated synthetic examples.",
    );
    expect(persisted.block.behavior.model).toBeUndefined();
    await page.reload();
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    await expect(instructions).toHaveValue(
      "Review updated synthetic examples.",
    );
  } finally {
    await project?.dispose();
    await deleteAuthUser(owner.id, auth);
  }
});
