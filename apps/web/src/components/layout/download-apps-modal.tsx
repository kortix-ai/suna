'use client';

/**
 * "Download apps" — a full-screen surface (like the Customize overlay) that
 * advertises every way to run Kortix beyond the web app. Desktop + Local
 * Development (CLI) are available now; Chrome and Mobile are teased as coming
 * soon. Each card carries a small branded mockup for a Vercel-level feel.
 */

import { useEffect, useState } from 'react';
import { Monitor, Terminal, Smartphone, Copy, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AppleMark, WindowsMark, LinuxMark, ChromeMark } from '@/components/brand/brand-logos';
import { startDownload, desktopDownloadUrl } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const CLI_INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';

type PlatformId = 'macos' | 'windows' | 'linux';

const PLATFORMS: { id: PlatformId; label: string; Mark: React.ComponentType<{ className?: string }> }[] = [
  { id: 'macos', label: 'macOS', Mark: AppleMark },
  { id: 'windows', label: 'Windows', Mark: WindowsMark },
  { id: 'linux', label: 'Linux', Mark: LinuxMark },
];

function detectPlatform(): PlatformId {
  if (typeof window === 'undefined') return 'macos';
  const ua = window.navigator.userAgent.toLowerCase();
  const platform = (window.navigator.platform || '').toLowerCase();
  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if ((platform.includes('linux') || ua.includes('linux')) && !ua.includes('android')) return 'linux';
  return 'macos';
}

/* ─── Window-chrome dots used across the mockups ─────────────────────────── */
function Dots({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
    </div>
  );
}

/* ─── Card shell ─────────────────────────────────────────────────────────── */
function AppCard({
  icon,
  title,
  description,
  badge,
  action,
  mockup,
  tint,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  action: React.ReactNode;
  mockup: React.ReactNode;
  tint?: string;
}) {
  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-3xl border border-border/60 bg-card',
        'transition-shadow duration-300 hover:shadow-[0_8px_40px_-12px_rgba(0,0,0,0.18)]',
        tint,
      )}
    >
      <div className="flex flex-col gap-3 p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            {icon}
          </div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
          {badge && (
            <Badge variant="secondary" className="ml-auto text-[10px] font-medium">
              {badge}
            </Badge>
          )}
        </div>
        <p className="max-w-[42ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        <div className="pt-1">{action}</div>
      </div>
      {/* Mockup bleeds to the bottom edge */}
      <div className="relative mt-auto h-[150px] overflow-hidden px-6 sm:px-7">{mockup}</div>
    </div>
  );
}

