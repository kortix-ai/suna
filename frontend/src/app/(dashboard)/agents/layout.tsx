import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Agent Conversation | Bright-byte Kusor',
  description: 'Interactive agent conversation powered by Bright-byte Kusor',
  openGraph: {
    title: 'Agent Conversation | Bright-byte Kusor',
    description: 'Interactive agent conversation powered by Bright-byte Kusor',
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
