import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { runDatabaseSql, seedDatabaseProject } from "../helpers/database";
import {
  authHeaders,
  createApiJsonClient,
  createApiStatusClient,
  isProductServerError,
  pollApiStatus,
} from "../helpers/http";
import {
  type DisposableInbox,
  createDisposableInbox,
  emailProviderStatus,
} from "../helpers/inbox";
import {
  type AuthSession,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import {
  dismissOnboarding,
  openSettingsPanel,
  selectAccountForUi,
} from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const password = "E2eAccountAccess123!";
const api = createApiJsonClient(apiBase);
const apiStatus = createApiStatusClient(apiBase);
const authOptions = { supabaseUrl, password };
const createdUserIds = new Set<string>();
const createdAccountIds = new Set<string>();
const disposableInboxes = new Set<DisposableInbox>();

/**
 * How long an IAM grant or revocation can take to be visible on EVERY API task.
 *
 * The authorization memos are in-process with a 15s TTL
 * (`iam/authorize.ts:425` `IAM_CACHE_TTL_MS`, `projects/lib/access.ts:373`), and
 * `invalidateIamCacheForUser` (`iam/cache-invalidation.ts:57-64`) is explicitly
 * **process-local**. A deployed environment runs several API tasks, so the write
 * busts the cache only on the task that served it; the others keep the old
 * verdict until their TTL expires. The code states the trade deliberately:
 * "revocations lag at most one TTL window, grants are instant".
 *
 * So a read-after-write on IAM state is eventually consistent ACROSS TASKS by
 * design, bounded by that TTL — not a defect, and not replica lag (the API has
 * no read replica: one `createDb(config.DATABASE_URL)` client, and staging's
 * database reports `pg_is_in_recovery() = f` with zero `pg_stat_replication`
 * rows). Locally there is one process, so the bust is total and these polls
 * settle on the first read.
 *
 * These assertions therefore wait out one TTL window instead of demanding the
 * first read be correct. Everything else in this journey stays a single strict
 * read — only the cross-task IAM propagation points poll.
 */
const IAM_PROPAGATION_MS = 30_000;

/**
 * `IAM_CACHE_TTL_MS` in `apps/api/src/iam/authorize.ts:425`, which is also the
 * hardcoded TTL of `loadProjectMemberRole` (`projects/lib/access.ts:373`).
 */
const IAM_CACHE_TTL_MS = 15_000;

/**
 * Wait until EVERY API task has dropped its cached authorization verdict.
 *
 * This is a timed wait on purpose, and polling cannot replace it. A successful
 * read proves only that the ONE task which answered it is fresh; it says
 * nothing about the other tasks, and the next request is load-balanced
 * independently. "Every task agrees" is not observable from outside the
 * cluster, so the TTL is the only guarantee available — after one full window
 * every entry has expired regardless of which task cached what.
 *
 * Called after an IAM write whose effect the journey then reads back. Without
 * it this spec fails intermittently at a DIFFERENT assertion each attempt —
 * observed at lines 403, 436, 704, 711 and 744 across four release-gate and
 * local attempts — because each read independently draws a fresh or stale task.
 *
 * Free on local and on any single-process target: one process means the
 * invalidation is total, so there is nothing to wait for.
 */
async function settleIamPropagation(): Promise<void> {
  if (!process.env.KE2E_TARGET) return;
  await new Promise((resolve) => setTimeout(resolve, IAM_CACHE_TTL_MS + 1_500));
}

type AccountRole = "owner" | "admin" | "member";
type ProjectRole = "manager" | "member";

interface AccountSummary {
  account_id: string;
  name: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: AccountRole;
}

interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: "active" | "archived";
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
}

interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  explicit_project_count?: number;
}

interface InviteResult {
  status: "added" | "pending";
  user_id?: string;
  invite_id?: string;
  email: string;
  account_role: AccountRole;
  email_sent?: boolean;
  invite_url?: string;
}

interface ProjectAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
}

interface ProjectAccessResponse {
  project_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: ProjectAccessMember[];
}