/* ─── Mockups ────────────────────────────────────────────────────────────── */
function DesktopMockup() {
  return (
    <div className="absolute inset-x-6 bottom-0 top-2 translate-y-1 rounded-t-xl border border-border/60 border-b-0 bg-background shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Dots />
        <div className="ml-1 h-3 w-24 rounded bg-muted" />
      </div>
      <div className="flex h-full">
        <div className="flex w-10 flex-col items-center gap-2 border-r border-border/50 py-3">
          <KortixLogo variant="symbol" size={16} />
          <div className="size-5 rounded-md bg-muted" />
          <div className="size-5 rounded-md bg-muted/60" />
        </div>
        <div className="flex-1 space-y-2 p-3">
          <div className="ml-auto w-2/3 rounded-2xl rounded-br-sm bg-foreground/90 px-3 py-1.5 text-[9px] text-background">
            Plan my week and draft the emails
          </div>
          <div className="w-3/4 rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-[9px] text-foreground/70">
            On it — drafting 3 emails now…
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalMockup() {
  return (
    <div className="absolute inset-x-6 bottom-0 top-2 translate-y-1 overflow-hidden rounded-t-xl border border-border/60 border-b-0 bg-[#0c0c0d] shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Dots />
      </div>
      <div className="space-y-1 p-3 font-mono text-[9px] leading-relaxed text-zinc-300">
        <div>
          <span className="text-emerald-400">$</span> curl -fsSL kortix.com/install | bash
        </div>
        <div className="text-zinc-500">✓ Installed kortix</div>
        <div>
          <span className="text-emerald-400">$</span> kortix my-project
        </div>
        <div className="text-zinc-500">
          ▸ scaffolding…<span className="animate-pulse">▋</span>
        </div>
      </div>
    </div>
  );
}

function BrowserMockup() {
  return (
    <div className="absolute inset-x-6 bottom-0 top-2 translate-y-1 overflow-hidden rounded-t-xl border border-border/60 border-b-0 bg-background shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Dots />
        <div className="ml-1 flex h-4 flex-1 items-center rounded-full bg-muted px-2 text-[8px] text-muted-foreground">
          kortix.com
        </div>
      </div>
      <div className="relative p-3">
        <div className="h-2 w-1/2 rounded bg-muted" />
        <div className="mt-2 h-2 w-2/3 rounded bg-muted/60" />
        <div className="mt-3 inline-flex items-center rounded-md bg-foreground px-2 py-1 text-[8px] text-background">
          Start a return
        </div>
        <div className="absolute right-5 top-6 rounded-md bg-primary px-1.5 py-0.5 text-[8px] font-medium text-primary-foreground shadow">
          You
        </div>
      </div>
    </div>
  );
}

function MobileMockup() {
  return (
    <div className="absolute bottom-0 left-1/2 top-2 w-[112px] -translate-x-1/2 translate-y-1 overflow-hidden rounded-t-[20px] border border-border/60 border-b-0 bg-background shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="flex justify-center py-1.5">
        <div className="h-1 w-10 rounded-full bg-muted" />
      </div>
      <div className="space-y-2 px-3">
        <div className="ml-auto w-2/3 rounded-2xl rounded-br-sm bg-foreground/90 px-2 py-1 text-[8px] text-background">
          Summarize my day
        </div>
        <div className="flex items-end gap-1 pt-1">
          {[5, 9, 6, 11, 7, 12, 8].map((h, i) => (
            <div key={i} className="w-2 rounded-sm bg-primary/70" style={{ height: h * 3 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DownloadAppsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [platformId, setPlatformId] = useState<PlatformId>('macos');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setPlatformId(detectPlatform());
  }, [open]);

  const primary = PLATFORMS.find((p) => p.id === platformId)!;
  const others = PLATFORMS.filter((p) => p.id !== platformId);

  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(CLI_INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none">
        {/* Desktop title-bar strip so the close button / content clears the OS
            window controls. No-op on the web. */}
        <div className="kx-titlebar-spacer shrink-0" data-tauri-drag-region />

        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:py-16">
            {/* Header */}
            <div className="mb-10 flex flex-col items-center text-center sm:mb-14">
              <KortixLogo variant="symbol" size={34} className="mb-5" />
              <DialogTitle className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Do more with Kortix, everywhere you work
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
                Run Kortix natively, in your terminal, in your browser, and on the go.
              </DialogDescription>
            </div>

            {/* Cards */}
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {/* Desktop — available */}
              <AppCard
                icon={<Monitor className="size-4.5" />}
                title="Desktop"
                description="Chat, cowork, and code in one app. Kortix runs natively with your files, apps, and browser tabs."
                tint="bg-gradient-to-b from-muted/40 to-card"
                action={
                  <div className="flex flex-col items-start gap-2.5">
                    <Button
                      onClick={() => startDownload(desktopDownloadUrl(primary.id))}
                      className="rounded-xl"
                    >
                      <primary.Mark className="size-4 mr-1.5" />
                      Download for {primary.label}
                    </Button>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className="text-[11px]">Also for</span>
                      {others.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          title={p.label}
                          onClick={() => startDownload(desktopDownloadUrl(p.id))}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
                        >
                          <p.Mark className="size-3.5" />
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                }
                mockup={<DesktopMockup />}
              />

              {/* Local Development — Kortix CLI, available */}
              <AppCard
                icon={<Terminal className="size-4.5" />}
                title="Local Development"
                description="Build, run, and self-host Kortix from your terminal with the Kortix CLI."
                action={
                  <button
                    type="button"
                    onClick={copyCli}
                    className="group/cmd flex w-full max-w-sm items-center justify-between gap-2 rounded-2xl border border-border/60 bg-muted/50 px-3 py-2 text-left font-mono text-[11px] text-foreground transition-colors hover:bg-muted"
                    title="Click to copy"
                  >
                    <span className="truncate">{CLI_INSTALL_CMD}</span>
                    {copied ? (
                      <Check className="size-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5 shrink-0 text-muted-foreground group-hover/cmd:text-foreground" />
                    )}
                  </button>
                }
                mockup={<TerminalMockup />}
              />

              {/* Chrome — coming soon */}
              <AppCard
                icon={<ChromeMark className="size-[18px]" />}
                title="Chrome"
                description="Kortix navigates, clicks buttons, and fills out forms right inside your browser."
                badge="Coming soon"
                action={
                  <Button variant="outline" className="rounded-xl" disabled>
                    Coming soon
                  </Button>
                }
                mockup={<BrowserMockup />}
              />

              {/* Mobile — coming soon */}
              <AppCard
                icon={<Smartphone className="size-4.5" />}
                title="Mobile"
                description="Chat hands-free, connect your favorite apps, and kick off tasks on the go."
                badge="Coming soon"
                action={
                  <Button variant="outline" className="rounded-xl" disabled>
                    Coming soon
                  </Button>
                }
                mockup={<MobileMockup />}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
