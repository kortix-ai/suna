'use client';

import { SidebarProvider } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { WorkspaceSwitcher } from '@/features/workspace/project-sidebar/workspace-switcher';

export default function DownloadAppDebugPage() {
  return <main className="space-y-4 p-6">
    <SidebarProvider><div className="w-64"><WorkspaceSwitcher projectId="" /></div></SidebarProvider>
    <Button variant="outline" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button>
    <p>Open Download App from the workspace menu, dismiss, and reopen without navigation.</p>
  </main>;
}
