import { AuthProvider } from '@/components/AuthProvider';
import { BrowserNoiseGuard } from '@/components/browser-noise-guard';
import { DesktopChrome } from '@/components/desktop/desktop-chrome';
import { DesktopUrlPrompt } from '@/components/desktop/desktop-url-prompt';
import { ThemeProvider } from '@/components/home/theme-provider';
import { I18nProvider } from '@/components/i18n-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DESKTOP_INIT_SCRIPT, DESKTOP_UA_TOKEN } from '@/lib/desktop';
import { featureFlags } from '@/lib/feature-flags';
import { getHardcodedUiServerText } from '@/lib/hardcoded-ui-server';
import '@/lib/polyfills';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { siteMetadata } from '@/lib/site-metadata';
import { cn } from '@/lib/utils';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { Suspense, lazy } from 'react';
import { Toaster } from 'sonner';
import { roobert } from './(system)/fonts/roobert';
import { roobertMono } from './(system)/fonts/roobert-mono';
import './globals.css';
import { ReactQueryProvider } from './react-query-provider';

// Lazy load non-critical analytics and global components
const Analytics = lazy(() =>
  import('@vercel/analytics/react').then((mod) => ({ default: mod.Analytics })),
);
const SpeedInsights = lazy(() =>
  import('@vercel/speed-insights/next').then((mod) => ({
    default: mod.SpeedInsights,
  })),
);
const GoogleTagManager = lazy(() =>
  import('@next/third-parties/google').then((mod) => ({
    default: mod.GoogleTagManager,
  })),
);
const PostHogIdentify = lazy(() =>
  import('@/components/posthog-identify').then((mod) => ({
    default: mod.PostHogIdentify,
  })),
);
const AnnouncementDialog = lazy(() =>
  import('@/components/announcements/announcement-dialog').then((mod) => ({
    default: mod.AnnouncementDialog,
  })),
);
const RouteChangeTracker = lazy(() =>
  import('@/components/analytics/route-change-tracker').then((mod) => ({
    default: mod.RouteChangeTracker,
  })),
);
const AuthEventTracker = lazy(() =>
  import('@/components/analytics/auth-event-tracker').then((mod) => ({
    default: mod.AuthEventTracker,
  })),
);
const LocalhostLinkInterceptor = lazy(() =>
  import('@/components/localhost-link-interceptor').then((mod) => ({
    default: mod.LocalhostLinkInterceptor,
  })),
);

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  metadataBase: new URL(siteMetadata.url),
  title: {
    default: siteMetadata.title,
    template: `%s | ${siteMetadata.name}`,
  },
  description: siteMetadata.description,
  keywords: siteMetadata.keywords,
  authors: [{ name: 'Kortix Team', url: 'https://www.kortix.com' }],
  creator: 'Kortix Team',
  publisher: 'Kortix Team',
  applicationName: siteMetadata.name,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    title: siteMetadata.title,
    description: siteMetadata.description,
    url: siteMetadata.url,
    siteName: siteMetadata.name,
    locale: 'en_US',
    images: [
      {
        url: '/banner.png',
        width: 1200,
        height: 630,
        alt: `${siteMetadata.title} – ${siteMetadata.description}`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: siteMetadata.title,
    description: siteMetadata.description,
    creator: '@kortix',
    site: '@kortix',
    images: ['/banner.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.png', sizes: '32x32' },
      {
        url: '/favicon-light.png',
        sizes: '32x32',
        media: '(prefers-color-scheme: dark)',
      },
    ],
    shortcut: '/favicon.png',
    apple: [{ url: '/logo_black.png', sizes: '180x180' }],
  },
  manifest: '/manifest.json',
  alternates: {
    canonical: siteMetadata.url,
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const tHardcodedUi = { raw: getHardcodedUiServerText };
  // Opt into dynamic rendering so process.env is evaluated at request time,
  // not baked at build time. Critical for Docker images with runtime env vars.
  await connection();
  const runtimeEnv = getServerPublicEnv();

  // Suppress marketing/visitor-tracking scripts inside the desktop app. The
  // Tauri webview sends a `KortixDesktop` user-agent (see lib/desktop.ts); the
  // website still loads them as normal. Keeps third-party de-anonymization
  // pixels (Vector/Artisan via GTM, plus the hardcoded loader) out of the
  // authenticated native client.
  const isDesktopApp = (await headers()).get('user-agent')?.includes(DESKTOP_UA_TOKEN) ?? false;

  return (
    <html
      lang="en"
      translate="no"
      suppressHydrationWarning
      className={cn('notranslate', roobert.variable, roobertMono.variable)}
    >
      <head>
        {/* Runtime config — evaluated at request time via connection() above.
            Docker images get correct env vars regardless of build-time defaults. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__KORTIX_RUNTIME_CONFIG=${JSON.stringify(runtimeEnv)};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`,
          }}
        />

        {/* Desktop runtime detection — runs before hydration so CSS reacts on first paint. */}
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_INIT_SCRIPT }} />

        {/* Font preloading is handled automatically by next/font/local in fonts/roobert.ts */}

        {/* Prevent browser auto-translate (Google Translate, Chrome, etc.) from
            mutating the DOM. When translators modify text nodes, React's reconciler
            crashes with "Failed to execute 'insertBefore' on 'Node'".
            The app ships its own i18n via next-intl (en, de, it, zh, ja, pt, fr, es)
            so browser translation is unnecessary and actively harmful. */}
        <meta name="google" content="notranslate" />

        {/* DNS prefetch for analytics (loaded later but resolve DNS early) */}
        <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
        <link rel="dns-prefetch" href="https://eu.i.posthog.com" />

        {/* Container Load - Initialize dataLayer with page context BEFORE GTM loads */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                window.dataLayer = window.dataLayer || [];
                var pathname = window.location.pathname;
                var pathParts = pathname.split('/');
                if (pathParts.length >= 3 && pathParts[1] === 'instances') {
                  pathname = '/' + pathParts.slice(3).join('/');
                  if (pathname === '/') {
                    pathname = '/';
                  } else if (!pathname.startsWith('/')) {
                    pathname = '/' + pathname;
                  }
                }
                
                // Get language from localStorage, cookie, or default to 'en'
                var lang = 'en';
                try {
                  // Check localStorage first
                  var stored = localStorage.getItem('locale');
                  if (stored) {
                    lang = stored;
                  } else {
                    // Check cookie
                    var cookies = document.cookie.split(';');
                    for (var i = 0; i < cookies.length; i++) {
                      var cookie = cookies[i].trim();
                      if (cookie.indexOf('locale=') === 0) {
                        lang = cookie.substring(7);
                        break;
                      }
                    }
                  }
                } catch (e) {}
                
                var context = { master_group: 'General', content_group: 'Other', page_type: 'other', language: lang };
                
                if (pathname === '/' || pathname === '') {
                  context = { master_group: 'General', content_group: 'Other', page_type: 'home', language: lang };
                } else if (pathname.indexOf('/auth') === 0) {
                  context = { master_group: 'General', content_group: 'User', page_type: 'auth', language: lang };
                } else if (pathname === '/projects') {
                  context = { master_group: 'Platform', content_group: 'Projects', page_type: 'home', language: lang };
                } else if (pathname.indexOf('/workspace') === 0 || pathname.indexOf('/projects') === 0 || pathname.indexOf('/thread') === 0) {
                  context = { master_group: 'Platform', content_group: 'Projects', page_type: 'thread', language: lang };
                } else if (pathname.indexOf('/settings') === 0) {
                  context = { master_group: 'Platform', content_group: 'User', page_type: 'settings', language: lang };
                }
                
                window.dataLayer.push(context);
              })();
            `,
          }}
        />

        {/* Static SEO meta tags - rendered in initial HTML */}
        <title>
          {tHardcodedUi.raw('appLayout.line196JsxTextKortixTheAutonomousCompanyOperatingSystem')}
        </title>
        <meta
          name="description"
          content={tHardcodedUi.raw(
            'appLayout.line197JsxAttrContentACloudComputerWhereAiAgentsRunYour',
          )}
        />
        <meta
          name="keywords"
          content={tHardcodedUi.raw(
            'appLayout.line198JsxAttrContentKortixAutonomousCompanyOperatingSystemAiAgentsSelf',
          )}
        />
        <meta
          property="og:title"
          content={tHardcodedUi.raw(
            'appLayout.line199JsxAttrContentKortixTheAutonomousCompanyOperatingSystem',
          )}
        />
        <meta
          property="og:description"
          content={tHardcodedUi.raw(
            'appLayout.line200JsxAttrContentACloudComputerWhereAiAgentsRunYour',
          )}
        />
        <meta property="og:image" content="https://kortix.com/banner.png" />
        <meta property="og:url" content="https://kortix.com" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Kortix" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content={tHardcodedUi.raw(
            'appLayout.line206JsxAttrContentKortixTheAutonomousCompanyOperatingSystem',
          )}
        />
        <meta
          name="twitter:description"
          content={tHardcodedUi.raw(
            'appLayout.line207JsxAttrContentACloudComputerWhereAiAgentsRunYour',
          )}
        />
        <meta name="twitter:image" content="https://kortix.com/banner.png" />
        <meta
          name="twitter:site"
          content={tHardcodedUi.raw('appLayout.line209JsxAttrContentKortix')}
        />
        <link rel="canonical" href="https://kortix.com" />

        {/* iOS Smart App Banner - shows native install banner in Safari */}
        {!featureFlags.disableMobileAdvertising ? (
          <meta
            name="apple-itunes-app"
            content={tHardcodedUi.raw(
              'appLayout.line214JsxAttrContentAppId6754448524AppArgumentKortix',
            )}
          />
        ) : null}

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: siteMetadata.name,
              alternateName: [
                'Kortix',
                'Kortix AI',
                'Kortix – The AI Command Center for Your Company',
              ],
              url: siteMetadata.url,
              logo: `${siteMetadata.url}/favicon.png`,
              description: siteMetadata.description,
              foundingDate: '2024',
              sameAs: [
                'https://github.com/kortix-ai/suna',
                'https://x.com/kortix',
                'https://linkedin.com/company/kortix',
              ],
              contactPoint: {
                '@type': 'ContactPoint',
                contactType: 'Customer Support',
                url: siteMetadata.url,
              },
            }),
          }}
        />

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: siteMetadata.title,
              alternateName: [siteMetadata.name, 'Kortix'],
              applicationCategory: 'BusinessApplication',
              operatingSystem: 'Web, macOS, Windows, Linux',
              description: siteMetadata.description,
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
            }),
          }}
        />

        {/* Domain integration — script tag verification.
            Skipped in the desktop app (visitor de-anonymization pixel). */}
        {!isDesktopApp && (
          <script
            src="https://d2mvefebd70kbz.cloudfront.net/scripts/019e82ba-9ec3-733e-8a8e-9ff5cc2e1d35.js"
            async
          />
        )}
      </head>

      {/* suppressHydrationWarning silences Grammarly et al. injecting
          `data-gr-*` attributes onto <body> before React hydrates. The
          warning is purely cosmetic but pollutes the dev overlay. */}
      <body
        translate="no"
        className="notranslate text-foreground bg-background min-h-screen w-full scroll-smooth font-sans font-medium antialiased"
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={300}>
            <BrowserNoiseGuard />
            <DesktopChrome />
            <DesktopUrlPrompt />
            <AuthProvider>
              <I18nProvider>
                <ReactQueryProvider>
                  <Toaster />
                  {children}
                </ReactQueryProvider>
              </I18nProvider>
            </AuthProvider>
            {/* Analytics - lazy loaded to not block FCP */}
            <Suspense fallback={null}>
              <Analytics />
            </Suspense>
            {process.env.NEXT_PUBLIC_GTM_ID && !isDesktopApp && (
              <Suspense fallback={null}>
                <GoogleTagManager gtmId={process.env.NEXT_PUBLIC_GTM_ID} />
              </Suspense>
            )}
            <Suspense fallback={null}>
              <SpeedInsights />
            </Suspense>
            <Suspense fallback={null}>
              <PostHogIdentify />
            </Suspense>
            <Suspense fallback={null}>
              <RouteChangeTracker />
            </Suspense>
            <Suspense fallback={null}>
              <AuthEventTracker />
            </Suspense>
            <Suspense fallback={null}>
              <LocalhostLinkInterceptor />
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
