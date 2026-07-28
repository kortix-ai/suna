'use client';

/**
 * The logged-out homepage: the real product shell, with every action gated.
 *
 * Deliberately NOT ProjectShell, and deliberately NOT the real composer.
 * ProjectShell is a project data root — it runs getProjectDetail,
 * useGatewayCatalogSync and BillingAccountProvider — and ComposerChatInput
 * calls useRuntimeSessions/useOpenCodeProviders, which fall back to the sandbox
 * runtime client when there is no project. Mounting either of those for an
 * anonymous visitor is a guaranteed 401 storm on every marketing visit.
 *
 * So this is a visual twin, not a reuse. anonymous-home-shell.test.tsx asserts
 * that separation stays intact.
 */

import { ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { Icon } from '@/features/icon/icon';
import { PROJECT_NAV_ITEMS } from '@/lib/project-nav';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';

const MARKETING_LINKS = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'Enterprise', href: '/enterprise' },
  { label: 'Developers', href: '/developers' },
  { label: 'Docs', href: '/docs' },
  { label: 'Why Kortix', href: '/why' },
];

function AnonymousSidebar() {
  const { gate } = useSignInGate();

  return (
    <aside className="bg-sidebar border-border hidden w-64 shrink-0 flex-col border-r md:flex">
      <div className="flex items-center gap-2 px-4 py-3">
        <Icon.Kortix className="text-foreground size-4.5" />
        <span className="text-foreground text-sm font-medium">Kortix</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        <button
          type="button"
          onClick={() => gate('/')}
          className="text-sidebar-foreground hover:bg-sidebar-accent border-border bg-background flex items-center justify-center gap-2 rounded-md border-[1.2px] px-2 py-1.5 text-sm font-medium"
        >
          New
        </button>
      </nav>

      <div className="mt-4 px-2">
        <p className="text-muted-foreground/60 px-2 pb-1 text-[11px] font-medium tracking-wider uppercase">
          Sessions
        </p>
        {/* An honest empty state. Ghost rows in the one surface meant to be the
            user's own read worse than nothing. */}
        <p className="text-muted-foreground/70 px-2 py-1 text-sm">No sessions yet</p>
      </div>

      <div className="mt-4 px-2">
        <p className="text-muted-foreground/60 px-2 pb-1 text-[11px] font-medium tracking-wider uppercase">
          Customize
        </p>
        <div className="flex flex-col">
          {PROJECT_NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => gate('/')}
              className="text-muted-foreground hover:text-sidebar-foreground rounded-md px-2 py-1 text-left text-sm"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-1 p-2">
        <div className="flex flex-col">
          {MARKETING_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:text-sidebar-foreground rounded-md px-2 py-1 text-sm"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <Button type="button" size="sm" className="w-full" onClick={() => gate('/')}>
          Sign in
        </Button>
      </div>
    </aside>
  );
}

/**
 * Textarea and send button only. No model picker, no agent picker, no
 * attachments, no mentions — every one of those needs a project.
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
    <div className="bg-background flex h-dvh min-h-0 w-full">
      <AnonymousSidebar />

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex items-center justify-end gap-2 p-3 md:hidden">
          <Button type="button" size="sm" variant="ghost" onClick={() => gate('/')}>
            Sign in
          </Button>
        </div>

        <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 px-4 py-12">
          <h1 className="text-foreground text-center text-3xl leading-tight tracking-tight text-balance sm:text-4xl">
            What do you want to get done?
          </h1>

          <AnonymousComposer />

          <div className="flex flex-wrap items-center justify-center gap-2">
            {STARTER_PROMPTS.slice(0, 6).map((prompt, index) => {
              const ChipIcon = prompt.icon;
              const chalk = chalkColors(prompt.label);
              return (
                <Button
                  key={prompt.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => gate('/')}
                  className={cn(
                    'bg-background/60 shrink-0 gap-1.5 rounded-md',
                    index >= 4 && 'max-sm:hidden',
                  )}
                >
                  <ChipIcon
                    className="size-3.5 shrink-0"
                    style={{ color: chalk.foreground }}
                    aria-hidden
                  />
                  {prompt.label}
                </Button>
              );
            })}
          </div>
        </div>

        <nav className="text-muted-foreground flex flex-wrap items-center justify-center gap-4 p-4 text-xs md:hidden">
          {MARKETING_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}

export default AnonymousHomeShell;
