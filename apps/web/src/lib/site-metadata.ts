/**
 * Site metadata configuration - SIMPLE AND WORKING
 */

/**
 * One public origin for canonical URLs, sitemaps, structured data, and
 * machine-readable representations. Runtime app URLs are deliberately not
 * used here: a preview/dev hostname must never become the canonical origin.
 */
export const CANONICAL_ORIGIN = 'https://kortix.com';

export const siteMetadata = {
  name: 'Kortix',
  title: 'Kortix – The open-source AI Operating System',
  description:
    'Open-source AI Operating System: your agents, skills, memory, and connectors in one repo you own. Any model. Self-host or cloud.',
  url: CANONICAL_ORIGIN,
  keywords:
    'Kortix, AI Operating System, open-source AI Operating System, AI OS, open-source AI OS, AI Operating System for companies, what is an AI Operating System, open-source alternative to Claude Cowork, ChatGPT Work alternative, company as a git repo, agents skills and memory as files, shared AI agents, scoped access, self-hosted AI agents, connect 3000 tools, agent orchestration, AI-native company, AI operations',
};
