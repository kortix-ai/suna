import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'API Keys | Adentic',
  description: 'Manage your API keys for programmatic access to Adentic',
  openGraph: {
    title: 'API Keys | Adentic',
    description: 'Manage your API keys for programmatic access to Adentic',
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
