import { expect, test } from "@playwright/test";

import { createApiJsonClient } from "../helpers/http";
import {
  type ManifestProject,
  createManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const api = createApiJsonClient(
  process.env.E2E_API_URL || "http://localhost:8008/v1",
);
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eManualAgent123!",
};

test.describe("27 — Manual agent setup", () => {
  for (const mode of ["primary", "subagent"] as const) {
    test(`creates a ${mode} through the form and preserves existing agents`, async ({
      page,
    }) => {
      test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
      await page.setViewportSize(
        mode === "primary"
          ? { width: 1280, height: 900 }
          : { width: 390, height: 844 },
      );
      const email = `e2e-agent-${mode}-${Date.now().toString(36)}@example.test`;
      await page.emulateMedia({
        colorScheme: mode === "primary" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      const owner = await createAuthUser(email, authOptions);
      let project: ManifestProject | undefined;

      try {
        const session = await signIn(email, authOptions);
        const accounts = await api<
          { account_id: string; account_role: string }[]
        >(session.access_token, "GET", "/accounts");
        const accountId = accounts.find(
          (a) => a.account_role === "owner",
        )!.account_id;
        project = await createManifestProject({
          api,
          accessToken: session.access_token,
          accountId,
          userId: owner.id,
          name: "Manual agent setup",
          databaseUrl: databaseUrl!,
        });
        const path = `/projects/${project.id}/customize/agents`;
        const originalPath = `/projects/${project.id}/agents/kortix/config`;
        const original = await api(session.access_token, "GET", originalPath);
        await installBrowserSessionDirect(page, session, path, authOptions);
        await selectAccountForUi(page, accountId);
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissOnboarding(page);

        const openForm = async () => {
          await page.getByRole("button", { name: "New", exact: true }).click();
          await expect(
            page.getByRole("menuitem", { name: /Create in chat/ }),
          ).toBeVisible();
          await page.getByRole("menuitem", { name: /Set up manually/ }).click();
          await expect(
            page.getByRole("dialog", { name: "Create agent" }),
          ).toBeVisible();
          await expect(page).toHaveURL(new RegExp(`${path}$`));
        };
        await openForm();
        const dialog = page.getByRole("dialog", { name: "Create agent" });
        const create = dialog.getByRole("button", {
          name: "Create agent",
          exact: true,
        });
        await expect(create).toBeDisabled();
        await dialog.getByLabel("Name", { exact: true }).fill("../invalid");
        await expect(create).toBeDisabled();
        await dialog.getByLabel("Name", { exact: true }).fill("kortix");
        await expect(dialog.getByRole("alert")).toContainText("already exists");
        await expect(create).toBeDisabled();

        // Cancel does not create anything, and reopening starts with an empty form.
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await openForm();
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
          "",
        );
        await expect(
          dialog.getByRole("combobox", { name: "Mode" }),
        ).toContainText("Primary");
        await dialog.getByLabel("Name", { exact: true }).fill("manual-helper");
        await dialog
          .getByLabel("Description", { exact: true })
          .fill("Reviews customer requests.");
        await dialog
          .getByLabel("Instructions", { exact: true })
          .fill("Summarize the request and list the next steps.");
        if (mode === "subagent") {
          await dialog.getByRole("combobox", { name: "Mode" }).click();
          await page
            .getByRole("option", { name: "Subagent", exact: true })
            .click();
        }
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await page.screenshot({
          path: test.info().outputPath("manual-agent-form.png"),
          animations: "disabled",
        });

        const configPath = `/v1/projects/${project.id}/agents/manual-helper/config`;
        // Interrupt the write, then retry through the real API with the same draft.
        await page.route(`**${configPath}`, (route) =>
          route.request().method() === "PUT"
            ? route.abort("connectionfailed")
            : route.continue(),
        );
        await create.click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
          "manual-helper",
        );
        await expect(
          dialog.getByLabel("Instructions", { exact: true }),
        ).toHaveValue("Summarize the request and list the next steps.");
        await page.unroute(`**${configPath}`);

        const saved = page.waitForResponse(
          (r) =>
            r.request().method() === "PUT" &&
            new URL(r.url()).pathname === configPath,
        );
        await create.click();
        const response = await saved;
        expect(response.status()).toBe(200);
        expect(response.request().postDataJSON()).toEqual({
          opencode: {
            mode,
            description: "Reviews customer requests.",
            prompt: "Summarize the request and list the next steps.",
          },
        });
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`${path}/manual-helper$`));
        await expect(
          page.getByText("Summarize the request and list the next steps.", {
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Edit", exact: true }).click();
        await expect(
          page.getByRole("textbox", { name: "Instructions", exact: true }),
        ).toHaveValue("Summarize the request and list the next steps.");

        const readBack = await api<{
          block: { opencode: Record<string, unknown> };
        }>(session.access_token, "GET", configPath.replace("/v1", ""));
        expect(readBack.block.opencode).toMatchObject(
          response.request().postDataJSON().opencode,
        );
        const file = await api<{ content: string }>(
          session.access_token,
          "GET",
          `/projects/${project.id}/files/content?path=.kortix/opencode/agents/manual-helper.md`,
        );
        expect(file.content).toContain(`mode: ${mode}`);
        expect(file.content).toContain(
          "Summarize the request and list the next steps.",
        );
        expect(await api(session.access_token, "GET", originalPath)).toEqual(
          original,
        );
        await page.goto(path);
        await expect(
          page.getByRole("link", { name: /Manual-Helper/ }),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath("agents-after-create.png"),
          animations: "disabled",
        });
      } finally {
        await project?.dispose();
        await deleteAuthUser(owner.id, authOptions);
      }
    });
  }
});
