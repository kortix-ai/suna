import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'API Keys | Kortix',
  description: 'Manage your API keys for programmatic access to Kortix',
  openGraph: {
    title: 'API Keys | Kortix',
    description: 'Manage your API keys for programmatic access to Kortix',
    type: 'website',
  },
};

export default async function APIKeysLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