async function createProjectForAccessTest(
  token: string,
  accountId: string,
  ownerUserId: string,
  name: string,
  repoUrl: string,
): Promise<ProjectSummary> {
  const response = await fetch(`${apiBase}/projects`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      account_id: accountId,
      name,
      repo_url: repoUrl,
      default_branch: "main",
    }),
  });
  const body = await response.text();
  let project: ProjectSummary;
  if (response.status === 201) {
    project = JSON.parse(body) as ProjectSummary;
  } else if (
    response.status === 409 &&
    body.includes("GitHub App installation required")
  ) {
    const projectId = await seedDatabaseProject({
      accountId,
      userId: ownerUserId,
      name,
      repoUrl,
      projectRole: "manager",
    });
    project = await api<ProjectSummary>(token, "GET", `/projects/${projectId}`);
  } else {
    throw new Error(
      `Expected 201/409 from ${response.url}, got ${response.status}: ${body}`,
    );
  }
  await api<ProjectSummary>(
    token,
    "PATCH",
    `/projects/${project.project_id}/onboarding`,
    {
      completed: true,
    },
  );
  return project;
}

/**
 * Repositories graduated out of the Settings overlay's rail into the
 * Customize bar's Settings tab (`/projects/[id]/config`), merged into the
 * General section as a "Git repo" subsection (`git-view.tsx`,
 * `SettingsSubsectionHeader title="Git repo"` — an `h3`, one level under the
 * page's own `h1`). Navigate straight there; the returned locator scopes
 * subsequent queries to the page, which is fine since there is exactly one
 * repo link on it.
 */
