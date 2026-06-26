#!/usr/bin/env bun
import { chromium, type Page } from 'playwright';

type ProvisionPayload = {
  account_id: string;
  name: string;
  seed_starter: boolean;
  starter_template: 'minimal' | 'general-knowledge-worker';
};

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3300';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openHarness(page: Page) {
  await page.goto(`${baseUrl}/debug/project-create-modal`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: /new project/i }).waitFor({ state: 'visible', timeout: 30_000 });
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
        manifest_path: 'kortix.toml',
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
    const namedSwitch = page.getByRole('switch', { name: /starter skills/i });
    if (await namedSwitch.isVisible().catch(() => false)) {
      await namedSwitch.click();
    } else {
      await page.locator('[role="switch"]').first().click();
    }
  }

  const request = page.waitForRequest((req) => req.url().includes('/projects/provision'));
  await page.getByRole('button', { name: /^create project$/i }).click();
  await request;
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

    await openHarness(page);
    const optInPayload = await submitProjectCreate(page, 'with-starter-skills', true);
    assert(optInPayload.account_id === '00000000-0000-4000-a000-000000000101', 'opt-in payload account_id mismatch');
    assert(optInPayload.name === 'with-starter-skills', 'opt-in payload name mismatch');
    assert(optInPayload.seed_starter === true, 'opt-in payload should seed starter');
    assert(
      optInPayload.starter_template === 'general-knowledge-worker',
      'opt-in payload should use general-knowledge-worker starter_template',
    );

    console.log('[project-create-modal] ok: default minimal and explicit GKW opt-in payloads verified');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
