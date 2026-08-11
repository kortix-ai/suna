/**
 * dosco site metadata — single public origin for canonical URLs, sitemaps,
 * structured data, and machine-readable representations. Runtime app URLs
 * are deliberately not used here: a preview/dev hostname must never become
 * the canonical origin.
 */
export const CANONICAL_ORIGIN = 'https://dosco.live';

export const siteMetadata = {
  name: 'dosco',
  title: 'dosco – The agent network for your company',
  description:
    'dosco is a closed, agent-native operating system for company work. Spin up persistent AI agents that connect to 3,000+ tools, run in real sandboxes, and share state across your team — one network, one command, every workflow.',
  url: CANONICAL_ORIGIN,
  keywords:
    'dosco, agent network, AI workforce, agent orchestration, agent runtime, AI sandboxes, persistent agents, shared agents, scoped access, agent-native platform, connect 3000 tools, AI operations, company-of-agents',
};
