import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Agent Conversation | Adentic Adentic',
  description: 'Interactive agent conversation powered by Adentic Adentic',
  openGraph: {
    title: 'Agent Conversation | Adentic Adentic',
    description: 'Interactive agent conversation powered by Adentic Adentic',
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
