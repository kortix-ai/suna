/**
 * Site metadata configuration - SIMPLE AND WORKING
 */

const DEFAULT_APP_URL = 'https://www.kortix.com';
// Only accept a real absolute http(s) URL. A missing var — or a non-decrypted
// dotenvx `encrypted:…` value reaching the Vercel `next build` (which loads the
// committed apps/web/.env raw) — would otherwise flow into
// `metadataBase: new URL(...)`, which then crashes SSR on EVERY route when Next
// resolves relative OG/icon URLs against it (TypeError: Invalid URL).
const rawAppUrl =
  process.env.KORTIX_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_URL ||
  '';
const baseUrl = /^https?:\/\//.test(rawAppUrl) ? rawAppUrl : DEFAULT_APP_URL;

export const siteMetadata = {
  name: 'Kortix',
  title: 'Kortix – The AI Command Center for Your Company',
  description:
    'The open-source AI command center for your company. Every agent, skill, and memory is a file in one versioned repo you own — a workforce of AI agents that does real work, shared across your whole team from Slack, Teams, the web, or the CLI. Self-hostable, any model, your keys.',
  url: baseUrl,
  keywords:
    'Kortix, AI command center, autonomous company operating system, workforce of AI agents, company as a git repo, agents skills and memory as files, shared AI agents, scoped access, open source AI platform, self-hosted AI agents, connect 3000 tools, agent orchestration, AI-native company, AI operations',
};
