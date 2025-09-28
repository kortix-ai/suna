import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Agent Conversation | TryAdentic',
  description: 'Interactive agent conversation powered by TryAdentic',
  openGraph: {
    title: 'Agent Conversation | TryAdentic',
    description: 'Interactive agent conversation powered by TryAdentic',
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
