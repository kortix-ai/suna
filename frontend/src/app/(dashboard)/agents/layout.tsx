import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Agent Conversation | Kortix',
  description: 'Interactive agent conversation powered by Kortix',
  openGraph: {
    title: 'Agent Conversation | Kortix',
    description: 'Interactive agent conversation powered by Kortix',
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
