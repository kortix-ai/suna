import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Worker Conversation | SprintLab',
  description: 'Interactive Worker conversation powered by SprintLab',
  openGraph: {
    title: 'Worker Conversation | SprintLab',
    description: 'Interactive Worker conversation powered by SprintLab',
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
