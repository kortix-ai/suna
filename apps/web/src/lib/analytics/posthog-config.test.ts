/**
 * What may leave the browser for PostHog: which hosts report, how the cookie
 * banner's answer is read, and how URLs and autocapture events are reduced on
 * pages that carry customer data or one-time tokens.
 */
import { describe, expect, test } from 'bun:test';

import {
  POSTHOG_PROJECT_KEY,
  posthogProjectForHost,
  readAnalyticsConsent,
  routeTemplate,
  sanitizeUrl,
  scrubEvent,
} from './posthog-config';

const ORIGIN = 'https://kortix.com';

describe('posthogProjectForHost', () => {
  test('only kortix.com reports, as production', () => {
    expect(posthogProjectForHost('kortix.com', undefined)).toEqual({
      key: POSTHOG_PROJECT_KEY,
      environment: 'production',
    });
    expect(posthogProjectForHost('www.kortix.com', undefined)?.environment).toBe('production');
  });

  test('dev and staging never report', () => {
    expect(posthogProjectForHost('dev.kortix.com', undefined)).toBeNull();
    expect(posthogProjectForHost('staging.kortix.com', undefined)).toBeNull();
    expect(posthogProjectForHost('dev.kortix.com', 'phc_local')).toBeNull();
  });

  test('a self-hosted or preview host never reports, even with the local key set', () => {
    expect(posthogProjectForHost('kortix.acme-corp.internal', 'phc_local')).toBeNull();
    expect(posthogProjectForHost('pr-123.preview.kortix.dev', 'phc_local')).toBeNull();
    expect(posthogProjectForHost('evil-kortix.com', undefined)).toBeNull();
  });

  test('localhost reports only with an explicit local key', () => {
    expect(posthogProjectForHost('localhost', undefined)).toBeNull();
    expect(posthogProjectForHost('localhost', 'not-a-key')).toBeNull();
    expect(posthogProjectForHost('localhost', 'phc_local')).toEqual({
      key: 'phc_local',
      environment: 'local',
    });
  });
});

describe('readAnalyticsConsent', () => {
  const cookie = (value: string) =>
    `sb-x=1; cookieyes-consent=${encodeURIComponent(value)}; other=2`;

  test('no banner cookie is unknown', () => {
    expect(readAnalyticsConsent('sb-x=1')).toBe('unknown');
  });

  test('an accepted analytics category is granted', () => {
    expect(
      readAnalyticsConsent(
        cookie('consentid:abc,consent:yes,action:yes,necessary:yes,analytics:yes'),
      ),
    ).toBe('granted');
  });

  test('a rejection after an answer is denied', () => {
    expect(
      readAnalyticsConsent(
        cookie('consentid:abc,consent:no,action:yes,necessary:yes,analytics:no'),
      ),
    ).toBe('denied');
  });

  test('no answer yet in an opt-in region is unknown', () => {
    expect(readAnalyticsConsent(cookie('consentid:abc,consent:no,action:no,analytics:no'))).toBe(
      'unknown',
    );
  });

  test('a malformed cookie is unknown', () => {
    expect(readAnalyticsConsent('cookieyes-consent=%E0%A4%A')).toBe('unknown');
  });
});

describe('URL reduction', () => {
  test('private paths become route templates, locale prefix removed', () => {
    expect(routeTemplate('/de/workspaces/9f1c/sessions/4a2b')).toBe('/workspaces/:id/sessions/:id');
    expect(routeTemplate('/workspaces/9f1c/customize/agents/acme-sales-bot')).toBe(
      '/workspaces/:id/customize/agents/:id',
    );
    expect(routeTemplate('/settings/billing')).toBe('/settings/billing');
  });

  test('a capability token never survives', () => {
    expect(sanitizeUrl('https://kortix.com/share/session/tok_secret123', ORIGIN)).toBe(
      'https://kortix.com/share/session/:id',
    );
    expect(sanitizeUrl('/secret-intake/abc.def', ORIGIN)).toBe(
      'https://kortix.com/secret-intake/:id',
    );
  });

  test('only campaign parameters survive the query, and never the hash', () => {
    expect(
      sanitizeUrl(
        'https://kortix.com/auth?email=a%40b.com&returnUrl=%2Fworkspaces%2Fx&utm_source=youtube&gclid=g1#token',
        ORIGIN,
      ),
    ).toBe('https://kortix.com/auth?utm_source=youtube&gclid=g1');
  });

  test('public marketing paths keep their real path', () => {
    expect(sanitizeUrl('https://kortix.com/blog/launch-week?utm_campaign=v1', ORIGIN)).toBe(
      'https://kortix.com/blog/launch-week?utm_campaign=v1',
    );
  });

  test('another origin keeps origin and path only', () => {
    expect(sanitizeUrl('https://www.google.com/search?q=private+words', ORIGIN)).toBe(
      'https://www.google.com/search',
    );
  });

  test('PostHog markers pass through unchanged', () => {
    expect(sanitizeUrl('$direct', ORIGIN)).toBe('$direct');
  });
});

describe('scrubEvent', () => {
  test('a private-page autocapture loses title, element text and link targets', () => {
    const event = scrubEvent(
      {
        event: '$autocapture',
        properties: {
          $current_url: 'https://kortix.com/workspaces/p1/spaces/q3-board-plan?x=1',
          $pathname: '/workspaces/p1/spaces/q3-board-plan',
          title: 'Q3 board plan · Acme',
          $el_text: 'Acme layoffs.xlsx',
          $elements_chain:
            'a.file-row:attr__class="file-row"attr__href="/workspaces/p1/files/Acme%20layoffs.xlsx"href="/workspaces/p1/files/Acme%20layoffs.xlsx"nth-child="2"nth-of-type="1"text="Acme layoffs.xlsx";div.list:nth-child="1"',
        },
      },
      ORIGIN,
    );
    expect(event.properties.$current_url).toBe('https://kortix.com/workspaces/:id/spaces/:id');
    expect(event.properties.$pathname).toBe('/workspaces/:id/spaces/:id');
    expect(event.properties.title).toBeUndefined();
    expect(event.properties.$el_text).toBeUndefined();
    const chain = String(event.properties.$elements_chain);
    expect(chain).not.toContain('Acme');
    expect(chain).not.toContain('href');
    expect(chain).toContain('a.file-row:attr__class="file-row"');
    expect(chain).toContain('nth-child="2"');
  });

  test('initial person properties are reduced too', () => {
    const event = scrubEvent(
      {
        event: '$identify',
        properties: { $current_url: 'https://kortix.com/workspaces/p1', $pathname: '/workspaces/p1' },
        $set_once: {
          $initial_current_url: 'https://kortix.com/auth?email=a%40b.com&utm_source=meta',
          $initial_pathname: '/connect/tok_1',
          $initial_referrer: '$direct',
        },
      },
      ORIGIN,
    );
    expect(event.$set_once).toEqual({
      $initial_current_url: 'https://kortix.com/auth?utm_source=meta',
      $initial_pathname: '/connect/:id',
      $initial_referrer: '$direct',
    });
  });

  test('a public-page click keeps its text', () => {
    const event = scrubEvent(
      {
        event: '$autocapture',
        properties: {
          $current_url: 'https://kortix.com/pricing',
          $pathname: '/pricing',
          $el_text: 'Start free',
        },
      },
      ORIGIN,
    );
    expect(event.properties.$el_text).toBe('Start free');
  });
});
