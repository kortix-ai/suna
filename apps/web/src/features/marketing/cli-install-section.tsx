'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { cn } from '@/lib/utils';
import { ArrowUpRight, Check, Copy, Terminal } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

const terminalLines = [
  { id: 'install', type: 'command', text: KORTIX_CLI_INSTALL_COMMAND },
  { id: 'install-done', type: 'muted', text: '✓ Installed the Kortix CLI' },
  { id: 'space-project', type: 'space', text: '' },
  { id: 'init', type: 'command', text: 'kortix init acme-ops' },
  { id: 'init-done', type: 'muted', text: '✓ Created kortix.yaml and .kortix/' },
  { id: 'space-attach', type: 'space', text: '' },
  { id: 'attach', type: 'command', text: 'kortix sessions connect <session-id>' },
  { id: 'attach-done', type: 'muted', text: '✓ Local proxy ready · opencode attach connected' },
] as const;

export function CliInstallSection() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const copyInstallCommand = useCallback(() => {
    void navigator.clipboard.writeText(KORTIX_CLI_INSTALL_COMMAND);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <section id="cli" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-16 sm:py-24 lg:px-0">
      <Reveal>
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-stretch">
          <div className="flex flex-col items-start justify-center space-y-5">
            <Badge variant="kortix" className="rounded">
              CLI
            </Badge>
            <div className="max-w-xl space-y-4">
              <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
                Install Kortix from your terminal.
              </h2>
              <p className="text-muted-foreground text-base leading-relaxed text-pretty">
                One curl installs the CLI. From there you can create a project, launch sessions, and
                attach your local OpenCode TUI to any Kortix sandbox.
              </p>
            </div>

            <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
              <Button size="lg" onClick={handleLaunch} className="sm:w-fit">
                Get started
                <HiArrowRight className="size-4" />
              </Button>
              <Button size="lg" variant="outline" asChild className="sm:w-fit">
                <Link href="/developers">
                  See CLI workflow
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="border-border bg-card overflow-hidden rounded-sm border">
            <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm">
                  <Terminal className="text-muted-foreground size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">Install the CLI</p>
                  <p className="text-muted-foreground text-xs">Copy, paste, and start locally.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={copyInstallCommand}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] inline-flex h-9 shrink-0 items-center gap-1.5 rounded-sm border px-3 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.96]"
                aria-label={copied ? 'Copied install command' : 'Copy install command'}
              >
                {copied ? (
                  <Check className="text-kortix-green size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="bg-background p-4 font-mono text-xs leading-relaxed sm:p-6 sm:text-sm">
              {terminalLines.map((line) => {
                if (line.type === 'space') return <div key={line.id} className="h-4" />;

                return (
                  <div
                    key={line.id}
                    className={cn(
                      'whitespace-pre-wrap break-all',
                      line.type === 'muted' ? 'text-muted-foreground/70' : 'text-foreground/90',
                    )}
                  >
                    {line.type === 'command' ? (
                      <>
                        <span className="text-kortix-green">$</span> {line.text}
                      </>
                    ) : (
                      line.text
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
