import { ThemeProvider } from "@/components/home/theme-provider";
import { siteConfig } from "@/lib/site";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "black",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`,
  },
  description: "Suna is a fully open source AI assistant that helps you accomplish real-world tasks with ease. Through natural conversation, Suna becomes your digital companion for research, data analysis, and everyday challenges.",
  keywords: ["AI", "artificial intelligence", "browser automation", "web scraping", "file management", "AI assistant", "open source", "research", "data analysis"],
  authors: [{ name: "Kortix Team", url: "https://suna.so" }],
  creator: "Kortix Team - Adam Cohen Hillel, Marko Kraemer, Domenico Gagliardi, and Quoc Dat Le",
  publisher: "Kortix Team - Adam Cohen Hillel, Marko Kraemer, Domenico Gagliardi, and Quoc Dat Le",
  category: "Technology",
  applicationName: "Suna",
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
    title: "Suna - Open Source Generalist AI Agent",
    description: "Suna is a fully open source AI assistant that helps you accomplish real-world tasks with ease through natural conversation.",
    url: siteConfig.url,
    siteName: "Suna",
    images: [{
      url: "/banner.png",
      width: 1200,
      height: 630,
      alt: "Suna - Open Source Generalist AI Agent",
      type: "image/png",
    }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Suna - Open Source Generalist AI Agent",
    description: "Suna is a fully open source AI assistant that helps you accomplish real-world tasks with ease through natural conversation.",
    creator: "@kortixai",
    site: "@kortixai",
    images: [{
      url: "/banner.png",
      width: 1200,
      height: 630,
      alt: "Suna - Open Source Generalist AI Agent",
    }],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
    ],
    shortcut: "/favicon.ico",
  },
  // manifest: "/manifest.json",
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
      {/* <head>
        <Script src="https://unpkg.com/react-scan/dist/auto.global.js" />
      </head> */}

      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased font-sans bg-background`}
      >
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
        </ThemeProvider>
      </body>
    </html>
  );
}
