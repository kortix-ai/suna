'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';

import { HelpSidebar } from '@/components/help/help-sidebar';
import { TableOfContents } from '@/components/ui/table-of-contents';
import { HelpSearchModal } from '@/components/help/help-search-modal';

export default function HelpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showSearchModal, setShowSearchModal] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setShowSearchModal(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div style={{ scrollBehavior: 'smooth' }} className="min-h-screen">
      <SidebarProvider>
        <HelpSidebar onSearchClick={() => setShowSearchModal(true)} />
        <SidebarInset className="flex-1">
          <div className="flex h-full">
            <div className="flex-1 overflow-hidden">
              <ScrollArea className="h-full w-full bg-background">
                <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-20 py-4 sm:py-6 lg:py-20 w-full min-w-0">
                  {children}
                </div>
              </ScrollArea>
            </div>
            <div className="hidden xl:block w-84 bg-background backdrop-blur-sm">
              <div className="sticky top-0 h-screen p-12 px-20 overflow-hidden">
                <TableOfContents />
              </div>
            </div>
          </div>
        </SidebarInset>
        <HelpSearchModal open={showSearchModal} onOpenChange={setShowSearchModal} />
      </SidebarProvider>
    </div>
  );
}

