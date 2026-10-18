'use client';

import { useState } from 'react';
import { DownloadAppModal } from '@/features/layout/download-app-modal';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { WorkspaceSwitcher } from '@/features/workspace/project-sidebar/workspace-switcher';

export default function DownloadAppDebugPage() {
  const [open, setOpen] = useState(false);
  return <main className="space-y-4 p-6">
    <SidebarProvider><div className="w-64"><WorkspaceSwitcher projectId="" /></div></SidebarProvider>
    <Button onClick={() => setOpen(true)}>Open download modal</Button>
    <DownloadAppModal open={open} onOpenChange={setOpen} />
    <Button variant="outline" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button>
    <p>Open Download App from the workspace menu, dismiss, and reopen without navigation.</p>
  </main>;
}
