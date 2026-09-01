import { expect, test, type Page } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { createLocalGitRepository } from "../../src/fixtures/local-git";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:13738/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eCraftsUi123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

/**
 * A real, minimal, STORED-method zip. Built by hand rather than pulled from a
 * fixture directory so the spec proves the server's own archive reader against
 * bytes it can see, and so the craft's manifest lives beside the assertions
 * that depend on it.
 */
function storedZip(files: Array<{ name: string; body: string }>): Buffer {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.body, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const CRAFT_MANIFEST = `kortix_version: 2
default_agent: seo-writer
project:
  name: seo-watch-ui
agents:
  seo-writer:
    enabled: true
triggers:
  - slug: seo-weekly
    name: Weekly SEO sweep
    type: cron
    cron: "0 9 * * 1"
    agent: seo-writer
    prompt: sweep the site for regressions
`;

async function dismissOnboarding(page: Page): Promise<void> {
  await page.waitForTimeout(2_000);
  for (let step = 0; step < 12; step += 1) {
    const onboarding = page.getByRole("dialog").last();
    if (!(await onboarding.isVisible().catch(() => false))) break;
    const skip = onboarding
      .getByRole("button", { name: /^(Skip|Not now|Maybe later)/i })
      .last();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      const primary = onboarding
        .getByRole("button", {
          name: /^(Continue|Done|Open project|Start building|Get started)$/i,
        })
        .last();
      if (!(await primary.isVisible().catch(() => false))) break;
      await primary.click();
    }
    await page.waitForTimeout(250);
  }
}

