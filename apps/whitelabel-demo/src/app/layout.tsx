import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { Providers } from '@/components/providers';
import { brand } from '@/config/brand';
import { roobert } from './fonts/roobert';
import { roobertMono } from './fonts/roobert-mono';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${brand.name} — ${brand.tagline}`,
    template: `%s · ${brand.name}`,
  },
  description: `${brand.name} is a white-label agent workspace powered by the Kortix backend.`,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${roobert.variable} ${roobertMono.variable}`}
    >
      <body className="bg-background text-foreground font-sans antialiased">
        <Providers>{children}</Providers>
        <Toaster position="bottom-right" toastOptions={{ className: 'font-sans' }} />
      </body>
    </html>
  );
}
