import { ThemeProvider } from '@/components/home/theme-provider';
import { siteConfig } from '@/lib/site';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Toaster } from '@/components/ui/sonner';
import { Analytics } from '@vercel/analytics/react';
import { GoogleAnalytics } from '@next/third-parties/google';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Script from 'next/script';
import { PostHogIdentify } from '@/components/posthog-identify';
import '@/lib/polyfills'; // Load polyfills early

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const viewport: Viewport = {
  themeColor: 'black',
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`,
  },
  description:
    'Kusor is an enterprise-grade AI assistant that helps you accomplish real-world tasks with ease. Through natural conversation, Kusor becomes your digital companion for research, data analysis, and everyday challenges.',
  keywords: [
    'AI',
    'artificial intelligence',
    'browser automation',
    'web scraping',
    'file management',
    'AI assistant',
    'enterprise AI',
    'research',
    'data analysis',
    'secure AI',
  ],
  authors: [{ name: 'Bright Byte', url: 'https://suna.so' }],
  creator:
    'Bright Byte',
  publisher:
    'Bright Byte',
  category: 'Technology',
  applicationName: 'Kusor',
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  openGraph: {
    title: 'Kusor - Enterprise AI Assistant',
    description:
      'Kusor is an enterprise-grade AI assistant that helps you accomplish real-world tasks with ease through natural conversation.',
    url: siteConfig.url,
    siteName: 'Kusor',
    images: [
      {
        url: '/banner.png',
        width: 1200,
        height: 630,
        alt: 'Kusor - Enterprise AI Assistant',
        type: 'image/png',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kusor - Enterprise AI Assistant',
    description:
      'Kusor is an enterprise-grade AI assistant that helps you accomplish real-world tasks with ease through natural conversation.',
    creator: '@kortixai',
    site: '@kortixai',
    images: [
      {
        url: '/banner.png',
        width: 1200,
        height: 630,
        alt: 'Kusor - Enterprise AI Assistant',
      },
    ],
  },
  icons: {
    icon: [
      { url: '/fav-icon/favicon.ico', sizes: 'any' },
      { url: '/fav-icon/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/fav-icon/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/fav-icon/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
    ],
    shortcut: '/fav-icon/favicon.ico',
    apple: [
      { url: '/fav-icon/apple-icon-57x57.png', sizes: '57x57', type: 'image/png' },
      { url: '/fav-icon/apple-icon-60x60.png', sizes: '60x60', type: 'image/png' },
      { url: '/fav-icon/apple-icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { url: '/fav-icon/apple-icon-76x76.png', sizes: '76x76', type: 'image/png' },
      { url: '/fav-icon/apple-icon-114x114.png', sizes: '114x114', type: 'image/png' },
      { url: '/fav-icon/apple-icon-120x120.png', sizes: '120x120', type: 'image/png' },
      { url: '/fav-icon/apple-icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { url: '/fav-icon/apple-icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/fav-icon/apple-icon-180x180.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: "/fav-icon/manifest.json",
  alternates: {
    canonical: siteConfig.url,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Google Tag Manager */}
        <Script id="google-tag-manager" strategy="afterInteractive">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer','GTM-PCHSN4M2');`}
        </Script>
        <Script async src="https://cdn.tolt.io/tolt.js" data-tolt={process.env.NEXT_PUBLIC_TOLT_REFERRAL_ID}></Script>
      </head>

      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased font-sans bg-background`}
      >
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
          <Providers>
            {children}
            <Toaster />
          </Providers>
          <Analytics />
          <GoogleAnalytics gaId="G-6ETJFB3PT3" />
          <SpeedInsights />
          <PostHogIdentify />
        </ThemeProvider>
      </body>
    </html>
  );
}
