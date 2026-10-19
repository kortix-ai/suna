import { BRAND } from '@/config/brand';
import { LUMEN_THEME } from '@/config/theme';
import { themeToCss } from '@kortix/ui/theme';
import type { Metadata } from 'next';
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// Lumen's type faces, referenced by the theme as --font-lumen-sans / --font-lumen-mono.
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-lumen-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-lumen-mono' });

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <head>
        {/* The white-label theme: Lumen's tokens over the @kortix/ui defaults. */}
        <style>{themeToCss(LUMEN_THEME)}</style>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
