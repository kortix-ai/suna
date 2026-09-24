import { type Locator, type Page, expect, test } from '@playwright/test';

/**
 * A setup link while its turn streams.
 *
 * An agent answers "connect Outlook" with `[Connect Outlook](https://…/connect/
 * ksl_…)` and the token alone is several hundred characters. Before these
 * fixes the reader watched, in order: `Connect Outlook [blocked]`; a raw
 * `[Connect Outlook](` beside a card built from a partial token; the finished
 * card collapsed into an inline box (an empty sliver, the icon centred on its
 * own row, a second sliver) for as long as the turn kept working; and at the
 * end of the turn, an open connect modal closed because the message remounted.
 *
 * Every one of those is layout, mounting, or CSS, so only a browser shows it.
 * The deterministic stack has no sandbox that can stream a real turn, so this
 * drives `/debug/stream`, which replays a message through the transcript's own
 * path (`ThrottledMarkdown` → `UnifiedMarkdown` → Streamdown, in the transcript
 * column) and freezes any character position. It needs no API or sandbox, so
 * it runs unchanged against the local stack, previews, and staging.
 */

const SCENARIO = 'scenario=setup-link';

async function openReplay(page: Page, query: string): Promise<Locator> {
  await page.goto(`/debug/stream?${SCENARIO}&${query}`, { waitUntil: 'domcontentloaded' });
  const replay = page.getByTestId('stream-replay');
  // The harness renders on the client only; the position counter means it ran.
  await expect(page.getByTestId('stream-position')).toBeVisible({ timeout: 120_000 });
  return replay;
}

const until = (text: string) => `until=${encodeURIComponent(text)}`;
const cardIn = (replay: Locator) => replay.getByTestId('outcome-card-external');
const markdownIn = (replay: Locator) => replay.locator('.kortix-markdown');

async function layoutOf(root: Locator): Promise<string> {
  return root.evaluate((el) => {
    const origin = el.getBoundingClientRect();
    return [...el.querySelectorAll('*')]
      .map((node) => {
        const r = node.getBoundingClientRect();
        return [node.tagName, r.left - origin.left, r.top - origin.top, r.width, r.height]
          .map((v) => (typeof v === 'number' ? Math.round(v) : v))
          .join(':');
      })
      .join('|');
  });
}

