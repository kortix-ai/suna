import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar, type SidebarRun } from './app-sidebar';

/**
 * Top-level authenticated shell: the collapsible project sidebar + the inset
 * main column. Mirrors the Kortix project shell. Pages render their own
 * `PageHeader` + content inside `children`.
 */
export function AppShell({
  email,
  runs,
  activeSessionId,
  children,
}: {
  email: string;
  runs: SidebarRun[];
  activeSessionId?: string;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar email={email} runs={runs} activeSessionId={activeSessionId} />
      <SidebarInset className="flex h-svh flex-col overflow-hidden">{children}</SidebarInset>
    </SidebarProvider>
  );
}
