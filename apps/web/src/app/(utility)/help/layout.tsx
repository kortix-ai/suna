import { HelpLayoutClient } from '@/components/help/help-layout-client';

interface HelpLayoutProps {
  children: React.ReactNode;
}

export default function HelpLayout({
  children,
}: HelpLayoutProps) {
  return <HelpLayoutClient>{children}</HelpLayoutClient>;
}
