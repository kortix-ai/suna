/**
 * PostHog rules that decide what leaves the browser. Pure functions, no
 * posthog-js import: `posthog-client.ts` applies them, the unit test pins them.
 *
 * 1. Where to send. A project key belongs to kortix.com. Any other host —
 *    dev, staging, a self-hosted install, a white-label domain, a PR preview —
 *    gets no key,
 *    so posthog-js is never even downloaded there. Project keys are public by
 *    design (every visitor's browser receives them); they authorize writes
 *    only. Local runs opt in with NEXT_PUBLIC_POSTHOG_KEY.
 * 2. Consent. Storage needs the visitor's analytics consent from the CookieYes
 *    banner. Without it the client keeps its ids in memory only.
 * 3. What a URL may say. Signed-in and capability-token pages carry customer
 *    names and one-time tokens in the path, and auth pages carry the email in
 *    the query. Every URL is reduced before it is sent: own-origin paths under
 *    the app become a route template, only campaign parameters survive the
 *    query, and the hash never leaves.
 */

import { locales } from '@/i18n/catalog.mjs';
import { analyticsLocation, isAnalyticsExcludedPath } from '@/lib/analytics/gtm';

/** EU Cloud project 334925, which collects kortix.com. Public: a write-only client key. */
export const POSTHOG_PROJECT_KEY = 'phc_nPL2v9FLjKUyXvaabr4tdvCCRTCUw4nUt6GqsnAeTAHs';
export const POSTHOG_UI_HOST = 'https://eu.posthog.com';
/** Same-origin reverse proxy (next.config.ts rewrites to eu.i.posthog.com). */
export const POSTHOG_API_HOST = '/ingest';

export type AnalyticsEnvironment = 'production' | 'staging' | 'dev' | 'local';

/** Hosts that send to the Kortix project, with the environment they report. */
// Production only (decision 2026-11-06): the free plan has one project, and
// dev and staging traffic in it is noise. They report nothing.
const HOST_ENVIRONMENTS: Record<string, AnalyticsEnvironment> = {
  'kortix.com': 'production',
  'www.kortix.com': 'production',
};

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

export interface PostHogProject {
  key: string;
  environment: AnalyticsEnvironment;
}

/**
 * The project this page reports to, or null when it must not report at all.
 * `localKey` is NEXT_PUBLIC_POSTHOG_KEY: it enables a local run and nothing
 * else, so a self-host image built with the variable still sends nothing.
 */
export function posthogProjectForHost(
  hostname: string,
  localKey: string | undefined,
): PostHogProject | null {
  const host = hostname.toLowerCase();
  const environment = HOST_ENVIRONMENTS[host];
  if (environment) return { key: POSTHOG_PROJECT_KEY, environment };
  if (isLocalHost(host) && localKey?.startsWith('phc_')) {
    return { key: localKey, environment: 'local' };
  }
  return null;
}

export type AnalyticsConsent = 'granted' | 'denied' | 'unknown';

/**
 * The analytics answer stored by the CookieYes banner (loaded through GTM on
 * marketing pages). Its cookie reads
 * `consentid:…,consent:yes,action:yes,necessary:yes,analytics:yes,…`;
 * `action:yes` means the visitor answered. A region where the banner grants
 * by default writes `analytics:yes` without an action, which is a grant.
 */
export function readAnalyticsConsent(cookieHeader: string): AnalyticsConsent {
  const raw = cookieHeader
    .split(/;\s*/)
    .find((part) => part.startsWith('cookieyes-consent='))
    ?.slice('cookieyes-consent='.length);
  if (!raw) return 'unknown';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return 'unknown';
  }
  const fields = new Map(
    decoded.split(',').map((pair) => {
      const index = pair.indexOf(':');
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    }),
  );
  if (fields.get('analytics') === 'yes') return 'granted';
  if (fields.get('action') === 'yes') return 'denied';
  return 'unknown';
}

/** Signed-in and capability-token pages. Their paths and text are customer data. */
export function isPrivatePath(pathname: string): boolean {
  return isAnalyticsExcludedPath(pathname);
}

/**
 * Path segments a private route may keep. Every other segment is an id, a
 * slug, an agent or file name, or a token, and becomes `:id`.
 */
