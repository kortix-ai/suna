import { BRAND } from '@/config/brand';
import { LUMEN_THEME } from '@/config/theme';
import { themeToCss } from '@kortix/ui/theme';
import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
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
