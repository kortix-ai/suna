import type { NextConfig } from 'next';
import path from 'path';
import { createMDX } from 'fumadocs-mdx/next';
import { withSentryConfig } from '@sentry/nextjs';
import { withBetterStack } from '@logtail/next';

const nextConfig = (): NextConfig => ({
  output: 'standalone',
  // Pin tracing root to monorepo root so standalone preserves
  // the correct `apps/web/server.js` path structure.
  outputFileTracingRoot: path.join(__dirname, '../../'),

  // Skip type checking during build (done in CI via `pnpm typecheck`)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Webpack configuration to make Konva work with Next.js
  webpack: (config) => {
    config.externals = [...config.externals, { canvas: 'canvas' }]; // required to make Konva & react-konva work
    return config;
  },

  // Turbopack configuration
  turbopack: {
    // Handle Node.js modules that shouldn't be bundled for browser builds
    // Canvas is a Node.js native module that needs to be externalized (required for Konva & react-konva)
    resolveAlias: {
      canvas: {
        browser: './src/lib/empty-module.ts', // Exclude canvas from browser builds
      },
    },
  },

  // Performance optimizations
  experimental: {
    // Optimize package imports for faster builds and smaller bundles
    optimizePackageImports: [
      'lucide-react',
      'framer-motion',
      '@radix-ui/react-icons',
      'recharts',
      'date-fns',
      '@tanstack/react-query',
      'react-icons',
    ],
  },

  // Enable compression
  compress: true,

  // Optimize images
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
    qualities: [75, 100],
  },

  async rewrites() {
    return [
      // Proxy API calls to backend to avoid CORS in local dev
      {
        source: '/v1/:path*',
        destination: 'http://localhost:8008/v1/:path*',
      },
      {
        source: '/ingest/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
      {
        source: '/ingest/flags',
        destination: 'https://eu.i.posthog.com/flags',
      },
    ];
  },

  // HTTP headers for caching and performance
  async headers() {
    return [
      {
        source: '/fonts/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/:path*.woff2',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },

  skipTrailingSlashRedirect: true,
});

const withMDX = createMDX();

// Compose config wrappers: MDX → Better Stack (structured logs) → Sentry (error tracking)
export default withSentryConfig(withBetterStack(withMDX(nextConfig())), {
  // Suppresses source map uploading logs during build
  silent: true,

  // Don't upload source maps during build (we can enable this later)
  sourcemaps: {
    disable: true,
  },

  // Disable Sentry CLI telemetry
  telemetry: false,

  // Tree-shake Sentry debug logger statements to reduce bundle size
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },

  // Route Sentry envelopes through our server to bypass ad-blockers.
  // Creates an auto-generated route at /monitoring that forwards to the DSN host.
  tunnelRoute: '/monitoring',
});
