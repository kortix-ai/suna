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
 * What is NOT shared is the data. ProjectShell is a project data root
 * (getProjectDetail, useGatewayCatalogSync, BillingAccountProvider), and the
 * real composer reaches for useRuntimeSessions/useOpenCodeProviders, which fall
 * back to the sandbox runtime client when there is no project. Mounting either
 * for an anonymous visitor is a 401 on every marketing visit. So the chrome is
 * reused and the contents are stubbed — an honest empty session list, a
 * textarea instead of the full composer, and a sign-in gate on every action.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { FolderOpen, Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { AnonymousSectionPreview } from '@/features/home/anonymous-section-preview';
import { AnonymousSectionTabs } from '@/features/home/anonymous-section-tabs';
import { DelegateShowcase } from '@/features/home/delegate-showcase';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { ComposerChatInput } from '@/features/session/composer-chat-input';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { ShellInset } from '@/features/workspace/project-layout/shell-inset';
import { ProjectNavGroup } from '@/features/workspace/project-sidebar/project-nav-items';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import {
  SidebarBody,
  SidebarBrandHeader,
  SidebarFooterSlot,
  SidebarNewButton,
  SidebarPlainLink,
  SidebarSectionLabel,
  SidebarShell,
} from '@/features/workspace/project-sidebar/sidebar-chrome';
import { PROJECT_NAV_ITEMS, type ProjectNavKey } from '@/lib/project-nav';

/** Where every gated pill/link points. Mirrors useSignInGate's target. */
const SIGN_IN_HREF = `/auth?returnUrl=${encodeURIComponent('/')}`;

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
        {/* Same label as the signed-in shell. "New" vs "New session" was one
            of the tells that these were two different apps. */}
        <SidebarNewButton label="New session" onClick={() => gate('/')} />

        <SidebarGroup className="min-h-0 flex-1 flex-col py-0">
          <div className="flex min-h-0 flex-1 flex-col space-y-2">
            <SidebarSectionLabel className="mt-1 px-0">
              <span className="px-2">Sessions</span>
            </SidebarSectionLabel>
            {/* The real list. With no project its query is disabled, so it
                renders its own empty state rather than inventing ghost rows. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ProjectSessionList projectId="" />
            </div>
          </div>
        </SidebarGroup>

        {/* Real links, so a visitor can look at each surface before signing
            up. The screens render in their empty state with actions gated. */}
        <ProjectNavGroup
          items={PROJECT_NAV_ITEMS}
          hrefFor={(item) => `/?view=${item.key}`}
          isActive={(item) => item.key === activeSection}
        />

        {/* Files and Settings sit exactly where the signed-in shell puts them,
            gated like everything else. Omitting them left a visibly shorter
            sidebar than the real one. */}
        <SidebarGroup className="mt-auto py-0.5">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => gate('/')}
                tooltip="Files"
                className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
              >
                <FolderOpen />
                Files
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => gate('/')}
                tooltip="Settings"
                className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
              >
                <Settings />
                Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="py-0.5">
          <SidebarSectionLabel>Product</SidebarSectionLabel>
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
        {/* The SAME inset the signed-in shell uses — background, the seam
            border against the sidebar, and the edge-peek strip. A hand-rolled
            div here is what made the two panels look different. */}
        <ShellInset>
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
                // Signed out there are no sessions, so this surface is always
                // the empty state — the showcase, not the heading.
                showcase={
                  <DelegateShowcase
                    title="Delegate work to Kortix"
                    description="Hand off a project and get finished work back — researched, built, and reviewed."
                    action={
                      <Button type="button" size="sm" onClick={() => gate('/')}>
                        Sign in
                      </Button>
                    }
                  />
                }
                // The same pill row the signed-in home shows. Every pill gates
                // to sign-in rather than pointing into a project that does not
                // exist yet — the row is part of what the product looks like,
                // so hiding it made the two shells differ.
                tileHrefFor={() => SIGN_IN_HREF}
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
        </ShellInset>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default AnonymousHomeShell;
