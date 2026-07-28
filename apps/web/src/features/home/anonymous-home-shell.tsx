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

import { ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { ProjectNavGroup } from '@/features/workspace/project-sidebar/project-nav-items';
import {
  SidebarBody,
  SidebarBrandHeader,
  SidebarFooterSlot,
  SidebarNewButton,
  SidebarPlainLink,
  SidebarSectionLabel,
  SidebarShell,
} from '@/features/workspace/project-sidebar/sidebar-chrome';
import { PROJECT_NAV_ITEMS } from '@/lib/project-nav';

const MARKETING_LINKS = [
  { label: 'Why Kortix', href: '/why' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Enterprise', href: '/enterprise' },
  { label: 'Developers', href: '/developers' },
  { label: 'Docs', href: '/docs' },
];

function AnonymousSidebar() {
  const { gate } = useSignInGate();

  return (
    <SidebarShell>
      <SidebarBrandHeader homeHref="/" />

      <SidebarBody>
        <SidebarNewButton label="New" onClick={() => gate('/')} />

        <SidebarGroup className="min-h-0 flex-1 flex-col py-0">
          <div className="flex min-h-0 flex-1 flex-col space-y-2">
            <SidebarSectionLabel className="mt-1 px-0">
              <span className="px-2">Sessions</span>
            </SidebarSectionLabel>
            {/* Honest, not ghost rows. Fake history in the one surface meant to
                be the user's own reads worse than an empty list. */}
            <p className="text-muted-foreground/70 px-2 text-sm">No sessions yet</p>
          </div>
        </SidebarGroup>

        <ProjectNavGroup items={PROJECT_NAV_ITEMS} onSelect={() => gate('/')} />

        <SidebarGroup className="mt-auto py-0.5">
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

/**
 * Textarea and send only. No model picker, no agent picker, no attachments, no
 * mentions — each of those needs a project behind it.
 */
function AnonymousComposer() {
  const { gateWithPrompt, gate } = useSignInGate();
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed) gateWithPrompt(trimmed);
    else gate('/');
  };

  return (
    <div className="w-full max-w-2xl">
      <div className="border-border bg-background focus-within:border-foreground/30 rounded-xl border p-3 transition-colors">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Ask anything…"
          aria-label="Ask anything"
          className="text-foreground placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm outline-none"
        />
        <div className="flex items-center justify-between pt-2">
          <span className="text-muted-foreground text-xs">Sign in to run this</span>
          <Button type="button" size="icon" onClick={submit} aria-label="Send">
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AnonymousHomeShell() {
  const { gate } = useSignInGate();

  return (
    <SidebarProvider>
      <AnonymousSidebar />
      <SidebarInset>
        <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5">
          <div className="absolute top-2 right-2 z-20 md:hidden">
            <Button type="button" size="sm" variant="ghost" onClick={() => gate('/')}>
              Sign in
            </Button>
          </div>

          {/* The same body the project home renders — heading, composer slot,
              starter chips — with no project behind it. */}
          <ProjectHomeWelcomeBody
            projectId=""
            heading="What do you want to get done?"
            setupTiles={false}
            composer={<AnonymousComposer />}
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
      </SidebarInset>
    </SidebarProvider>
  );
}

export default AnonymousHomeShell;
