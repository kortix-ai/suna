import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Worker Conversation | Kortix',
  description: 'Interactive Worker conversation powered by Kortix',
  openGraph: {
    title: 'Worker Conversation | Kortix',
    description: 'Interactive Worker conversation powered by Kortix',
    type: 'website',
  },
};

export default async function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
