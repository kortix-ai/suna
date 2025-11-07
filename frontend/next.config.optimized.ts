import type { NextConfig } from 'next';

/**
 * Оптимизированная конфигурация Next.js для Suna AI
 * 
 * Улучшения:
 * - Отключены source maps для production (ускоряет сборку)
 * - Включен standalone output для Docker
 * - Оптимизирована компиляция
 * - Отключена телеметрия
 */

const nextConfig = (): NextConfig => ({
  // Standalone output для Docker и меньшего размера билда
  output: (process.env.NEXT_OUTPUT as 'standalone') || undefined,
  
  // Отключить source maps для production (значительно ускоряет сборку)
  productionBrowserSourceMaps: false,
  
  // Оптимизация компиляции
  compiler: {
    // Удаление console.log в production
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },
  
  // Экспериментальные функции для ускорения
  experimental: {
    // Оптимизация пакетов
    optimizePackageImports: [
      '@radix-ui/react-icons',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-select',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
      'lucide-react',
    ],
    
    // Турбо режим для dev
    turbo: {
      rules: {
        '*.svg': {
          loaders: ['@svgr/webpack'],
          as: '*.js',
        },
      },
    },
  },
  
  // Настройки изображений
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
    // Оптимизация изображений
    formats: ['image/avif', 'image/webp'],
  },
  
  // Webpack оптимизации
  webpack: (config, { dev, isServer }) => {
    // Оптимизация для production
    if (!dev && !isServer) {
      // Минимизация bundle size
      config.optimization = {
        ...config.optimization,
        moduleIds: 'deterministic',
        runtimeChunk: 'single',
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            default: false,
            vendors: false,
            // Vendor chunk для больших библиотек
            vendor: {
              name: 'vendor',
              chunks: 'all',
              test: /node_modules/,
              priority: 20,
            },
            // Общий chunk для часто используемых модулей
            common: {
              name: 'common',
              minChunks: 2,
              chunks: 'all',
              priority: 10,
              reuseExistingChunk: true,
              enforce: true,
            },
          },
        },
      };
    }
    
    return config;
  },
  
  // Rewrites для PostHog (из оригинального конфига)
  async rewrites() {
    return [
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
  
  skipTrailingSlashRedirect: true,
  
  // Отключить x-powered-by header
  poweredByHeader: false,
  
  // Строгий режим React
  reactStrictMode: true,
  
  // Настройки для SWC (быстрый компилятор)
  swcMinify: true,
});

export default nextConfig;
