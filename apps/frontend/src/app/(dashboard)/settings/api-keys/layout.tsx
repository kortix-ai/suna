import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'API Keys | SprintLab',
  description: 'Manage your API keys for programmatic access to SprintLab',
  openGraph: {
    title: 'API Keys | SprintLab',
    description: 'Manage your API keys for programmatic access to SprintLab',
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
