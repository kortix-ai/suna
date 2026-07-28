'use client';

/**
 * The logged-out homepage.
 *
 * This is the SAME shell as the signed-in one, not a look-alike. The sidebar
 * chrome, the Customize group, the welcome body and the starter chips are all
 * the same components the project shell renders — so a class change moves both
 * and the two surfaces cannot drift apart. If they drifted, the logged-out page
 * would stop being a preview of the product and start being a different app.
 *
 * The composer and the session list are the real ones too: every hook they
 * reach for already self-gates on `runtimeReady` (false with no sandbox) or on
 * `!!projectId`, so nothing fetches. What stays out is the project data ROOT —
 * ProjectShell and AppProviders mount session-assuming providers with no query
 * guard of their own. Actions route through the sign-in gate.
 */

import { FolderOpen, Settings as LucideSettings, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { SidebarGroup, SidebarInset, SidebarMenu, SidebarProvider } from '@/components/ui/sidebar';
import { AnonymousSectionPreview } from '@/features/home/anonymous-section-preview';
import { AnonymousSectionTabs } from '@/features/home/anonymous-section-tabs';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { ComposerChatInput } from '@/features/session/composer-chat-input';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { ProjectNavGroup } from '@/features/workspace/project-sidebar/project-nav-items';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import {
  SidebarBody,
  SidebarBrandHeader,
  SidebarFooterSlot,
  SidebarNavRow,
  SidebarNewButton,
  SidebarPlainLink,
  SidebarShell,
} from '@/features/workspace/project-sidebar/sidebar-chrome';
import { PROJECT_NAV_ITEMS, type ProjectNavKey } from '@/lib/project-nav';

const MARKETING_LINKS = [
  { label: 'Why Kortix', href: '/why' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Enterprise', href: '/enterprise' },
  { label: 'Developers', href: '/developers' },
  { label: 'Docs', href: '/docs' },
];

function AnonymousSidebar({ activeSection }: { activeSection: ProjectNavKey | null }) {
  const { gate } = useSignInGate();

  return (
    <SidebarShell>
      <SidebarBrandHeader homeHref="/" />

      <SidebarBody>
        <SidebarNewButton label="New" onClick={() => gate('/')} />

        <SidebarGroup className="min-h-0 flex-1 flex-col py-0">
          <div className="flex min-h-0 flex-1 flex-col space-y-1">
            <SidebarMenu>
              <SidebarNavRow icon={MessagesSquare} label="Sessions" onClick={() => gate('/')} />
            </SidebarMenu>
            {/* The real list. With no project its query is disabled, so it
                renders its own empty state rather than inventing ghost rows. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ProjectSessionList projectId="" />
            </div>
          </div>
        </SidebarGroup>

        <SidebarGroup className="py-0">
          <SidebarMenu>
            <SidebarNavRow icon={FolderOpen} label="Files" onClick={() => gate('/')} />
          </SidebarMenu>
        </SidebarGroup>

        {/* Real links, so a visitor can look at each surface before signing
            up. The screens render in their empty state with actions gated. */}
        <ProjectNavGroup
          items={PROJECT_NAV_ITEMS}
          hrefFor={(item) => `/?view=${item.key}`}
          isActive={(item) => item.key === activeSection}
        />

        <SidebarGroup className="py-0">
          <SidebarMenu>
            <SidebarNavRow icon={LucideSettings} label="Settings" onClick={() => gate('/')} />
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="mt-auto py-0">
          <SidebarMenu>
            {MARKETING_LINKS.map((link) => (
              <SidebarPlainLink key={link.href} href={link.href}>
                {link.label}
              </SidebarPlainLink>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarBody>

      <SidebarFooterSlot>
        <Button type="button" size="sm" className="w-full" onClick={() => gate('/')}>
          Sign in
        </Button>
      </SidebarFooterSlot>
    </SidebarShell>
  );
}

export function AnonymousHomeShell() {
  const { gate, gateWithPrompt } = useSignInGate();
  const searchParams = useSearchParams();
  const requested = searchParams.get('view');
  const activeSection = PROJECT_NAV_ITEMS.find((item) => item.key === requested)?.key ?? null;

  return (
    <SidebarProvider>
      <AnonymousSidebar activeSection={activeSection} />
      <SidebarInset>
        <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="absolute top-2 right-2 z-20 md:hidden">
            <Button type="button" size="sm" variant="ghost" onClick={() => gate('/')}>
              Sign in
            </Button>
          </div>

          {activeSection ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <AnonymousSectionTabs active={activeSection} />
              <div className="min-h-0 flex-1">
                <AnonymousSectionPreview section={activeSection} />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-4.5">
              {/* The same body the project home renders — heading, composer slot,
              starter chips — with no project behind it. */}
              <ProjectHomeWelcomeBody
                projectId=""
                heading="What do you want to get done?"
                setupTiles={false}
                composer={
                  <ComposerChatInput
                    projectId={undefined}
                    onSend={(text) => gateWithPrompt(text)}
                    onCommand={() => gate('/')}
                    clearOnSend={false}
                    autoFocus
                    cardClassName="rounded-xl"
                    placeholder="Ask anything…"
                  />
                }
                onPickSuggestion={() => gate('/')}
              />

              <nav className="text-muted-foreground flex flex-wrap items-center justify-center gap-4 pb-4 text-xs md:hidden">
                {MARKETING_LINKS.map((link) => (
                  <Link key={link.href} href={link.href} className="hover:text-foreground">
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default AnonymousHomeShell;
