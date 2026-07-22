import { DISCOVERY_PATHS } from './link-header';
import { AGENT_INDEX_URL, API_BASE, API_HEALTH_URL, OPENAPI_URL, siteUrl } from './endpoints';

type LinkTarget = { href: string; type?: string };

type LinksetEntry = { anchor: string } & Partial<
  Record<'service-desc' | 'service-doc' | 'status' | 'describedby' | 'terms-of-service', LinkTarget[]>
>;

/** RFC 9727 API catalog, serialised as an RFC 9264 linkset. */
export function buildApiCatalog(): { linkset: LinksetEntry[] } {
  return {
    linkset: [
      {
        anchor: API_BASE,
        'service-desc': [{ href: OPENAPI_URL, type: 'application/json' }],
        'service-doc': [{ href: siteUrl(DISCOVERY_PATHS.docs), type: 'text/html' }],
        status: [{ href: API_HEALTH_URL, type: 'application/json' }],
        'terms-of-service': [{ href: siteUrl(DISCOVERY_PATHS.terms) }],
      },
      {
        anchor: AGENT_INDEX_URL,
        'service-doc': [{ href: siteUrl(DISCOVERY_PATHS.docs), type: 'text/html' }],
        describedby: [
          { href: siteUrl(DISCOVERY_PATHS.llmsTxt), type: 'text/plain' },
          { href: siteUrl('/llms-full.txt'), type: 'text/plain' },
        ],
      },
    ],
  };
}
