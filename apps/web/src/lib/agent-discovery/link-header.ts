/**
 * Discovery paths and the site-wide RFC 8288 `Link` response header.
 *
 * This file MUST NOT import anything. `next.config.ts` is evaluated outside
 * the Next module graph and cannot resolve the `@/` alias, so it imports this
 * module by relative path. `endpoints.ts` depends on these constants rather
 * than the reverse.
 */

export const DISCOVERY_PATHS = {
  apiCatalog: '/.well-known/api-catalog',
  authorizationServer: '/.well-known/oauth-authorization-server',
  protectedResource: '/.well-known/oauth-protected-resource',
  agentSkillsIndex: '/.well-known/agent-skills/index.json',
  authMd: '/auth.md',
  docs: '/docs',
  llmsTxt: '/llms.txt',
  terms: '/legal',
} as const;

/**
 * `service-desc` is deliberately absent: the OpenAPI document lives on
 * api.kortix.com, a different origin, and belongs in the API catalog's linkset
 * where it can be anchored to the API it describes.
 */
export const SITE_LINK_VALUES: string[] = [
  `<${DISCOVERY_PATHS.apiCatalog}>; rel="api-catalog"`,
  `<${DISCOVERY_PATHS.docs}>; rel="service-doc"`,
  `<${DISCOVERY_PATHS.llmsTxt}>; rel="describedby"; type="text/plain"`,
  `<${DISCOVERY_PATHS.terms}>; rel="terms-of-service"`,
];

export const SITE_LINK_HEADER = SITE_LINK_VALUES.join(', ');

export function markdownAlternateLinkValue(markdownPath: string): string {
  return `<${markdownPath}>; rel="alternate"; type="text/markdown"`;
}
