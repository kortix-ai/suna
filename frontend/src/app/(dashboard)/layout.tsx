import DashboardLayoutContent from '@/components/dashboard/layout-content';
import ErrorBoundary from '@/components/ErrorBoundary';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({
  children,
}: DashboardLayoutProps) {
  return (
    <ErrorBoundary>
      <DashboardLayoutContent>{children}</DashboardLayoutContent>
    </ErrorBoundary>
  );
}
