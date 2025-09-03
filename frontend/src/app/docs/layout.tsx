'use client';

import * as React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';

import { AppSidebar } from '@/components/app-sidebar';
import { TableOfContents } from '@/components/ui/table-of-contents';

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div style={{ scrollBehavior: 'smooth' }} className="min-h-screen">
     <div className="hidden dark:block fixed rotate-180 opacity-15 inset-0 -z-10 h-full w-full items-center px-5 py-24 bg-white dark:bg-black"></div>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex-1">
          <div className="lg:hidden bg-white dark:bg-black fixed top-0 left-0 right-0 z-50 backdrop-blur-sm h-16">
            <div className="flex items-center justify-between px-4 h-full">
              <SidebarTrigger className="-ml-1" />
              <h1 className="font-semibold truncate">Suna Docs</h1>
            </div>
          </div>
          <div className="flex h-full">
            <div className="flex-1 overflow-hidden pt-16 lg:pt-0">
              <ScrollArea className="h-full w-full bg-white dark:bg-black">
                <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-20 py-4 sm:py-6 lg:py-20 w-full min-w-0">
                  {children}
                </div>
              </ScrollArea>
            </div>
            <div className="hidden xl:block w-84 bg-white dark:bg-black backdrop-blur-sm">
              <div className="sticky top-0 h-screen p-12 px-20 overflow-hidden">
                <TableOfContents />
              </div>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
} 