import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'API Keys | Suna',
  description: 'Manage your API keys for programmatic access to Suna',
  openGraph: {
    title: 'API Keys | Suna',
    description: 'Manage your API keys for programmatic access to Suna',
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
