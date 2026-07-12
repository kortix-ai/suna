#!/usr/bin/env bun
import { chromium, type Page } from 'playwright';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3300';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function marketplaceItem(name: string, title: string) {
  return {
    id: `kortix-starter:${name}`,
    registry: 'kortix-starter',
    name,
    type: 'registry:skill',
    title,
    description: `${title} marketplace item`,
    categories: ['kortix'],
    capabilities: { secrets: [], connectors: [], tools: [name], network: [] },
    dependencies: [],
    fileCount: 1,
    external: false,
    marketplaceId: 'kortix',
    marketplaceLabel: 'Kortix',
    owner: 'kortix-ai',
    sourceUrl: 'https://github.com/kortix-ai/marketplace',
  };
}

async function installRoutes(page: Page) {
  const items = [
    marketplaceItem('pdf', 'PDF'),
    marketplaceItem('deep-research', 'Deep Research'),
    marketplaceItem('research-report', 'Research Report'),
    marketplaceItem('website-building', 'Website Building'),
    marketplaceItem('docx', 'DOCX'),
    marketplaceItem('xlsx', 'XLSX'),
  ];

  await page.route('**/marketplace/marketplaces', async (route) => {
    assert(
      route.request().headers().authorization === 'Bearer debug-marketplace-token',
      'marketplaces request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        loading: false,
        pending: 0,
        sources: [],
        marketplaces: [
          {
            id: 'kortix',
            label: 'Kortix',
            owner: 'kortix-ai',
            count: items.length,
            types: { 'registry:skill': items.length },
            external: false,
            sourceUrl: 'https://github.com/kortix-ai/marketplace',
          },
        ],
      }),
    });
  });

  await page.route('**/marketplace/sources', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sources: [] }),
    });
  });

  await page.route('**/marketplace/items**', async (route) => {
    assert(
      route.request().headers().authorization === 'Bearer debug-marketplace-token',
      'items request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ loading: false, pending: 0, sources: [], items }),
    });
  });

  await page.route('**/projects/debug-marketplace-project/registry/updates', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        updates: [{ name: 'pdf', type: 'registry:skill', status: 'update-available', changed: 1 }],
        update_available: ['pdf'],
      }),
    });
  });

  await page.route(
    '**/projects/debug-marketplace-project/marketplace/update-all',
    async (route) => {
      updateAllCalls += 1;
      assert(route.request().method() === 'POST', 'update-all should use POST');
      assert(
        route.request().headers().authorization === 'Bearer debug-marketplace-token',
        'update-all request should include the debug bootstrap auth token',
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          updated: ['pdf'],
          commit_sha: 'abc12345',
          branch: 'main',
          file_count: 2,
          installed: [{ name: 'pdf', type: 'registry:skill' }],
        }),
      });
    },
  );

  await page.route('**/projects/debug-marketplace-project/registry', async (route) => {
    assert(
      route.request().headers().authorization === 'Bearer debug-marketplace-token',
      'installed request should include the debug bootstrap auth token',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        installed: [
          {
            name: 'pdf',
            type: 'registry:skill',
            source: 'kortix',
            installed_at: '2026-01-01T00:00:00.000Z',
            file_count: 1,
          },
        ],
      }),
    });
  });

  return {
    updateAllCalls: () => updateAllCalls,
  };
}

async function avatarStyle(page: Page, sectionTestId: string, name: string) {
  const tile = page
    .getByTestId(sectionTestId)
    .locator(`[data-marketplace-avatar-name="${name}"] > span`)
    .first();
  await tile.waitFor({ state: 'visible', timeout: 30_000 });
  return tile.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      svg: el.querySelector('svg')?.outerHTML ?? '',
    };
  });
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const routes = await installRoutes(page);
    await page.goto(`${baseUrl}/debug/marketplace`, { waitUntil: 'domcontentloaded' });

    const grid = page.getByTestId('marketplace-explore').locator('[data-marketplace-grid]').first();
    await grid.waitFor({ state: 'visible', timeout: 30_000 });
    const columnCount = await grid.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    assert(columnCount === 3, `expected marketplace grid to render 3 columns, got ${columnCount}`);

    const exploreAvatar = await avatarStyle(page, 'marketplace-explore', 'pdf');
    const installedAvatar = await avatarStyle(page, 'marketplace-installed', 'pdf');
    assert(
      exploreAvatar.backgroundColor === installedAvatar.backgroundColor,
      'installed avatar background should match Explore',
    );
    assert(
      exploreAvatar.color === installedAvatar.color,
      'installed avatar color should match Explore',
    );
    assert(exploreAvatar.svg === installedAvatar.svg, 'installed avatar icon should match Explore');

    await page.getByRole('button', { name: /^update all$/i }).click();
    assert(
      routes.updateAllCalls() === 1,
      'Update all should call the batch update endpoint exactly once',
    );

    console.log('[marketplace-render] ok: 3-column grid, avatar parity, and update-all verified');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
let updateAllCalls = 0;
