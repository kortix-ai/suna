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
  process.env.KORTIX_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_URL || '';
const baseUrl = /^https?:\/\//.test(rawAppUrl) ? rawAppUrl : DEFAULT_APP_URL;

export const siteMetadata = {
  name: 'Kortix',
  title: 'Kortix – The Autonomous Company Operating System',
  description:
    'A cloud computer where AI agents run your company. Connect 3,000+ tools, configure autonomous agents, set triggers — and the machine operates 24/7 with persistent memory.',
  url: baseUrl,
  keywords:
    'Kortix, autonomous company operating system, AI agents, self-driving company, cloud computer, AI automation, agent orchestration, goal loops, AI triggers, persistent memory, autonomous workforce, AI operations',
};