const ROUTE_WORDS = new Set([
  // Route folders under app/[locale]. `projects` is the pre-2026-11-06 name.
  'workspaces',
  'projects',
  'sessions',
  'customize',
  'agents',
  'admin',
  'connectors',
  'artifacts',
  'c',
  'dm',
  'goals',
  'spaces',
  'settings',
  'capture',
  'devices',
  'invites',
  'slack',
  'teams',
  'login',
  'tunnel',
  'authorize',
  'connect',
  'secret-intake',
  'share',
  'artifact',
  'response',
  'session',
  'approve',
  'new',
  'setup',
  'cli',
  'oauth',
  'preview',
  'github',
  'connections',
  'start',
  // Fixed tab and section names.
  'billing',
  'plan',
  'profile',
  'members',
  'tokens',
  'api-keys',
  'webhooks',
  'schedules',
  'secrets',
  'computer',
  'computers',
  'general',
  'git',
  'triggers',
  'providers',
  'skills',
  'models',
  'review',
  'sandboxes',
  'accounts',
  'loops',
  'analytics',
  'usage',
  'security',
  'team',
  'integrations',
  'notifications',
  'appearance',
  'tools',
  'memory',
  'files',
  'apps',
  'channels',
  'shared',
]);

/** `/de/workspaces/9f…/sessions/4a…` → `/workspaces/:id/sessions/:id`. */
export function routeTemplate(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && (locales as readonly string[]).includes(segments[0]!)) {
    segments.shift();
  }
  const kept = segments.map((segment) => {
    const word = segment.toLowerCase();
    return ROUTE_WORDS.has(word) ? word : ':id';
  });
  return `/${kept.join('/')}`;
}

/**
 * The URL as PostHog may store it. Own-origin: origin, a path (a template on
 * private pages) and only campaign parameters. Another origin: origin and
 * path, nothing else. Not a URL: dropped.
 */
export function sanitizeUrl(value: string, origin: string): string | null {
  // PostHog's own markers such as `$direct` are not URLs and pass unchanged.
  if (!/^(https?:\/\/|\/)/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return `${url.origin}${url.pathname}`;
  const path = isPrivatePath(url.pathname) ? routeTemplate(url.pathname) : url.pathname;
  return analyticsLocation(url.origin, path, url.search);
}

/** A path as PostHog may store it. */
export function sanitizePath(pathname: string): string {
  return isPrivatePath(pathname) ? routeTemplate(pathname) : pathname;
}

/** `$current_url`, `$initial_current_url`, `$session_entry_url`, `$referrer`, … */
const URL_KEY = /(url|href|referrer)$/;
/** `$pathname`, `$initial_pathname`, `$prev_pageview_pathname`, … */
const PATH_KEY = /pathname$/;

/** Element-chain attributes that can carry customer text on a private page. */
const CHAIN_TEXT =
  /(?:\btext|\bhref|attr__(?:href|title|aria-label|alt|placeholder|value|name|data-[\w-]*))="(?:[^"\\]|\\.)*"/g;

type Props = Record<string, unknown>;

function scrubBag(bag: Props | undefined, origin: string): void {
  if (!bag) return;
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== 'string') continue;
    const name = key.toLowerCase();
    if (URL_KEY.test(name)) {
      const clean = sanitizeUrl(value, origin);
      if (clean === null) delete bag[key];
      else bag[key] = clean;
    } else if (PATH_KEY.test(name)) {
      bag[key] = sanitizePath(value);
    }
  }
}

export interface ScrubbableEvent {
  event: string;
  properties: Props;
  $set?: Props;
  $set_once?: Props;
}

/**
 * The `before_send` hook. Rewrites every URL- and path-valued property, and on
 * private pages removes page titles and every piece of element text or link
 * target an autocapture event carries. Never drops an event.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T, origin: string): T {
  const pathname =
    typeof event.properties.$pathname === 'string'
      ? event.properties.$pathname
      : (() => {
          try {
            return new URL(String(event.properties.$current_url ?? '/'), origin).pathname;
          } catch {
            return '/';
          }
        })();
  const privatePage = isPrivatePath(pathname);

  scrubBag(event.properties, origin);
  scrubBag(event.$set, origin);
  scrubBag(event.$set_once, origin);

  if (privatePage) {
    delete event.properties.title;
    delete event.properties.$title;
    delete event.properties.$el_text;
    delete event.properties.$elements;
    const chain = event.properties.$elements_chain;
    if (typeof chain === 'string') {
      event.properties.$elements_chain = chain.replace(CHAIN_TEXT, '');
    }
  }
  return event;
}
