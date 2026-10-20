import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // A second `next dev` in this folder needs its own build folder
  // (`NEXT_DIST_DIR=.next-2 WHITELABEL_PORT=3012 pnpm dev`): Next refuses two
  // dev servers on one `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The data layer (@kortix/sdk) and the UI (@kortix/ui) are workspace packages
  // shipped as TS source — transpile both.
  transpilePackages: ['@kortix/sdk', '@kortix/ui'],
  // No Next.js badge over Lumen's UI in development.
  devIndicators: false,
  // `next dev` would append its agent-rules block to the tracked AGENTS.md.
  agentRules: false,
};

export default config;
