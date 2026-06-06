import type { NextConfig } from 'next';
import fs from 'fs';
import path from 'path';
import { createMDX } from 'fumadocs-mdx/next';
import { withSentryConfig } from '@sentry/nextjs';
import { withBetterStack } from '@logtail/next';

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

// Local `pnpm preview` (scripts/dev-local.sh --build) sets KORTIX_PREVIEW_BUILD=1
// to trade prod-build fidelity for speed: skip the `standalone` file-tracing pass
// (next start never reads .next/standalone) and skip ESLint. Prod/CI/Vercel builds
// don't set this flag, so they are completely unaffected.
const IS_PREVIEW_BUILD = process.env.KORTIX_PREVIEW_BUILD === '1';

// --- Cross-origin dev / preview access -----------------------------------
// The app is frequently reached through a proxy whose hostname differs from the
// origin the browser sends: the Kortix platform proxy (p<port>-<id>.localhost:<port>),
// a Daytona sandbox (<port>-<id>.daytonaproxy01.net), or a Cloudflare quick
// tunnel (<id>.trycloudflare.com). Next's Server Action CSRF guard
// (app-render/action-handler.ts) rejects requests where the browser `Origin`
// doesn't match the `host`/`x-forwarded-host` it sees — surfacing as
// "Invalid Server Actions request." — and the dev `/_next/*` guard
// (block-cross-site.ts) blocks the same mismatch for internal assets.
//
// Allowlist the known proxy patterns so proxied requests are trusted. Two
// matchers consume this list with different semantics, so we cover both:
//   - serverActions.allowedOrigins matches `new URL(origin).host` (INCLUDES port)
//   - allowedDevOrigins matches `parsedOrigin.hostname` (STRIPS port)
// Hence both port-qualified (`*.localhost:8008`) and bare (`*.localhost`)
// patterns are present. Never loosen in production, where this is a real CSRF
// surface — there, only an explicit KORTIX_ALLOWED_DEV_ORIGINS opt-in applies.
const EXTRA_ALLOWED_ORIGINS = (process.env.KORTIX_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const ALLOWED_PROXY_ORIGINS =
  process.env.NODE_ENV === 'production'
    ? EXTRA_ALLOWED_ORIGINS
    : [
        // Direct localhost + Kortix platform proxy (web:3000 exposed on api:8008)
        '*.localhost',
        '*.localhost:3000',
        '*.localhost:8008',
        // Daytona cloud sandbox proxy
        '*.daytonaproxy01.net',
        // Cloudflare quick tunnel (KORTIX_URL in scripts/dev-local.sh)
        '*.trycloudflare.com',
        ...EXTRA_ALLOWED_ORIGINS,
      ];

const nextConfig = (): NextConfig => ({
  // Standalone bundles the app for Docker/Vercel via a slow monorepo-wide
  // file-tracing pass. `next start` (what `pnpm preview` uses) ignores it, so
  // skip it locally for a faster build.
  output: IS_PREVIEW_BUILD ? undefined : 'standalone',
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

  // Trust proxied dev/preview origins for internal `/_next/*` requests
  // (see ALLOWED_PROXY_ORIGINS above for the rationale).
  allowedDevOrigins: ALLOWED_PROXY_ORIGINS,

  // Skip type checking during build (done in CI via `pnpm typecheck`)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Lint runs in CI (`pnpm lint`); skip it during local preview builds for speed.
  // Prod/CI builds (no KORTIX_PREVIEW_BUILD) keep Next's default lint-on-build.
  eslint: {
    ignoreDuringBuilds: IS_PREVIEW_BUILD,
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
    // Trust proxied dev/preview origins for Server Actions so the email
    // sign-in (and every other action) isn't rejected as a CSRF mismatch
    // (see ALLOWED_PROXY_ORIGINS above for the rationale).
    serverActions: {
      allowedOrigins: ALLOWED_PROXY_ORIGINS,
    },
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

  async redirects() {
    return [
      // /enterprise was renamed to /contact — keep old links alive.
      {
        source: '/enterprise',
        destination: '/contact',
        permanent: true,
      },
    ];
  },

  async rewrites() {
    return [
      // Proxy API calls to backend to avoid CORS in local dev. The target is
      // env-driven so an isolated `pnpm worktree` instance proxies the browser
      // to ITS api port; unset (primary `pnpm dev`) keeps the default :8008.
      {
        source: '/v1/:path*',
        destination: `${process.env.KORTIX_API_PROXY_TARGET ?? 'http://localhost:8008'}/v1/:path*`,
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
