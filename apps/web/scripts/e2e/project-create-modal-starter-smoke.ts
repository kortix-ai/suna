#!/usr/bin/env bun
import { chromium, type Page } from 'playwright';

type ProvisionPayload = {
  account_id: string;
  name: string;
  seed_starter: boolean;
  starter_template: 'minimal' | 'general-knowledge-worker';
  marketplace_items?: string[];
};

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3300';

const DEFAULT_ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const TEAM_ACCOUNT_ID = '00000000-0000-4000-a000-000000000202';

const ACCOUNTS = [
  {
    account_id: DEFAULT_ACCOUNT_ID,
    name: 'Personal',
    slug: 'personal',
    account_role: 'owner',
    is_primary_owner: true,
  },
  {
    account_id: TEAM_ACCOUNT_ID,
    name: 'Acme Team',
    slug: 'acme-team',
    account_role: 'admin',
    is_primary_owner: false,
  },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function mockAccounts(page: Page) {
  await page.route(/\/accounts$/, async (route) => {
    assert(
      route.request().headers().authorization === 'Bearer debug-project-create-token',
      'accounts request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ACCOUNTS),
    });
  });
}

async function openHarness(page: Page) {
  await page.route('**/marketplace/items**', async (route) => {
    assert(
      route.request().headers().authorization === 'Bearer debug-project-create-token',
      'marketplace request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        loading: false,
        pending: 0,
        sources: [],
        items: [
          defaultMarketplaceItem('deep-research', 'Deep Research', 10),
          defaultMarketplaceItem('research-report', 'Research Report', 20),
          defaultMarketplaceItem('document-review', 'Document Review', 30),
          defaultMarketplaceItem('pdf', 'PDF', 40),
          defaultMarketplaceItem('docx', 'DOCX', 50),
          defaultMarketplaceItem('xlsx', 'XLSX', 60),
          defaultMarketplaceItem('presentations', 'Presentations', 70),
          defaultMarketplaceItem('website-building', 'Website Building', 80),
          defaultMarketplaceItem('agent-browser', 'Agent Browser', 90),
        ],
      }),
    });
  });
  await page.goto(`${baseUrl}/debug/project-create-modal`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: /new project/i }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('checkbox', { name: /starter pack/i }).waitFor({ state: 'visible', timeout: 30_000 });
}

function defaultMarketplaceItem(name: string, title: string, order: number) {
  return {
    id: `kortix-starter:${name}`,
    registry: 'kortix-starter',
    name,
    type: 'registry:skill',
    title,
    description: `${title} default marketplace item`,
    categories: ['kortix-runtime'],
    capabilities: { secrets: [], connectors: [], tools: [name], network: [] },
    dependencies: [],
    fileCount: 1,
    external: false,
    marketplaceId: 'kortix',
    marketplaceLabel: 'Kortix',
    defaultProjectInstall: true,
    defaultProjectInstallOrder: order,
  };
}

async function submitProjectCreate(
  page: Page,
  name: string,
  toggleStarterSkills: boolean,
): Promise<ProvisionPayload> {
  let payload: ProvisionPayload | null = null;
  await page.route('**/projects/provision', async (route) => {
    payload = JSON.parse(route.request().postData() || '{}') as ProvisionPayload;
    assert(
      route.request().headers().authorization === 'Bearer debug-project-create-token',
      'provision request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: `proj_${name}`,
        account_id: payload.account_id,
        name: payload.name,
        repo_url: 'https://github.com/kortix-managed/test.git',
        default_branch: 'main',
        manifest_path: 'kortix.yaml',
        status: 'active',
        metadata: {},
        last_opened_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
    });
  });

  await page.getByRole('textbox', { name: /project name/i }).fill(name);
  if (toggleStarterSkills) {
    const starterPack = page.getByRole('checkbox', { name: /starter pack/i });
    if (await starterPack.isVisible().catch(() => false)) {
      await starterPack.click();
    } else {
      await page.locator('[role="checkbox"]').first().click();
    }
  }
  const request = page.waitForRequest((req) => req.url().includes('/projects/provision'));
  await page.getByRole('button', { name: /^create project$/i }).click();
  await request;
  const projectPath = `/projects/proj_${name}`;
  await page.waitForURL(
    (url) =>
      url.pathname === projectPath ||
      (url.pathname === '/auth' && url.searchParams.get('redirect') === projectPath),
    { timeout: 10_000 },
  );
  await page.unroute('**/projects/provision');
  assert(payload, 'expected a /projects/provision request payload');
  return payload;
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    await openHarness(page);
    const defaultPayload = await submitProjectCreate(page, 'default-minimal', false);
    assert(defaultPayload.account_id === '00000000-0000-4000-a000-000000000101', 'default payload account_id mismatch');
    assert(defaultPayload.name === 'default-minimal', 'default payload name mismatch');
    assert(defaultPayload.seed_starter === true, 'default payload should seed starter');
    assert(defaultPayload.starter_template === 'minimal', 'default payload should use minimal starter_template');
    assert(
      JSON.stringify(defaultPayload.marketplace_items) === JSON.stringify([
        'kortix-starter:deep-research',
        'kortix-starter:research-report',
        'kortix-starter:document-review',
        'kortix-starter:pdf',
        'kortix-starter:docx',
        'kortix-starter:xlsx',
        'kortix-starter:presentations',
        'kortix-starter:website-building',
        'kortix-starter:agent-browser',
      ]),
      'default payload should include registry-driven marketplace defaults',
    );

    await openHarness(page);
    const optOutPayload = await submitProjectCreate(page, 'without-starter-pack', true);
    assert(optOutPayload.account_id === '00000000-0000-4000-a000-000000000101', 'opt-out payload account_id mismatch');
    assert(optOutPayload.name === 'without-starter-pack', 'opt-out payload name mismatch');
    assert(optOutPayload.seed_starter === true, 'opt-out payload should seed starter');
    assert(optOutPayload.starter_template === 'minimal', 'opt-out payload should still use minimal starter_template');
    assert(JSON.stringify(optOutPayload.marketplace_items) === JSON.stringify([]), 'opt-out payload should omit starter pack skills');

    await mockAccounts(page);
    await openHarness(page);
    const accountField = page.getByTestId('project-create-account');
    await accountField.waitFor({ state: 'visible', timeout: 30_000 });
    assert(
      (await accountField.textContent())?.includes('Personal'),
      'account field should show the default account before switching',
    );
    const defaultAccountPayload = await submitProjectCreate(page, 'default-account-visible', false);
    assert(
      defaultAccountPayload.account_id === DEFAULT_ACCOUNT_ID,
      'payload should target the displayed default account',
    );

    await openHarness(page);
    await page.getByRole('button', { name: /personal/i }).click();
    await page.getByRole('menuitem', { name: /acme team/i }).click();
    assert(
      (await page.getByTestId('project-create-account').textContent())?.includes('Acme Team'),
      'account field should show the switched account',
    );
    const switchedPayload = await submitProjectCreate(page, 'switched-account', false);
    assert(
      switchedPayload.account_id === TEAM_ACCOUNT_ID,
      'payload should target the account picked in the modal',
    );

    console.log('[project-create-modal] ok: starter template, marketplace item, and account picker payloads verified');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
