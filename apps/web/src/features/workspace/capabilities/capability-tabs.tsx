'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './tabs';

/**
 * The shared tab bar for /projects/[id]/{connectors,skills,commands}. Lives in
 * the `(capabilities)` route group layout so it does not remount when
 * switching tabs. Each trigger wraps a real `next/link` via `asChild` — the
 * tabs are links (middle-click, cmd-click, and prefetch all work), not a
 * client-side tab switch.
 */
export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeCapabilityTab(pathname);

  return (
    <div className="border-border/60 border-b">
      <div className="mx-auto w-full max-w-5xl px-4">
        <Tabs value={activeKey ?? ''}>
          <TabsList type="underline" className="flex w-full items-center justify-start">
            {CAPABILITY_TABS.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key} asChild className="w-fit flex-none">
                <Link href={capabilityTabHref(projectId, tab.key)}>{tab.label}</Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
}
