import { type Locator, type Page, expect } from "@playwright/test";

/**
 * The two configuration panels. They are ONE component
 * (`settings-panel.tsx`) showing two different sets of rows:
 *
 *   Customize — what the agent is and what it can do (Agents, Skills, Models,
 *               Connectors, Apps, Channels, Schedules, Webhooks, Secrets,
 *               Sandbox templates, Snapshots, Marketplace).
 *   Settings  — administration (Profile, Members, Repositories, Billing,
 *               Roles, Audit log, API keys, Experimental, Upgrades).
 *
 * Which panel owns a row is `TAB_SURFACE` in
 * `apps/web/src/features/workspace/settings/settings-tabs.ts`. A spec that
 * opens the wrong one finds no rail row at all, so pick by that table.
 *
 * The accessible name comes from `ModalTitle`: `<Panel> — <project name>` when
 * a project is in scope, plain `<Panel>` otherwise. Matching the prefix pins
 * the panel without pinning the project name a spec would have to spell out.
 */
export function settingsPanel(page: Page): Locator {
  return page.getByRole("dialog", { name: /^Settings\b/ });
}

export function customizePanel(page: Page): Locator {
  return page.getByRole("dialog", { name: /^Customize\b/ });
}

/**
 * Opens the settings panel from the sidebar's Settings row and returns it.
 *
 * The sidebar button's accessible name is "Settings" plus its `Ctrl ,` hint,
 * so the name is matched as a prefix.
 */
export async function openSettingsPanel(page: Page): Promise<Locator> {
  const trigger = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: /^Settings/ })
    .first();
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  const panel = settingsPanel(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * Opens the Customize panel from the sidebar's Customize row and returns it.
 */
export async function openCustomizePanel(page: Page): Promise<Locator> {
  const trigger = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: /^Customize/ })
    .first();
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  const panel = customizePanel(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * Opens Customize and selects one rail row, returning the panel. Same
 * mechanics as `openSettingsTab` — one shell, two rails.
 */
export async function openCustomizeTab(page: Page, label: string): Promise<Locator> {
  const panel = await openCustomizePanel(page);
  await panel.getByRole("tab", { name: label, exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: label })).toBeVisible({
    timeout: 30_000,
  });
  return panel;
}

/**
 * Opens the panel and selects one rail row, returning the panel.
 *
 * The rail rows are Radix `TabsTrigger`s (`settings-panel.tsx:526`), so their
 * ARIA role is `tab` — NOT `button`, which is what the pre-unification specs
 * clicked. Their labels are single-sourced in
 * `apps/web/src/features/workspace/settings/rail.ts`.
 *
 * `label` must be unique across the rail. "General" is not: the Workspace
 * group and the Organization group each have one.
 */
export async function openSettingsTab(page: Page, label: string): Promise<Locator> {
  const panel = await openSettingsPanel(page);
  await panel.getByRole("tab", { name: label, exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: label })).toBeVisible({
    timeout: 30_000,
  });
  return panel;
}

/**
 * One feature-flag row of the Experimental tab.
 *
 * `ExperimentalFeatureRow` (`tabs/experimental-tab.tsx`) renders a plain `div`
 * per flag inside the `divide-y` list container, and — unlike the
 * `feature-flags-view.tsx` it replaced — puts NO `aria-label` on the row's
 * `Switch`. So the row is pinned by the flag name it displays and the switch
 * is read out of that row. Restore `aria-label={feature.name}` on that Switch
 * and `row.getByRole("switch")` keeps working unchanged.
 */
export function featureFlagRow(panel: Locator, page: Page, name: string): Locator {
  return panel
    .locator("div.divide-y > div")
    .filter({ has: page.getByText(name, { exact: true }) });
}

export async function selectAccountForUi(
  page: Page,
  accountId: string,
): Promise<void> {
  await page.evaluate((id) => {
    localStorage.setItem(
      "kortix.currentAccount",
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}

export async function dismissOnboarding(page: Page): Promise<void> {
  const onboarding = page
    .getByRole("dialog")
    .filter({
      has: page.getByRole("progressbar", { name: "Setup progress" }),
    })
    .last();
  let absentSince = 0;
  for (let step = 0; step < 24; step += 1) {
    if (!(await onboarding.isVisible().catch(() => false))) {
      if (absentSince === 0) absentSince = Date.now();
      if (Date.now() - absentSince >= 1_000) return;
      await page.waitForTimeout(100);
      continue;
    }
    absentSince = 0;
    const skip = onboarding
      .getByRole("button", { name: /^(Skip|Skip survey|Not now|Maybe later)/i })
      .last();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 2_000 }).catch(() => {});
    } else {
      const defer = onboarding.getByRole("radio", {
        name: /^(Decide later|Keep what I have)/i,
      });
      if (await defer.isVisible().catch(() => false)) {
        await defer.click({ timeout: 2_000 }).catch(() => {});
      }
      const primary = onboarding
        .getByRole("button", {
          name: /^(Continue|Done|Open project|Start building|Get started)$/i,
        })
        .last();
      if (await primary.isEnabled().catch(() => false)) {
        await primary.click({ timeout: 2_000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(100);
  }
  await expect(onboarding).toHaveCount(0);
}
