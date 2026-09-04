import { expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eSubprojects123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface Subproject {
  slug: string;
  name: string;
  instructions: string | null;
  sessions: 'private' | 'shared';
}

interface SubprojectsResponse {
  subprojects: Subproject[];
}

/**
 * 27 — Subprojects (spec §12.7, `docs/specs/2026-09-03-subprojects.md`).
 *
 * Four browser-visible contracts, and nothing an API flow could assert on its
 * own (those live in `tests/src/flows/subprojects.flow.ts`):
 *
 *  1. The sidebar `+` creates a subproject and lands on its page.
 *  2. The page's three rail cards render.
 *  3. Editing the instructions PATCHes the subproject and the API agrees.
 *  4. A send in the page's composer carries `subproject` in the create body.
 *  5. A project member with no grant sees no sidebar entry and cannot open
 *     the page.
 *
 * **Why (4) asserts the request, not a session.** The deterministic local
 * profile has no sandbox provider, so `POST /projects/:id/sessions` cannot
 * produce a bootable session — the composer's send is observed at the wire
 * instead, which is exactly the contract this WP owns: the page's composer
 * files its session under the subproject. The server-side gate on that field
 * is `SUBP-2`'s job.
 *
 * The project comes from `createManifestProject` so its `kortix.yaml` is real
 * and writable: creating a subproject COMMITS to the repo, and a repo the API
 * cannot reach answers 502 rather than 201.
 */
test.describe('27 — Subprojects', () => {
  test('create from the sidebar, edit the instructions, and send into the subproject', async ({
    page,
  }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-subproject-owner-${runId}@example.test`;
    const owner = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);

    let accountId: string | null = null;
    let projectId: string | null = null;
    let project: ManifestProject | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded user owns no account');
      accountId = account.account_id;

      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId,
        userId: owner.id,
        name: `Subprojects UI ${runId}`,
        databaseUrl: databaseUrl!,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // ── 1. Create from the sidebar `+` ────────────────────────────────
      // The group renders for an owner even with nothing in it, because the
      // owner holds `project.customize.write` — that is the whole reason the
      // `+` is reachable before the first subproject exists.
      await expect(page.getByText('Subprojects', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'New subproject', exact: true }).click();

      const createModal = page.getByRole('dialog', { name: 'New subproject', exact: true });
      await expect(createModal).toBeVisible();
      // The two optional fields carry an "optional" suffix inside their label,
      // so the accessible name is "Description optional" — matched by prefix
      // rather than exactly, which would silently never resolve.
      await createModal.getByLabel(/^Name/).fill('Marketing');
      await createModal.getByLabel(/^Description/).fill('Campaign work for this run.');
      await createModal.getByRole('button', { name: 'Create subproject', exact: true }).click();

      // The API derives the slug from the name (`slugify`), so the route is
      // predictable and worth asserting: it is the grant key too.
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/subprojects/marketing$`), {
        timeout: 30_000,
      });

      // ── 2. The hero and the three rows under the composer ─────────────
      // The page is the project-home surface with the subproject's name in
      // the greeting; what it owns sits under the composer as disclosure
      // rows, each carrying a one-line summary while closed.
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Marketing');
      await expect(page.getByText('Campaign work for this run.')).toBeVisible();
      const instructionsRow = page.getByRole('button', { name: /^Instructions/ });
      await expect(instructionsRow).toBeVisible();
      await expect(page.getByRole('button', { name: /^Context/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Scheduled/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Context/ })).toContainText(
        'Files the agent reads first',
      );

      // The sidebar picked up the new row without a reload.
      await expect(
        page.locator(`a[href="/projects/${projectId}/subprojects/marketing"]`).first(),
      ).toBeVisible();

      // ── 3. Editing the instructions PATCHes ───────────────────────────
      const patchBodies: Record<string, unknown>[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'PATCH' &&
          request.url().endsWith(`/v1/projects/${projectId}/subprojects/marketing`)
        ) {
          try {
            patchBodies.push(JSON.parse(request.postData() ?? '{}'));
          } catch {
            patchBodies.push({});
          }
        }
      });

      const instructions = 'Always write in British English.';
      // The editor lives inside the Instructions row: open it first. Its
      // textarea carries `aria-label="Instructions"`; Save only exists while
      // the draft differs from what is saved.
      await instructionsRow.click();
      await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill(instructions);
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect.poll(() => patchBodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(patchBodies[0]).toEqual({ instructions });

      // The API is the source of truth for persistence, not the re-render.
      await expect
        .poll(
          async () => {
            const listing = await api<SubprojectsResponse>(
              session.access_token,
              'GET',
              `/projects/${projectId}/subprojects`,
            );
            return listing.subprojects.find((s) => s.slug === 'marketing')?.instructions ?? null;
          },
          { timeout: 20_000 },
        )
        .toBe(instructions);

      // ── 4. A send carries `subproject` in the create body ─────────────
      // Session CREATE cannot boot in the local profile (no sandbox provider),
      // so the assertion is the outgoing request — the page's own contract.
      const createBodies: Record<string, unknown>[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          request.url().endsWith(`/v1/projects/${projectId}/sessions`)
        ) {
          try {
            createBodies.push(JSON.parse(request.postData() ?? '{}'));
          } catch {
            createBodies.push({});
          }
        }
      });

      // The real composer — `ProjectHome` mounts `ComposerChatInput`, whose
      // editor is `role="textbox" aria-label="Message input"`
      // (`composer/editor/composer-editor.tsx`). Same control spec 13 drives.
      const composer = page.getByRole('textbox', { name: 'Message input' });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill('Draft the launch note.');

      // The composer refuses to send until a model is connected
      // (`features/session/model-connection-gate.tsx`). The deterministic local
      // profile has no LLM provider, so the gate is up there and no request can
      // leave the page — measured 2026-09-04: send disabled, "No model
      // connected" shown, 0 POSTs in 30s. On a stack with a provider (preview,
      // dev) the gate is down and the create body is the assertion. Both
      // branches prove the page mounts the REAL composer; only the second can
      // prove the body, so the profile it ran in is recorded on the test.
      const modelGate = page.getByText('No model connected', { exact: false });
      if (await modelGate.isVisible().catch(() => false)) {
        test.info().annotations.push({
          type: 'profile',
          description: 'no LLM provider: composer send gated, create body not asserted here',
        });
        await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
      } else {
        await page.getByRole('button', { name: 'Send message' }).click({ force: true });
        await expect.poll(() => createBodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
        const [createBody] = createBodies;
        expect(createBody?.subproject).toBe('marketing');
        // The prompt rides the create as a durable inbox row, so it is on the
        // same body — proving the composer wiring is the shared one, not a copy.
        expect(createBody?.pending_prompt).toMatchObject({ text: 'Draft the launch note.' });
      }

      expect(pageErrors).toEqual([]);
    } finally {
      if (project) await project.dispose().catch(() => {});
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
    }
  });

  test('a project member with no grant sees no subproject in the sidebar', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-subproject-owner2-${runId}@example.test`;
    const memberEmail = `e2e-subproject-member-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const member = await createAuthUser(memberEmail, authOptions);
    const ownerSession = await signIn(ownerEmail, authOptions);

    let accountId: string | null = null;
    let projectId: string | null = null;
    let project: ManifestProject | null = null;

    try {
      const accounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded user owns no account');
      accountId = account.account_id;

      await api(
        ownerSession.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: memberEmail, role: 'member' },
        201,
      );

      project = await createManifestProject({
        api,
        accessToken: ownerSession.access_token,
        accountId,
        userId: owner.id,
        name: `Subprojects authz ${runId}`,
        databaseUrl: databaseUrl!,
      });
      projectId = project.id;

      // Declared by the owner, granted to nobody. `object_policies.subproject`
      // is `closed`, so the member's accessible set is empty — the manager
      // tier sees it, the member tier does not.
      await api<Subproject>(
        ownerSession.access_token,
        'POST',
        `/projects/${projectId}/subprojects`,
        { name: 'Marketing' },
        201,
      );
      // Project access, and only project access. This is the whole point: a
      // member who can open the project still sees no subproject.
      await api(ownerSession.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, {
        role: 'member',
      });

      const memberSession = await signIn(memberEmail, authOptions);
      await installBrowserSessionDirect(page, memberSession, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // Wait for the sidebar to have painted SOMETHING of its own, so the
      // absence below is an answered question rather than an unmounted panel.
      await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator(`a[href="/projects/${projectId}/subprojects/marketing"]`),
      ).toHaveCount(0);
      // No group header, and no way to make one: the member holds neither a
      // grant nor `project.customize.write`.
      await expect(page.getByText('Subprojects', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New subproject', exact: true })).toHaveCount(
        0,
      );

      // The page itself is a 404 for them, rendered as the not-found state
      // rather than a blank screen.
      await page.goto(`/projects/${projectId}/subprojects/marketing`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByText('No subproject named marketing')).toBeVisible({
        timeout: 30_000,
      });

      // The API tells the same story, so the browser is not the only witness.
      const listing = await api<SubprojectsResponse>(
        memberSession.access_token,
        'GET',
        `/projects/${projectId}/subprojects`,
      );
      expect(listing.subprojects).toEqual([]);
    } finally {
      if (project) await project.dispose().catch(() => {});
      await deleteAuthUser(member.id, authOptions).catch(() => {});
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
    }
  });
});