test.describe("26 — Crafts UI", () => {
  /**
   * The mock this surface replaced had two specific defects that a screenshot
   * would not catch, so both are asserted as DOM + NETWORK facts here:
   *
   *   1. The grid was a hardcoded nine-entry array. So the assertion is that
   *      the card carries the title of a craft submitted through the API in
   *      THIS run — a fixture could not produce it.
   *   2. Install was a `successToast` with no request behind it. So the
   *      assertion is the outgoing POST body and the navigation to the session
   *      route it returns — not the toast.
   */
  test("renders the store from the API and installs through a real session", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-crafts-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    // A REAL bare repo, not the fixture's default `ke2e.invalid` placeholder.
    // That placeholder exists so a database-only project fails loudly the moment
    // something touches git — and the install route legitimately does: it reads
    // the project's own kortix.yaml so the agent can merge into it without
    // clobbering what is already there.
    let repository: Awaited<ReturnType<typeof createLocalGitRepository>> | null = null;
    const pageErrors: string[] = [];
    const installPosts: Array<{ url: string; body: string | null }> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/crafts/install-session")
      ) {
        installPosts.push({ url: request.url(), body: request.postData() });
      }
    });

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

      // `crafts` is flag-gated, and the sidebar row plus the store page both
      // fail closed. Seeding the flag with the project keeps the spec on the
      // surface under test instead of the flags UI.
      repository = await createLocalGitRepository(`crafts-ui-${runId}`);
      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Crafts UI ${runId}`,
        repoUrl: repository.repoUrl,
        metadata: { experimental: { crafts: true } },
      });
      projectId = project.id;

      // Submit a craft through the real route, with a title unique to this run.
      const title = `SEO watch ui ${runId}`;
      const zip = storedZip([
        {
          name: "seo-watch-ui/kortix.yaml",
          body: CRAFT_MANIFEST.replace("name: seo-watch-ui", `name: ${title}`),
        },
        {
          name: "seo-watch-ui/.kortix/opencode/agents/seo-writer.md",
          body: "---\ndescription: writes the SEO digest\n---\n\nSweep the site.\n",
        },
      ]);
      const form = new FormData();
      form.append(
        "file",
        new Blob([zip], { type: "application/zip" }),
        `seo-watch-ui-${runId}.zip`,
      );
      form.append("visibility", "private");
      const submitted = await fetch(`${apiBase}/crafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      expect(submitted.status).toBe(201);
      const submittedBody = (await submitted.json()) as {
        craft: { craft_id: string; title: string; triggers: unknown[] };
      };
      // The card's content comes from the crawl, so prove the crawl read the
      // manifest rather than echoing the filename.
      expect(submittedBody.craft.triggers).toHaveLength(1);

      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${project.id}`,
        authOptions,
      );
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);

      // ── the store renders from the network, not a fixture ────────────────
      const listResponse = page.waitForResponse(
        (response) =>
          response.url().includes("/v1/crafts") &&
          response.request().method() === "GET" &&
          response.status() === 200,
        { timeout: 60_000 },
      );
      await page.goto(`/projects/${project.id}/crafts`, {
        waitUntil: "domcontentloaded",
      });
      const listed = await listResponse;
      const listedBody = (await listed.json()) as {
        crafts: Array<{ craft_id: string; title: string }>;
      };
      expect(
        listedBody.crafts.some((c) => c.craft_id === submittedBody.craft.craft_id),
      ).toBe(true);

      await expect(
        page.getByRole("heading", { name: "Crafts", exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      // The card, addressed by the aria-label the card actually renders.
      const card = page.getByRole("button", {
        name: `Install ${submittedBody.craft.title}`,
      });
      await expect(card).toBeVisible({ timeout: 30_000 });

      // ── the install modal shows the craft's real requirements ────────────
      await card.click();
      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();
      await expect(
        modal.getByText(submittedBody.craft.title, { exact: false }).first(),
      ).toBeVisible();
      // An uploaded craft has no repository. The provenance row must say so
      // rather than linking to a 404 — the mock linked every craft to GitHub.
      await expect(modal.getByText(/file|files/i).first()).toBeVisible();

      // ── Install issues a real POST ───────────────────────────────────────
      //
      // The local profile EXCLUDES cloud sandboxes, so session creation answers
      // `503 KORTIX_URL_UNREACHABLE` here — there is no callback origin a
      // sandbox could reach. That is why this step asserts the request and the
      // authorization outcome rather than a live session.
      //
      // What IS proven, and is exactly what the mock failed at: a real request
      // leaves the browser, carrying the craft id the card was built from, and
      // it is neither rejected as unauthorized nor swallowed client-side. The
      // old Install button issued no request at all — it called `successToast`.
      // The 201 path (a real session, then navigation) is covered against a
      // stack with a reachable callback origin; see the craft-install assertions
      // in `tests/src/flows/crafts.flow.ts`.
      const installResponse = page.waitForResponse(
        (response) =>
          response.url().includes("/crafts/install-session") &&
          response.request().method() === "POST",
        { timeout: 60_000 },
      );
      await modal.getByRole("button", { name: "Install", exact: true }).click();
      const installed = await installResponse;

      // The OUTGOING payload, not just that a request happened.
      expect(installPosts).toHaveLength(1);
      expect(JSON.parse(installPosts[0].body ?? "{}")).toEqual({
        craft_id: submittedBody.craft.craft_id,
      });

      // It got PAST authz, the feature gate, and craft resolution. A 401/403
      // would mean the flag or the capability check is wrong; a 404 would mean
      // the craft id the card sent does not resolve; a 400 would mean the body
      // is malformed.
      const installBody = (await installed.json()) as {
        session_id?: string;
        code?: string;
      };
      expect([201, 503]).toContain(installed.status());
      if (installed.status() === 503) {
        expect(installBody.code).toBe("KORTIX_URL_UNREACHABLE");
      } else {
        expect(installBody.session_id).toBeTruthy();
        // The mock's circles all pointed at `mock-<id>-00` and 404'd. This
        // asserts the install lands on the session it actually created.
        await page.waitForURL(
          new RegExp(`/projects/${project.id}/sessions/${installBody.session_id}`),
          { timeout: 60_000 },
        );
      }

      // ── the runs page renders, with no craft having run yet ──────────────
      await page.goto(`/projects/${project.id}/crafts/runs`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        page.getByRole("heading", { name: "Craft runs", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      // Honest empty state, not a fabricated report.
      await expect(page.getByText("No craft has run yet")).toBeVisible({
        timeout: 30_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(loadEnv(), projectId);
      await deleteAuthUser(user.id, authOptions);
      await repository?.dispose();
    }
  });
});
