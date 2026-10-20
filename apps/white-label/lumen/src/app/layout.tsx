import { BRAND } from '@/config/brand';
import { LUMEN_THEME } from '@/config/theme';
import { themeToCss } from '@kortix/ui/theme';
import type { Metadata } from 'next';
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import { THEME_SCRIPT } from '@/config/theme-script';
import { Providers } from './providers';
import './globals.css';

// Lumen's type faces: sans and mono feed the theme, the serif is `font-display` (globals.css).
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-lumen-sans' });
const display = Instrument_Serif({ weight: '400', subsets: ['latin'], variable: '--font-lumen-display' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-lumen-mono' });

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* The white-label theme: Lumen's tokens over the @kortix/ui defaults. */}
        <style>{themeToCss(LUMEN_THEME)}</style>
        {/* Light, dark or system, applied before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
