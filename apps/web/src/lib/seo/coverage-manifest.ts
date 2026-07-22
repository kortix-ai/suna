/** Deterministic contracts enforced by public-content.test.ts. */
export const SEO_COVERAGE_MANIFEST = {
  canonicalOrigin: 'https://kortix.com',
  machineRoutes: ['/llms.txt', '/llms-full.txt', '/api/ai'],
  markdownFamilies: ['marketing', 'blog', 'docs', 'use-case'],
  requiredMarkdownHeaders: {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': 'inline',
    'X-Robots-Tag': 'index, follow',
    Vary: 'Accept',
  },
  maximumAgentApiPageSize: 50,
} as const;
