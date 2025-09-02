import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Agent Conversation | Omni',
  description: 'Interactive agent conversation powered by Omni',
  openGraph: {
    title: 'Agent Conversation | Omni',
    description: 'Interactive agent conversation powered by Omni',
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
