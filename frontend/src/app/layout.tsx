import { ThemeProvider } from '@/components/home/theme-provider';
import { siteMetadata } from '@/lib/site-metadata';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import { PresenceProvider } from '@/components/presence-provider';
import { ReactQueryProvider } from './react-query-provider';
import { Toaster } from '@/components/ui/sonner';
import Script from 'next/script';
import '@/lib/polyfills';
import { roobert } from './fonts/roobert';
import { roobertMono } from './fonts/roobert-mono';
import { Suspense, lazy } from 'react';
import { I18nProvider } from '@/components/i18n-provider';
import { featureFlags } from '@/lib/feature-flags';

// Lazy load non-critical analytics and global components
// Note: Analytics scripts will be automatically blocked by cookie consent service until consent is given
const Analytics = lazy(() => import('@vercel/analytics/react').then(mod => ({ default: mod.Analytics })));
const SpeedInsights = lazy(() => import('@vercel/speed-insights/next').then(mod => ({ default: mod.SpeedInsights })));
const GoogleAnalytics = lazy(() => import('@next/third-parties/google').then(mod => ({ default: mod.GoogleAnalytics })));
const GoogleTagManager = lazy(() => import('@next/third-parties/google').then(mod => ({ default: mod.GoogleTagManager })));
const PostHogIdentify = lazy(() => import('@/components/posthog-identify').then(mod => ({ default: mod.PostHogIdentify })));
const PlanSelectionModal = lazy(() => import('@/components/billing/pricing/plan-selection-modal').then(mod => ({ default: mod.PlanSelectionModal })));
const AnnouncementDialog = lazy(() => import('@/components/announcements/announcement-dialog').then(mod => ({ default: mod.AnnouncementDialog })));
const CookieConsent = lazy(() => import('@/components/cookie-consent').then(mod => ({ default: mod.CookieConsent })));
const RouteChangeTracker = lazy(() => import('@/components/analytics/route-change-tracker').then(mod => ({ default: mod.RouteChangeTracker })));
const AuthEventTracker = lazy(() => import('@/components/analytics/auth-event-tracker').then(mod => ({ default: mod.AuthEventTracker })));


export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' }
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
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
      { url: '/favicon-light.png', sizes: '32x32', media: '(prefers-color-scheme: dark)' },
    ],
    shortcut: '/favicon.png',
    apple: [{ url: '/logo_black.png', sizes: '180x180' }],
  },
  manifest: '/manifest.json',
  alternates: {
    canonical: siteMetadata.url,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${roobert.variable} ${roobertMono.variable}`}>
      <head>
        {/* Preload critical fonts for faster FCP - local fonts need crossOrigin for CORS */}
        <link
          rel="preload"
          href="/fonts/roobert/RoobertUprightsVF.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        
        {/* DNS prefetch for analytics (loaded later but resolve DNS early) */}
        <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
        <link rel="dns-prefetch" href="https://connect.facebook.net" />
        <link rel="dns-prefetch" href="https://eu.i.posthog.com" />
        
        {/* Container Load - Initialize dataLayer with page context BEFORE GTM loads */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                window.dataLayer = window.dataLayer || [];
                var pathname = window.location.pathname;
                
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
                } else if (pathname === '/dashboard') {
                  context = { master_group: 'Platform', content_group: 'Dashboard', page_type: 'home', language: lang };
                } else if (pathname.indexOf('/projects') === 0 || pathname.indexOf('/thread') === 0) {
                  context = { master_group: 'Platform', content_group: 'Dashboard', page_type: 'thread', language: lang };
                } else if (pathname.indexOf('/settings') === 0) {
                  context = { master_group: 'Platform', content_group: 'User', page_type: 'settings', language: lang };
                }
                
                window.dataLayer.push(context);
              })();
            `,
          }}
        />
        
        {/* Static SEO meta tags - rendered in initial HTML */}
        <title>Kortix: Your Autonomous AI Worker</title>
        <meta name="description" content="Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects." />
        <meta name="keywords" content="Kortix, AI Worker, Agentic AI, Autonomous AI Worker, AI Automation, AI Workflow Automation, AI Assistant, Task Automation" />
        <meta property="og:title" content="Kortix: Your Autonomous AI Worker" />
        <meta property="og:description" content="Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects." />
        <meta property="og:image" content="https://kortix.com/banner.png" />
        <meta property="og:url" content="https://kortix.com" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Kortix" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Kortix: Your Autonomous AI Worker" />
        <meta name="twitter:description" content="Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects." />
        <meta name="twitter:image" content="https://kortix.com/banner.png" />
        <meta name="twitter:site" content="@kortix" />
        <link rel="canonical" href="https://kortix.com" />
        
        {/* iOS Smart App Banner - shows native install banner in Safari */}
        {!featureFlags.disableMobileAdvertising ? (
          <meta name="apple-itunes-app" content="app-id=6754448524, app-argument=kortix://" />
        ) : null}

        {/* Facebook Pixel - Will be blocked by cookie consent service until marketing consent is given */}
        {process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID && (
          <>
        <Script id="facebook-pixel" strategy="lazyOnload" data-cookieconsent="marketing">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');

                fbq('init', '${process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID}');
            fbq('track', 'PageView');
          `}
        </Script>
        <noscript>
          <img
            height="1"
            width="1"
            style={{ display: "none" }}
                src={`https://www.facebook.com/tr?id=${process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID}&ev=PageView&noscript=1`}
          />
        </noscript>
          </>
        )}


        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: siteMetadata.name,
              alternateName: ['Kortix', 'Kortix AI', 'Kortix: Your Autonomous AI Worker'],
              url: siteMetadata.url,
              logo: `${siteMetadata.url}/favicon.png`,
              description: siteMetadata.description,
              foundingDate: '2024',
              sameAs: [
                'https://github.com/Kortix-ai/Suna',
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
              aggregateRating: {
                '@type': 'AggregateRating',
                ratingValue: '4.8',
                ratingCount: '1000',
              },
            }),
          }}
        />
      </head>

      <body className="antialiased font-sans bg-background">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider>
            <I18nProvider>
              <PresenceProvider>
              <ReactQueryProvider>
                {children}
                <Toaster />
                <Suspense fallback={null}>
                  <PlanSelectionModal />
                </Suspense>
              </ReactQueryProvider>
              </PresenceProvider>
            </I18nProvider>
          </AuthProvider>
          {/* Analytics - lazy loaded to not block FCP */}
          <Suspense fallback={null}>
            <Analytics />
          </Suspense>
          {process.env.NEXT_PUBLIC_GA_ID_1 && (
            <Suspense fallback={null}>
              <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID_1} />
            </Suspense>
          )}
          {process.env.NEXT_PUBLIC_GA_ID_2 && (
          <Suspense fallback={null}>
              <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID_2} />
          </Suspense>
          )}
          {process.env.NEXT_PUBLIC_GTM_ID && (
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
            <CookieConsent />
          </Suspense>
          <Suspense fallback={null}>
            <RouteChangeTracker />
          </Suspense>
          <Suspense fallback={null}>
            <AuthEventTracker />
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
