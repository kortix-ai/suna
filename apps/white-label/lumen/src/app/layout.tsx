import { BRAND } from '@/config/brand';
import { LUMEN_THEME } from '@/config/theme';
import { themeToCss } from '@kortix/ui/theme';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Newsreader } from 'next/font/google';
import Script from 'next/script';
import { THEME_SCRIPT } from '@/config/theme-script';
import { Providers } from './providers';
import './globals.css';

// Lumen's type: Newsreader (display serif, optical sizes) for titles and answers,
// Geist for every control and body line, Geist Mono for citations, ids and eyebrows.
const sans = Geist({ subsets: ['latin'], variable: '--font-lumen-sans' });
const display = Newsreader({ subsets: ['latin'], axes: ['opsz'], style: ['normal', 'italic'], variable: '--font-lumen-display' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-lumen-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3020'),
  title: { default: `${BRAND.name}: ${BRAND.tagline}`, template: `%s · ${BRAND.name}` },
  description: BRAND.subline,
  openGraph: { siteName: BRAND.name, type: 'website' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1520' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* The white-label theme: Lumen's tokens over the @kortix/ui defaults. */}
        <style>{themeToCss(LUMEN_THEME)}</style>
        {/* Light, dark or system, applied before the first paint. */}
        <Script id="lumen-theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
