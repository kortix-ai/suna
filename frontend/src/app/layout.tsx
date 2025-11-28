import { ThemeProvider } from '@/components/home/theme-provider';
import { siteMetadata } from '@/lib/site-metadata';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import { PresenceProvider } from '@/providers/presence-provider';
import { ReactQueryProvider } from './react-query-provider';
import { Toaster } from '@/components/ui/sonner';
import Script from 'next/script';
import '@/lib/polyfills';
import { roobert } from './fonts/roobert';
import { roobertMono } from './fonts/roobert-mono';
import { Suspense, lazy } from 'react';
import { I18nProvider } from '@/components/i18n-provider';

// Lazy load non-critical analytics and global components
const Analytics = lazy(() => import('@vercel/analytics/react').then(mod => ({ default: mod.Analytics })));
const SpeedInsights = lazy(() => import('@vercel/speed-insights/next').then(mod => ({ default: mod.SpeedInsights })));
const GoogleAnalytics = lazy(() => import('@next/third-parties/google').then(mod => ({ default: mod.GoogleAnalytics })));
const PostHogIdentify = lazy(() => import('@/components/posthog-identify').then(mod => ({ default: mod.PostHogIdentify })));
const PlanSelectionModal = lazy(() => import('@/components/billing/pricing/plan-selection-modal').then(mod => ({ default: mod.PlanSelectionModal })));


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
  authors: [{ name: 'Kortix Team', url: 'https://kortix.com' }],
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
        
        {/* Static SEO meta tags - rendered in initial HTML */}
        <title>Kortix: Your Autonomous AI Worker</title>
        <meta name="description" content="Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects." />
        <meta name="keywords" content="Kortix, Autonomous AI Worker, AI Worker, Generalist AI, Open Source AI, Autonomous Agent, Complex Tasks, AI Assistant" />
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

        <Script id="facebook-pixel" strategy="lazyOnload">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');

            fbq('init', '1385936776361131');
            fbq('track', 'PageView');
          `}
        </Script>
        <noscript>
          <img
            height="1"
            width="1"
            style={{ display: "none" }}
            src="https://www.facebook.com/tr?id=1385936776361131&ev=PageView&noscript=1"
          />
        </noscript>


        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: siteMetadata.name,
              alternateName: ['Suna', 'Kortix AI', 'Kortix: Your Autonomous AI Worker'],
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
              alternateName: [siteMetadata.name, 'Suna'],
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

        <Script id="google-tag-manager" strategy="lazyOnload">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer','GTM-PCHSN4M2');`}
        </Script>
      </head>

      <body className="antialiased font-sans bg-background">
        <noscript>
          <iframe
            src="https://www.googletagmanager.com/ns.html?id=GTM-PCHSN4M2"
            height="0"
            width="0"
            style={{ display: 'none', visibility: 'hidden' }}
          />
        </noscript>
        {/* End Google Tag Manager (noscript) */}

        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <I18nProvider>
            <AuthProvider>
              <PresenceProvider>
              <ReactQueryProvider>
                {children}
                <Toaster />
                <Suspense fallback={null}>
                  <PlanSelectionModal />
                </Suspense>
              </ReactQueryProvider>
              </PresenceProvider>
            </AuthProvider>
          </I18nProvider>
          {/* Analytics - lazy loaded to not block FCP */}
          <Suspense fallback={null}>
            <Analytics />
          </Suspense>
          <Suspense fallback={null}>
            <GoogleAnalytics gaId="G-6ETJFB3PT3" />
          </Suspense>
          <Suspense fallback={null}>
            <SpeedInsights />
          </Suspense>
          <Suspense fallback={null}>
            <PostHogIdentify />
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