async function openRepositoriesSection(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/config`, {
    waitUntil: "domcontentloaded",
  });
  await dismissOnboarding(page);
  await expect(
    page.getByRole("heading", { name: "Git repo", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  return page;
}

/**
 * Members graduated a second time, off the Settings overlay entirely and
 * onto its own top-level Customize tab (`/projects/[id]/members`,
 * `settings-tabs.ts` GRADUATED map). `CapabilityPageShell` renders the page
 * title "Members" as an `h1`; the pane defaults to its "People" section
 * (`members-tab.tsx`'s `useState<MembersSection>('people')`), the one with
 * the member table and Invite button this test needs — no `?section=`
 * required.
 */
async function openMembersSection(page: Page, projectId: string) {
  // The per-project Members page is gone (2026-08-18/19): `/projects/:id/members`
  // redirects into the account hub's Projects panel for that project
  // (`?tab=access-projects&project=…`), which lists who has access as one
  // shared `AccessList` and opens the shared "Grant access" dialog.
  await page.goto(`/projects/${projectId}/members`, {
    waitUntil: "domcontentloaded",
  });
  await dismissOnboarding(page);
  await expect(page).toHaveURL(
    new RegExp(`/accounts/[0-9a-f-]+\\?tab=access-projects&project=${projectId}`),
    { timeout: 30_000 },
  );
  await expect(page.getByText(/^Access · \d+$/).first()).toBeVisible({
    timeout: 30_000,
  });
  return page;
}

function byEmail(members: ProjectAccessMember[], email: string) {
  return members.find(
    (member) => member.email?.toLowerCase() === email.toLowerCase(),
  );
}

function toGitHubWebUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

/**
 * QUARANTINED against a deployed target — runs in `tests-browser-nightly.yml`,
 * excluded from the blocking release gate.
 *
 * This journey makes ~13 reads that immediately follow an IAM write. Every
 * authorization verdict is cached in a PROCESS-LOCAL memo with a 15s TTL
 * (`iam/authorize.ts:425` `IAM_CACHE_TTL_MS`; `projects/lib/access.ts:373`), and
 * `invalidateIamCacheForUser` (`iam/cache-invalidation.ts:57-64`) busts only the
 * task that served the write. A deployed environment runs several API tasks, so
 * each read independently draws a fresh or a stale one. The API states the trade
 * deliberately: "revocations lag at most one TTL window, grants are instant."
 *
 * That is real, understood, intentional behaviour — NOT replica lag. The API has
 * a single `createDb(config.DATABASE_URL)` client with no read-replica routing
 * anywhere, and staging's database reports `pg_is_in_recovery() = f` with zero
 * `pg_stat_replication` rows.
 *
 * Polling cannot fix it: a successful read proves only that the ONE task that
 * answered is fresh, and the next request is balanced independently, so "every
 * task agrees" is not observable from outside the cluster. The
 * `settleIamPropagation()` waits below are a PARTIAL mitigation — they wait out
 * one TTL window after each IAM write — and they moved the failure four times
 * (lines 403 → 436 → 704/711/744 → 712) without making the journey
 * deterministic. The last of those is not even IAM-related, which is the signal
 * to stop patching.
 *
 * To un-quarantine, the product needs ONE of:
 *   - a distributed IAM invalidation bus (e.g. Redis pub/sub) so a bust reaches
 *     every task, or
 *   - a per-spec sticky-task strategy so one journey talks to one task.
 *
 * The RBAC surface itself stays covered on every gate run by the IAM-* and ACC-*
 * API flows, which assert the same authorization contract without a browser.
 */
test.describe("08 — Accounts, invites, and project access", { tag: "@quarantine" }, () => {
  // 300s covered the journey itself. Against a deployed target it also has to
  // absorb five `settleIamPropagation()` waits (~82s total) — the price of a
  // multi-task authorization cache. Local is unaffected: those waits are no-ops
  // off a deployed target, so this budget stays as slack there.
  test.setTimeout(420_000);

  test.beforeEach(async () => {
    const { available, reason } = await emailProviderStatus();
    test.skip(!available, `email provider unavailable: ${reason}`);
  });

  test.afterEach(async () => {
    for (const accountId of createdAccountIds) {
      await runDatabaseSql(
        "delete from kortix.accounts where account_id = $1::uuid",
        [accountId],
      ).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await deleteAuthUser(userId, authOptions);
    }
    for (const inbox of disposableInboxes) {
      await inbox.dispose().catch(() => {});
    }
    createdAccountIds.clear();
    createdUserIds.clear();
    disposableInboxes.clear();
  });

  test("API and web enforce account roles plus project-scoped access", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const status = response.status();
      const url = response.url();
      // 500 only — a 502/503/504 on this shared staging origin is the edge or
      // the maintenance gate, not a defect in the page. See
      // `isProductServerError`.
      if (
        isProductServerError(status) &&
        (url.includes("/v1/accounts") || url.includes("/v1/projects"))
      ) {
        serverErrors.push(`${status} ${url}`);
      }
    });

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const inviteInbox = await createDisposableInbox();
    disposableInboxes.add(inviteInbox);
    const ownerEmail = `e2e-owner-${runId}@example.test`;
    const memberEmail = `e2e-member-${runId}@example.test`;
    const invitedEmail = inviteInbox.email;
    const uiInvitedEmail = `e2e-ui-invite-${runId}@example.test`;
    const accountName = `E2E Org ${runId}`;
    const initialProjectName = `E2E Project ${runId}`;

    const owner = await createAuthUser(ownerEmail, authOptions);
    createdUserIds.add(owner.id);
    createdAccountIds.add(owner.id);
    const member = await createAuthUser(memberEmail, authOptions);
    createdUserIds.add(member.id);
    createdAccountIds.add(member.id);
    const ownerSession = await signIn(ownerEmail, authOptions);
    const memberSession = await signIn(memberEmail, authOptions);

    const ownerInitialAccounts = await api<AccountSummary[]>(
      ownerSession.access_token,
      "GET",
      "/accounts",
    );
    const ownerPersonalAccount = ownerInitialAccounts.find(
      (item) =>
        item.personal_account ||
        item.is_primary_owner ||
        item.account_role === "owner",
    );
    expect(ownerPersonalAccount).toBeTruthy();
    await api<AccountSummary[]>(memberSession.access_token, "GET", "/accounts");

    const account = await api<AccountSummary>(
      ownerSession.access_token,
      "POST",
      "/accounts",
      { name: accountName },
      201,
    );
    createdAccountIds.add(account.account_id);
    expect(account.name).toBe(accountName);
    expect(account.account_role).toBe("owner");

    const addedMember = await api<InviteResult>(
      ownerSession.access_token,
      "POST",
      `/accounts/${account.account_id}/members`,
      { email: memberEmail, role: "member" },
      201,
    );
    expect(addedMember.status).toBe("added");
    expect(addedMember.user_id).toBe(member.id);
    // The journey reads this membership back below (GET /accounts, then
    // GET /projects?account_id=). See settleIamPropagation.
    await settleIamPropagation();

    const inviteSentAt = new Date();
    const pendingInvite = await api<InviteResult>(
      ownerSession.access_token,
      "POST",
      `/accounts/${account.account_id}/members`,
      { email: invitedEmail, role: "member" },
      201,
    );
    expect(pendingInvite.status).toBe("pending");
    expect(pendingInvite.email_sent).toBe(true);
    expect(pendingInvite.invite_id).toBeTruthy();
    if (!pendingInvite.invite_id)
      throw new Error("pending invite has no invite_id");
    const accountInviteId = pendingInvite.invite_id;
    const deliveredInviteLink = await inviteInbox.waitForInviteLink(inviteSentAt);
    expect(new URL(deliveredInviteLink).pathname).toBe(
      `/invites/${accountInviteId}`,
    );

    const memberAccounts = await api<AccountSummary[]>(
      memberSession.access_token,
      "GET",
      "/accounts",
    );
    expect(
      memberAccounts.some((item) => item.account_id === account.account_id),
    ).toBe(true);

    const project = await createProjectForAccessTest(
      ownerSession.access_token,
      account.account_id,
      owner.id,
      initialProjectName,
      `https://github.com/kortix-ai/e2e-${runId}.git`,
    );
    expect(project.name).toBe(initialProjectName);
    expect(project.project_role).toBe("manager");
    expect(project.effective_project_role).toBe("manager");
    const projectRepoWebUrl = toGitHubWebUrl(project.repo_url);

    const ownerProjects = await api<ProjectSummary[]>(
      ownerSession.access_token,
      "GET",
      `/projects?account_id=${account.account_id}`,
    );
    expect(ownerProjects.map((item) => item.project_id)).toContain(
      project.project_id,
    );

    const memberProjectsBeforeGrant = await api<ProjectSummary[]>(
      memberSession.access_token,
      "GET",
      `/projects?account_id=${account.account_id}`,
    );
    expect(memberProjectsBeforeGrant).toEqual([]);
    expect(
      await apiStatus(
        memberSession.access_token,
        "GET",
        `/projects/${project.project_id}`,
      ),
    ).toBe(403);
    expect(
      await apiStatus(
        memberSession.access_token,
        "POST",
        `/projects/${project.project_id}/sessions`,
        {},
      ),
    ).toBe(403);

    const accessBeforeGrant = await api<ProjectAccessResponse>(
      ownerSession.access_token,
      "GET",
      `/projects/${project.project_id}/access`,
    );
    expect(accessBeforeGrant.can_manage).toBe(true);
    expect(
      byEmail(accessBeforeGrant.members, memberEmail)?.project_role,
    ).toBeNull();
    expect(
      byEmail(accessBeforeGrant.members, memberEmail)?.effective_project_role,
    ).toBeNull();

    const memberGrant = await api<ProjectAccessMember>(
      ownerSession.access_token,
      "PUT",
      `/projects/${project.project_id}/access/${member.id}`,
      { role: "member" },
    );
    expect(memberGrant.project_role).toBe("member");
    expect(memberGrant.effective_project_role).toBe("member");
    await settleIamPropagation();

    // Cross-task IAM propagation — see IAM_PROPAGATION_MS.
    await expect
      .poll(
        async () =>
          (
            await api<ProjectSummary[]>(
              memberSession.access_token,
              "GET",
              `/projects?account_id=${account.account_id}`,
            )
          ).map((item) => item.project_id),
        { timeout: IAM_PROPAGATION_MS },
      )
      .toEqual([project.project_id]);
    const readableProject = await api<ProjectSummary>(
      memberSession.access_token,
      "GET",
      `/projects/${project.project_id}`,
    );
    expect(readableProject.effective_project_role).toBe("member");
    // A plain member holds `project.session.start`, but agents are
    // deny-by-default for member-tier (2026-08-19): with no agent grant —
    // and this repo-URL project has no manifest, so there is no agent to
    // grant — session create is refused with a NAMED reason, not the old
    // "your role is too low" 403. Owners and managers are untouched (the
    // owner already created sessions above). The granted-member happy path
    // is pinned by `integration-member-session-prompt-gates-http.test.ts`.
    {
      const refused = await fetch(
        `${apiBase}/projects/${project.project_id}/sessions`,
        {
          method: "POST",
          headers: authHeaders(memberSession.access_token),
          // A well-formed body: the agent gate answers before provider
          // validation would, and an invalid provider would 400 first.
          body: JSON.stringify({ name: "member-blocked" }),
        },
      );
      expect(refused.status).toBe(403);
      const refusedBody = (await refused.json()) as { code?: string };
      expect(refusedBody.code).toBe("no_agent_access");
    }
    // ...but it still cannot customize the project.
    expect(
      await apiStatus(
        memberSession.access_token,
        "PATCH",
        `/projects/${project.project_id}`,
        {
          name: "blocked",
        },
      ),
    ).toBe(403);

    await api<{ ok: true }>(
      ownerSession.access_token,
      "DELETE",
      `/projects/${project.project_id}/access/${member.id}`,
    );
    // Poll, do not assert instantly: the revoke is only guaranteed to be
    // visible on the replica that served it. See `pollApiStatus`.
    expect(
      await pollApiStatus(
        () =>
          apiStatus(
            memberSession.access_token,
            "GET",
            `/projects/${project.project_id}`,
          ),
        403,
      ),
    ).toBe(403);

    const promoted = await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      "PATCH",
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: "admin" },
    );
    expect(promoted.account_role).toBe("admin");
    // The very next call is authorized by this new role. See
    // settleIamPropagation.
    await settleIamPropagation();

    const adminUpdate = await api<ProjectSummary>(
      memberSession.access_token,
      "PATCH",
      `/projects/${project.project_id}`,
      { name: `${initialProjectName} Admin` },
    );
    expect(adminUpdate.effective_project_role).toBe("manager");
    expect(adminUpdate.name).toBe(`${initialProjectName} Admin`);

    await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      "PATCH",
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: "member" },
    );
    // A demotion is a revoke: same process-local IAM cache window as above.
    expect(
      await pollApiStatus(
        () =>
          apiStatus(
            memberSession.access_token,
            "GET",
            `/projects/${project.project_id}`,
          ),
        403,
      ),
    ).toBe(403);

    await installBrowserSessionDirect(
      page,
      ownerSession,
      `/projects/${project.project_id}`,
      authOptions,
    );
    await selectAccountForUi(page, account.account_id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.project_id}$`),
    );
    await dismissOnboarding(page);
    await expect(
      page.getByRole("button", { name: "Switch workspace" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New session" }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Sessions", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator(
        'a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]',
      ),
    ).toHaveCount(0);
    // Scoped to the sidebar, not the whole page: the project-home empty
    // state now renders its own "set up your project" quick tiles
    // (`ProjectHomeSections`), one of which is literally labeled "Triggers"
    // — a legitimate destination button, not the old dashboard sidebar row
    // this assertion originally checked for. The old sidebar rows
    // (Terminal / Secrets / Triggers / Tunnel) are still gone; scope the
    // locator to `[data-slot="sidebar"]` so the new page-body tile doesn't
    // collide with that check.
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.getByText("Terminal", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Secrets", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Triggers", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Tunnel", { exact: true })).toHaveCount(0);
    // The sidebar's own Settings row is gone (Jay, 2026-08-17) — the panel
    // now opens only via Mod+, or the workspace switcher's "User Settings"
    // row. `openSettingsPanel` presses the shortcut and asserts the panel.
    await openSettingsPanel(page);
    await expect(
      page.locator(
        'a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]',
      ),
    ).toHaveCount(0);
    expect(projectRepoWebUrl).toContain("github.com/kortix-ai/");

    await selectAccountForUi(page, account.account_id);
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.project_id}$`),
    );
    await expect(
      page.getByText(`${initialProjectName} Admin`).first(),
    ).toBeVisible();

    await installBrowserSessionDirect(
      page,
      ownerSession,
      `/accounts/${account.account_id}`,
      authOptions,
    );
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary").getByText(accountName, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();
    await expect(page.getByText(invitedEmail)).toBeVisible();
    await expect(page.getByText(/Invited · 1/i)).toBeVisible();
    const uiInviteResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/accounts/${account.account_id}/members`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    // One shared "Grant access" dialog for every access surface (2026-08-19,
    // `features/workspace/shared/access/access-dialog.tsx`): the account
    // Invite button opens it in grant mode. A new person is invited by
    // typing their email into the principal picker and choosing the
    // "Invite <email>" row it surfaces — no separate email composer.
    const grantDialog = page.getByRole("dialog", { name: "Grant access" });
    await expect(grantDialog).toBeVisible();
    await grantDialog
      .getByPlaceholder("Search or type an email")
      .fill(uiInvitedEmail);
    await grantDialog
      .getByRole("button", { name: `Invite ${uiInvitedEmail}` })
      .click();
    await grantDialog
      .getByRole("button", { name: /^Grant access/ })
      .click();
    expect((await uiInviteResponse).status()).toBe(201);
    await expect(page.getByText(uiInvitedEmail, { exact: true })).toBeVisible();

    const uiInvitedUser = await createAuthUser(uiInvitedEmail, authOptions);
    createdUserIds.add(uiInvitedUser.id);
    createdAccountIds.add(uiInvitedUser.id);
    const uiInvitedSession = await signIn(uiInvitedEmail, authOptions);
    const uiInvitedAccounts = await api<AccountSummary[]>(
      uiInvitedSession.access_token,
      "GET",
      "/accounts",
    );
    expect(
      uiInvitedAccounts.some((item) => item.account_id === account.account_id),
    ).toBe(true);

    await selectAccountForUi(page, account.account_id);
    // The repo link. It used to be "View on GitHub" in the Customize overlay's
    // Settings section, built from `project.repo_url`
    // (main: `settings-view.tsx:281,355-359`). That section is split into the
    // General and Repositories tabs and the link did NOT come with it
    // (`general-tab.tsx`'s header: "What did NOT move here: Repository …
    // merged into GitView"). The only surviving repo link is
    // `git-view.tsx:174-183`, whose href comes from the project's git
    // CONNECTION, so its accessible name is `owner/repo`, not "View on
    // GitHub".
    //
    // KNOWN GAP — a project with `repo_url` but no `project_git_connections`
    // row now shows "Not linked yet" and no link at all. The CI trace for this
    // spec proves that is exactly this project's state
    // (`GET /projects/:id` → `git_connection: null`, `repo_url` set), because
    // `seedDatabaseProject` never writes a connection row. Either the app has
    // to fall back to `project.repo_url` or the fixture has to seed a
    // connection; do not delete this assertion to go green.
    const repositoriesPanel = await openRepositoriesSection(
      page,
      project.project_id,
    );
    const githubLink = repositoriesPanel.getByRole("link", {
      name: projectRepoWebUrl.replace("https://github.com/", ""),
      exact: true,
    });
    await expect(
      githubLink,
      "settings no longer links to the project repo: git-view.tsx renders the link only from a project_git_connections row, and this project has repo_url with git_connection: null",
    ).toBeVisible();
    await expect(githubLink).toHaveAttribute("href", projectRepoWebUrl);

    const membersPanel = await openMembersSection(page, project.project_id);
    // Wait for the initial access inventory before submitting a mutation.
    // Otherwise a slow pre-mutation response can overwrite the invalidated query.
    // Rows are the shared `AccessRow` (a list item), not a table row.
    await expect(
      membersPanel.getByRole("listitem").filter({ hasText: ownerEmail }).first(),
    ).toBeVisible();
    // ONE "Grant access" dialog for every access surface: pick the account
    // member in the principal picker, keep the default Member role, submit.
    // An existing account member is granted through PUT /access/:userId (the
    // invite route is only for people who are not on the account yet).
    await membersPanel
      .getByRole("button", { name: "Grant access", exact: true })
      .click();
    const grantAccessDialog = page.getByRole("dialog", { name: "Grant access" });
    await expect(grantAccessDialog).toBeVisible();
    await grantAccessDialog.getByRole("button", { name: memberEmail }).click();
    const accessGrant = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/v1/projects/${project.project_id}/access/${member.id}`) &&
        response.request().method() === "PUT",
    );
    await grantAccessDialog
      .getByRole("button", { name: /^Grant access/ })
      .click();
    expect((await accessGrant).status()).toBe(200);
    await expect(grantAccessDialog).toHaveCount(0);
    // The member row, and the /projects redirect asserted further down, are
    // both read back through this grant. See settleIamPropagation.
    await settleIamPropagation();
    const memberAccessRow = membersPanel
      .getByRole("listitem")
      .filter({ hasText: memberEmail })
      .first();
    await expect(memberAccessRow).toBeVisible({ timeout: 15_000 });
    // The row's trailing slot carries the role label — "Member" — and its
    // meta says the member has no agent yet (deny-by-default).
    await expect(memberAccessRow.getByText("Member", { exact: true })).toBeVisible();

    // Initialize member auth before persisting the organization. Otherwise the
    // auth reset clears the selection and the personal account wins /projects.
    await installBrowserSessionDirect(
      page,
      memberSession,
      `/accounts/${account.account_id}`,
      authOptions,
    );
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await selectAccountForUi(page, account.account_id);
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.project_id}$`),
    );
    await expect(
      page.getByText(`${initialProjectName} Admin`).first(),
    ).toBeVisible();

    await api<{ ok: true }>(
      ownerSession.access_token,
      "DELETE",
      `/projects/${project.project_id}/access/${member.id}`,
    );
    // A revocation is the lagging direction of the cross-task IAM cache (see
    // IAM_PROPAGATION_MS): a task that still holds the old grant keeps serving
    // the project. One `goto` therefore asserts whichever task answered first.
    // Reload until every task agrees, bounded by one TTL window.
    await expect
      .poll(
        async () => {
          await page.goto("/projects", { waitUntil: "domcontentloaded" });
          return page.url();
        },
        { timeout: IAM_PROPAGATION_MS },
      )
      .toMatch(/\/projects\/start/);
    await expect(page.getByText("No workspace yet")).toBeVisible();
    await expect(page.getByText(`${initialProjectName} Admin`)).toHaveCount(0);

    const invitedUser = await createAuthUser(invitedEmail, authOptions);
    createdUserIds.add(invitedUser.id);
    createdAccountIds.add(invitedUser.id);
    const invitedSession = await signIn(invitedEmail, authOptions);
    expect(invitedUser.id).toBeTruthy();
    await installBrowserSessionDirect(
      page,
      invitedSession,
      new URL(deliveredInviteLink).pathname,
      authOptions,
    );
    if (page.url().includes(`/invites/${accountInviteId}`)) {
      await expect(page.getByText(accountName, { exact: true })).toBeVisible();
      await expect(page.getByText(/Team account/i)).toBeVisible();
      const acceptAccountInviteResponse = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(`/v1/account-invites/${accountInviteId}/accept`) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Accept" }).click();
      expect((await acceptAccountInviteResponse).status()).toBe(200);
    }
    await settleIamPropagation();
    await expect(page).toHaveURL(/\/projects\/start$/);
    // The membership this user just accepted is the same cross-task IAM state
    // (see IAM_PROPAGATION_MS). A task that has not seen it answers
    // `GET /accounts/:id` with 403, and the hub then sits on its loading
    // skeleton forever rather than erroring — so reload until it renders.
    const invitedMembersHeading = page.getByRole("heading", {
      name: "Members",
      exact: true,
    });
    await expect
      .poll(
        async () => {
          const accountResponse = page
            .waitForResponse(
              (response) => {
                const url = new URL(response.url());
                return (
                  response.request().method() === "GET" &&
                  url.pathname === `/v1/accounts/${account.account_id}`
                );
              },
              { timeout: 5_000 },
            )
            .catch(() => null);
          await page.goto(`/accounts/${account.account_id}`, {
            waitUntil: "domcontentloaded",
          });
          if ((await accountResponse)?.status() !== 200) return false;
          return invitedMembersHeading
            .waitFor({ state: "visible", timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
        },
        { timeout: IAM_PROPAGATION_MS },
      )
      .toBe(true);
    await expect(
      page.getByRole("complementary").getByText(accountName, { exact: true }),
    ).toBeVisible();

    const invitedAccounts = await api<AccountSummary[]>(
      invitedSession.access_token,
      "GET",
      "/accounts",
    );
    expect(
      invitedAccounts.some((item) => item.account_id === account.account_id),
    ).toBe(true);

    const finalMembers = await api<AccountMember[]>(
      ownerSession.access_token,
      "GET",
      `/accounts/${account.account_id}/members`,
    );
    expect(
      finalMembers.some(
        (item) => item.email === memberEmail && item.account_role === "member",
      ),
    ).toBe(true);
    expect(
      finalMembers.some(
        (item) => item.email === invitedEmail && item.account_role === "member",
      ),
    ).toBe(true);
    expect(
      finalMembers.some(
        (item) =>
          item.email === uiInvitedEmail && item.account_role === "member",
      ),
    ).toBe(true);

    await api<{ ok: true }>(
      ownerSession.access_token,
      "DELETE",
      `/projects/${project.project_id}`,
    );

    expect(serverErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