test.describe('32 — A setup link while its turn streams', () => {
  test('the finished link is one intact card while the turn is still working', async ({ page }) => {
    const replay = await openReplay(page, 'at=end&working=1');
    await expect(markdownIn(replay)).toHaveAttribute('data-streaming', 'true');

    const card = cardIn(replay);
    await expect(card).toBeVisible();
    // The regression rendered this row `display: inline`, split into five
    // fragments around its block children.
    expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('flex');
    expect(await card.evaluate((el) => el.getClientRects().length)).toBe(1);
    await expect(card).toContainText('Connect Outlook');
    await expect(card).toContainText('Waiting for you');
    await expect(card.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  });

  test('a card that shares a paragraph with the line above it sits below that line, whole', async ({
    page,
  }) => {
    // The shape agents actually write: a bold line, one newline, then the
    // link — so the card is a block inside inline content. The regression put
    // each card's first sliver beside the bold line and dropped the marker
    // from the list still streaming underneath.
    await page.goto('/debug/stream?scenario=setup-links-under-headings&at=end&working=1', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('stream-position')).toBeVisible({ timeout: 120_000 });
    const replay = page.getByTestId('stream-replay');
    await expect(markdownIn(replay)).toHaveAttribute('data-streaming', 'true');

    const cards = cardIn(replay);
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      const layout = await card.evaluate((el) => {
        const heading = el.parentElement?.querySelector('strong')?.getBoundingClientRect();
        return {
          display: getComputedStyle(el).display,
          fragments: el.getClientRects().length,
          belowHeading: heading ? el.getBoundingClientRect().top >= heading.bottom - 1 : false,
        };
      });
      expect(layout).toEqual({ display: 'flex', fragments: 1, belowHeading: true });
    }

    const lastItem = replay.locator('li').last();
    expect(await lastItem.evaluate((el) => getComputedStyle(el).display)).toBe('list-item');
  });

  test('while the URL streams: the label as text, then the card it will become', async ({
    page,
  }) => {
    const setupRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/setup-links/')) setupRequests.push(request.url());
    });

    // The label is still arriving. remend closes it for display; the reader
    // sees the words, never Streamdown's placeholder or a blocked marker.
    let replay = await openReplay(page, until('[Connect Out'));
    await expect(replay).toContainText('Connect Out');
    await expect(replay).not.toContainText('[blocked]');
    await expect(replay).not.toContainText('](');
    await expect(replay.locator('a')).toHaveCount(0);

    // The URL is arriving but its route is not known yet: still just the label.
    replay = await openReplay(page, until('/co'));
    await expect(replay).toContainText('Connect Outlook');
    await expect(replay).not.toContainText('](');
    await expect(replay.locator('a')).toHaveCount(0);
    await expect(cardIn(replay)).toHaveCount(0);

    // The route names a setup link and the token is arriving: the pending card.
    replay = await openReplay(page, until('/connect/ksl_'));
    const pending = cardIn(replay);
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(pending).toContainText('Connect Outlook');
    await expect(pending).toContainText('Preparing link…');
    await expect(replay).not.toContainText('](');
    await expect(replay).not.toContainText('ksl_');
    const pendingButton = pending.getByRole('button', { name: 'Connect', exact: true });
    await expect(pendingButton).toBeDisabled();
    await pendingButton.click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const pendingBox = await pending.boundingBox();

    // The link closed: the same card, live, in the same footprint.
    replay = await openReplay(page, until(')'));
    const live = cardIn(replay);
    await expect(live).not.toHaveAttribute('aria-busy', 'true');
    await expect(live).toContainText('Waiting for you');
    await expect(live.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    const liveBox = await live.boundingBox();
    if (!pendingBox || !liveBox) throw new Error('a setup card rendered without a layout box');
    expect(Math.round(liveBox.width)).toBe(Math.round(pendingBox.width));
    expect(Math.round(liveBox.height)).toBe(Math.round(pendingBox.height));

    // Nothing above ever asked the API about a partial token.
    expect(setupRequests).toEqual([]);
  });

  test('an open connect modal survives the end of the turn and asks for the whole token', async ({
    page,
  }) => {
    const replay = await openReplay(page, 'at=end&working=1');
    const card = cardIn(replay);
    const outcomeId = (await card.getAttribute('data-outcome-id')) ?? '';
    expect(outcomeId).toMatch(/^setup:ksl_/);
    const token = outcomeId.slice('setup:'.length);

    const lookup = page.waitForRequest((request) =>
      request.url().includes('/setup-links/connectors/'),
    );
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    const lookupPath = new URL((await lookup).url()).pathname;
    expect(
      lookupPath.endsWith(`/setup-links/connectors/${encodeURIComponent(token)}`),
      lookupPath,
    ).toBe(true);
    await expect(page.getByRole('dialog')).toBeVisible();

    // A mark on the card's DOM node survives only if React keeps the node.
    await card.evaluate((el) => el.setAttribute('data-journey-mark', 'kept'));
    const before = await layoutOf(markdownIn(replay));

    // The turn ends on its own in a real session; no pointer is involved. The
    // open modal overlays the harness controls and hides them from the
    // accessibility tree, so dispatch the click straight to the toggle.
    await page.locator('button', { hasText: 'Turn: working' }).dispatchEvent('click');
    await expect(markdownIn(replay)).toHaveAttribute('data-streaming', 'false');

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(card).toHaveAttribute('data-journey-mark', 'kept');
    // Settling moves nothing: the streaming layout was already the final one.
    expect(await layoutOf(markdownIn(replay))).toBe(before);
  });
});
