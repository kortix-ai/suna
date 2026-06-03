import { withBetterStack } from '@logtail/next';
import { withSentryConfig } from '@sentry/nextjs';
import fs from 'fs';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import path from 'path';

// Unified platform version. Prefer the explicit build env (CI passes
// NEXT_PUBLIC_KORTIX_VERSION = X.Y.Z-dev.<sha> on dev, clean X.Y.Z on prod);
// otherwise read the root VERSION file so Vercel builds (which don't pass the
// build-arg) still report the version. On Vercel, the `prod` branch is the only
// clean release — any other branch (dev) is a pre-release, so suffix
// `-dev.<sha8>` so dev.kortix.com tracks the in-progress version instead of
// showing a bare release number. Falls back to 'dev' locally.
function resolveKortixVersion(): string {
  if (process.env.NEXT_PUBLIC_KORTIX_VERSION) return process.env.NEXT_PUBLIC_KORTIX_VERSION;
  let base = 'dev';
  try {
    base = fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim();
  } catch {
    return 'dev';
  }
  const ref = process.env.VERCEL_GIT_COMMIT_REF;
  if (ref && ref !== 'prod') {
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8);
    return sha ? `${base}-dev.${sha}` : `${base}-dev`;
  }
  return base;
}
const KORTIX_VERSION = resolveKortixVersion();

const nextConfig = (): NextConfig => ({
  output: 'standalone',
  // Inline the resolved version so NEXT_PUBLIC_KORTIX_VERSION is available in
  // both the server (runtime-config) and client bundles, even on Vercel.
  env: {
    NEXT_PUBLIC_KORTIX_VERSION: KORTIX_VERSION,
  },
  // Hide Next.js's persistent dev badge in the corner. It only ever
  // really matters when there's a build error / route compile issue —
  // the error overlay still shows in those cases.
  devIndicators: false,

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
      'cmdk',
      'next-intl',
      '@icons-pack/react-simple-icons',
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

  // HTTP headers for security, caching and performance
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self';",
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
        ],
      },
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
