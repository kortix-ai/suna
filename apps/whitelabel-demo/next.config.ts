import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The data layer (@kortix/sdk) and the UI (@kortix/ui) are workspace packages
  // shipped as TS source — transpile both.
  transpilePackages: ['@kortix/sdk', '@kortix/ui'],
  // `next dev` would append its agent-rules block to the tracked AGENTS.md.
  agentRules: false,
};

export default config;
