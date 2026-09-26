import { describe, expect, test } from 'bun:test';

// A local `.env` points the app at a local web server. Links that send the
// user to a web page must ignore it: the page is on kortix.com.
process.env.EXPO_PUBLIC_FRONTEND_URL = 'http://localhost:3000';

const { KORTIX_WEB_URL } = await import('@/lib/kortix-web');
const { getWebBillingUrl, getWebContactSalesUrl, getWebCreditsExplainedUrl } = await import('./web-links');

describe('web links', () => {
  test('the web origin is kortix.com', () => {
    expect(KORTIX_WEB_URL).toBe('https://kortix.com');
  });

  test('every billing link opens kortix.com, never the local frontend', () => {
    expect(getWebBillingUrl()).toBe('https://kortix.com/settings/billing');
    expect(getWebContactSalesUrl()).toBe('https://kortix.com/contact');
  });

  test('credits explained opens the credits docs directly, not the old redirecting path', () => {
    expect(getWebCreditsExplainedUrl()).toBe('https://kortix.com/docs/credits');
  });
});
