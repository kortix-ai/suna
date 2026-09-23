/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/web-helpers.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  buildScrapeFailureResults,
  looksLikeHtml,
  parseScrapeInputUrls,
  parseScrapeOutput,
  parseWebSearchOutput,
  resolveScrapeResults,
  wsDomain,
  wsFavicon,
  wsRootDomain,
} from '@kortix/sdk';
export type {
  ParsedScrapeOutput,
  ScrapeResult,
  WebSearchQueryResult,
  WebSearchSource,
} from '@kortix/sdk';
