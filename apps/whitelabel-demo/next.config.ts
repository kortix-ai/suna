import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The entire data layer is the @kortix/sdk workspace package (TS source) — transpile it.
  transpilePackages: ['@kortix/sdk'],
};

export default config;
