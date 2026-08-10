/**
 * Which Pipedream apps belong in the Kortix catalogue.
 *
 * Pipedream publishes 3,238 apps under one endpoint, and two kinds of record in
 * there are not connectors:
 *
 *   - **Workflow utilities** (`schedule`, `http`, `formatting`, `data_stores`, …)
 *     are steps inside a Pipedream workflow, not third-party services.
 *   - **Apps with no actions** — 1,161 of them — produce a connector with zero
 *     tools. Connecting one is a dead end the user only discovers afterwards.
 *
 * Everything else is in, **including API-key apps**. That is a reversal, and it
 * is the fix for the reported search regression: the predicate here used to
 * require `authType === 'oauth'`, which is true of only 659 of the 3,238 apps.
 * Searching "SAP" hit three real records — `sap_s_4hana_cloud` among them — and
 * this function deleted all three, so the page reported "No matches for SAP"
 * over a catalogue that plainly had them. Pipedream's hosted Connect Link
 * renders the app's own `custom_fields` form for key-based apps, so they
 * connect through exactly the same flow OAuth apps do; there was never a
 * capability behind the filter, only a narrower catalogue.
 */

const UTILITY_APP_SLUGS = new Set([
  'pipedream_utils',
  'schedule',
  'http',
  'formatting',
  'helper_functions',
  'data_stores',
  'sse',
  'delay',
  'filter',
  'end',
  'throw_error',
  'only_continue',
  'code',
  'rss',
  'pipedream',
  'go',
  'node',
  'python',
  'bash',
]);

const NATIVE_APP_SLUGS = new Set(['slack', 'slack_bot']);

/**
 * Whether one raw Pipedream app record belongs in the catalogue.
 *
 * `hasActions` is required rather than `hasActions || hasTriggers`: a connector
 * exposes actions as agent tools, and a trigger-only app contributes nothing an
 * agent can call. Measured on the live catalogue, that is 1,974 apps in and
 * 1,264 out (1,161 with neither, 103 trigger-only).
 */
export function isCatalogApp<T extends { slug: string; hasActions: boolean }>(app: T): boolean {
  return isThirdPartyApp(app) && app.hasActions;
}

/**
 * Whether the record is a third-party service at all, ignoring what it
 * publishes.
 *
 * The slug half of {@link isCatalogApp}, split out because the catalogue index
 * keeps action-less apps rather than discarding them: a search for "SAP" finds
 * two real SAP records that publish no actions, and the page must be able to
 * say so instead of reporting "no matches". Utilities are dropped at the crawl
 * because there is nothing true to say about them either.
 */
export function isThirdPartyApp<T extends { slug: string }>(app: T): boolean {
  if (UTILITY_APP_SLUGS.has(app.slug)) return false;
  if (NATIVE_APP_SLUGS.has(app.slug)) return false;
  return true;
}
