import { WebMcpTools } from '@/components/agent-discovery/webmcp-tools';
import { BrowserNoiseGuard } from '@/components/browser-noise-guard';
import { DesktopBackButton } from '@/components/desktop/desktop-back-button';
import { DesktopChrome } from '@/components/desktop/desktop-chrome';
import { ThemeProvider } from '@/components/home/theme-provider';
import { I18nProvider } from '@/components/i18n-provider';
import { KortixProjectScope } from '@/components/kortix-project-scope';
import { LazyMotionProvider } from '@/components/lazy-motion-provider';
import { RootClientHosts, RootQueryHosts } from '@/components/root-client-hosts';
import { RootHead } from '@/components/root-head';
import { IconProvider } from '@/components/ui/icon-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MfaStepUpProvider } from '@/features/auth/mfa-step-up';
import { BrandingProvider } from '@/features/branding/branding-provider';
import { RequestDemoProvider } from '@/features/contact/request-demo-provider';
import { AuthProvider } from '@/features/providers/auth-provider';
import { type Locale, locales } from '@/i18n/config';
import { RouterBridge } from '@/lib/navigation/router-bridge-mount';
import '@/lib/polyfills';
import { getTranslations } from '@/i18n/get-translations';
import { normalizeLocale } from '@/i18n/locale';
import { loadMessages } from '@/i18n/messages';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';
import { siteMetadata } from '@/lib/site-metadata';
import { cn } from '@/lib/utils';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Toaster } from 'sonner';
import { roobert } from '../(system)/fonts/roobert';
import { roobertMono } from '../(system)/fonts/roobert-mono';
import '../globals.css';
import { GoogleTagManager } from '@/components/analytics/google-tag-manager';
import { VisitorPixel } from '@/components/analytics/visitor-pixel';
import { ReactQueryProvider } from '../react-query-provider';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

const ROOT_METADATA: Metadata = {
  metadataBase: new URL(siteMetadata.url),
  title: {
    default: siteMetadata.title,
    template: `%s | ${siteMetadata.name}`,
  },
  description: siteMetadata.description,
  keywords: siteMetadata.keywords,
  authors: [{ name: 'Kortix Team', url: siteMetadata.url }],
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
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      {
        url: '/icon-light-32.png',
        sizes: '32x32',
        type: 'image/png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32.png',
        sizes: '32x32',
        type: 'image/png',
        media: '(prefers-color-scheme: dark)',
      },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/manifest.json',
  // No root canonical: Next.js inherits `alternates` into every page that does
  // not set its own, which would mark unrelated pages as duplicates of the
  // homepage. Each indexable page declares its own canonical instead.
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  const title = t.raw('textce34af36d804');
  const description = t.raw('text2bf70270bfde');
  return {
    ...ROOT_METADATA,
    title: { default: title, template: `%s | ${siteMetadata.name}` },
    description,
    openGraph: {
      ...ROOT_METADATA.openGraph,
      title,
      description,
      images: [
        {
          url: '/banner.png',
          width: 1200,
          height: 630,
          alt: `${title} – ${description}`,
        },
      ],
    },
    twitter: { ...ROOT_METADATA.twitter, title, description },
  };
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Promise<{ locale: string }> }>) {
  // Every page lives under app/[locale]; the middleware rewrites the public URL
  // onto it (explicit /de/… prefix, else the profile locale, else English).
  // Reading the locale from the segment keeps marketing pages static.
  const htmlLang = normalizeLocale((await params).locale);
  if (!htmlLang || !locales.includes(htmlLang as Locale)) notFound();
  // The client I18nProvider reads this catalog during SSR (see i18n/messages.ts).
  await loadMessages(htmlLang);

  // Runtime config. Vercel builds bake it: the build and the runtime share one
  // environment, and baking lets marketing pages render statically. Standalone
  // (Docker, self-host) builds opt into request-time rendering so process.env
  // is read per request: the image is built once with placeholder values and
  // configured by the container environment. See lib/runtime-config-mode.ts.
  if (!runtimeConfigIsBakedAtBuild()) await connection();
  const runtimeEnv = getServerPublicEnv();

  return (
    <html
      lang={htmlLang}
      translate="no"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={cn('notranslate', roobert.variable, roobertMono.variable)}
    >
      <head>
        <RootHead runtimeEnv={runtimeEnv} />
      </head>

      {/* suppressHydrationWarning silences Grammarly et al. injecting
          `data-gr-*` attributes onto <body> before React hydrates. The
          warning is purely cosmetic but pollutes the dev overlay. */}
      <body
        translate="no"
        className="notranslate text-foreground bg-background min-h-screen w-full scroll-smooth font-sans font-medium tracking-normal antialiased"
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <LazyMotionProvider>
            <IconProvider>
              <TooltipProvider delayDuration={150}>
                <AuthProvider>
                  <I18nProvider initialLocale={htmlLang}>
                    <WebMcpTools />
                    {/* Publishes the App Router to lib/navigation/router-bridge so
                    stores and error handlers navigate softly instead of
                    reloading the document. */}
                    <RouterBridge />
                    <BrowserNoiseGuard />
                    <DesktopChrome />
                    {/* The window's one Back: every screen gets an exit on the
                    desktop shell unless its shell navigates already. */}
                    <DesktopBackButton />
                    <ReactQueryProvider>
                      <Toaster />
                      {/* Global "Request a demo" qualifier modal — mounted once here
                      so every enterprise CTA across the app (accounts settings,
                      billing, IAM) can open it via useRequestDemo(). */}
                      {/* Organization branding (Enterprise): the active
                      account's own logo / icon / favicon / product name.
                      Reads the shared account-list query, so it sits inside
                      ReactQueryProvider and above everything that renders a
                      KortixLogo. */}
                      <BrandingProvider>
                        <RequestDemoProvider>
                          {/* Account-wide MFA: catches the SDK's kortix:mfa-required
                          event (coded 403) and walks the user through a TOTP
                          step-up so the retried action passes the IAM gate. */}
                          <MfaStepUpProvider>
                            <KortixProjectScope>{children}</KortixProjectScope>
                          </MfaStepUpProvider>
                        </RequestDemoProvider>
                      </BrandingProvider>
                      {/* Maintenance banner, fallback file preview, act-as
                      banner: they read React Query, so they mount inside
                      ReactQueryProvider. Each loads after hydration. */}
                      <RootQueryHosts />
                    </ReactQueryProvider>
                    {process.env.NEXT_PUBLIC_GTM_ID && (
                      <GoogleTagManager gtmId={process.env.NEXT_PUBLIC_GTM_ID} />
                    )}
                    {/* Visitor pixel: production host only, never in the desktop
                    app, after window.load — gating lives in the component. */}
                    <VisitorPixel />
                    {/* Desktop URL prompt, analytics, trackers, localhost link
                    interceptor — each a post-hydration dynamic chunk. */}
                    <RootClientHosts vercel={process.env.VERCEL === '1'} />
                  </I18nProvider>
                </AuthProvider>
              </TooltipProvider>
            </IconProvider>
          </LazyMotionProvider>
        </ThemeProvider>
        <div id="portal" className="fixed top-0 left-0 z-40" />
      </body>
    </html>
  );
}
