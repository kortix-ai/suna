'use client';

import { useTranslations } from 'next-intl';
/**
 * "Download apps" — a full-screen surface (like the Customize overlay) that
 * advertises every way to run Kortix beyond the web app. Desktop + Local
 * Development (CLI) are available now; Chrome and Mobile are teased as coming
 * soon. Each card carries a small branded mockup for a Vercel-level feel.
 */

import { AppleMark, ChromeMark, LinuxMark, WindowsMark } from '@/components/brand/brand-logos';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorToast } from '@/components/ui/toast';
import { desktopDownloadUrl, startDownload } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { Check, Copy, Monitor, Smartphone, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

const CLI_INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';

type PlatformId = 'macos' | 'windows' | 'linux';

const PLATFORMS: {
  id: PlatformId;
  label: string;
  Mark: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'macos', label: 'macOS', Mark: AppleMark },
  { id: 'windows', label: 'Windows', Mark: WindowsMark },
  { id: 'linux', label: 'Linux', Mark: LinuxMark },
];

function detectPlatform(): PlatformId {
  if (typeof window === 'undefined') return 'macos';
  const ua = window.navigator.userAgent.toLowerCase();
  const platform = (window.navigator.platform || '').toLowerCase();
  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if ((platform.includes('linux') || ua.includes('linux')) && !ua.includes('android'))
    return 'linux';
  return 'macos';
}

/* ─── Window-chrome dots used across the mockups ─────────────────────────── */
function Dots({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="bg-foreground/15 size-2 rounded-full" />
      <span className="bg-foreground/15 size-2 rounded-full" />
      <span className="bg-foreground/15 size-2 rounded-full" />
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
        'group border-border/60 bg-card relative flex flex-col overflow-hidden rounded-3xl border',
        'transition-shadow duration-300 hover:shadow-[0_8px_40px_-12px_rgba(0,0,0,0.18)]',
        tint,
      )}
    >
      <div className="flex flex-col gap-3 p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-xl">
            {icon}
          </div>
          <h3 className="text-foreground text-base font-semibold tracking-tight">{title}</h3>
          {badge && (
            <Badge variant="secondary" className="ml-auto text-[10px] font-medium">
              {badge}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground max-w-[42ch] text-[13px] leading-relaxed">
          {description}
        </p>
        <div className="pt-1">{action}</div>
      </div>
      {/* Mockup bleeds to the bottom edge */}
      <div className="relative mt-auto h-[150px] overflow-hidden px-6 sm:px-7">{mockup}</div>
    </div>
  );
}

/* ─── Mockups ────────────────────────────────────────────────────────────── */
function DesktopMockup() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="border-border/60 bg-background absolute inset-x-6 top-2 bottom-0 translate-y-1 rounded-t-xl border border-b-0 shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2">
        <Dots />
        <div className="bg-muted ml-1 h-3 w-24 rounded" />
      </div>
      <div className="flex h-full">
        <div className="border-border/50 flex w-10 flex-col items-center gap-2 border-r py-3">
          <KortixLogo variant="symbol" size={16} />
          <div className="bg-muted size-5 rounded-md" />
          <div className="bg-muted/60 size-5 rounded-md" />
        </div>
        <div className="flex-1 space-y-2 p-3">
          <div className="bg-foreground/90 text-background ml-auto w-2/3 rounded-2xl rounded-br-sm px-3 py-1.5 text-[9px]">
            {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextPlanMyWeek142b5d17')}
          </div>
          <div className="bg-muted text-foreground/70 w-3/4 rounded-2xl rounded-bl-sm px-3 py-1.5 text-[9px]">
            {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextOnItDrafting85ec739b')}
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalMockup() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="border-border/60 absolute inset-x-6 top-2 bottom-0 translate-y-1 overflow-hidden rounded-t-xl border border-b-0 bg-[#0c0c0d] shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Dots />
      </div>
      <div className="space-y-1 p-3 font-mono text-[9px] leading-relaxed text-zinc-300">
        <div>
          <span className="text-emerald-400">$</span>{' '}
          {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextCurlFsSLKortix0e6a96da')}
        </div>
        <div className="text-zinc-500">
          {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextInstalledKortix44ca8439')}
        </div>
        <div>
          <span className="text-emerald-400">$</span>{' '}
          {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextKortixMyProjectdd5d950f')}
        </div>
        <div className="text-zinc-500">
          {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextScaffolding6a800c2c')}
          <span className="animate-pulse">▋</span>
        </div>
      </div>
    </div>
  );
}

function BrowserMockup() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="border-border/60 bg-background absolute inset-x-6 top-2 bottom-0 translate-y-1 overflow-hidden rounded-t-xl border border-b-0 shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2">
        <Dots />
        <div className="bg-muted text-muted-foreground ml-1 flex h-4 flex-1 items-center rounded-full px-2 text-[8px]">
          kortix.com
        </div>
      </div>
      <div className="relative p-3">
        <div className="bg-muted h-2 w-1/2 rounded" />
        <div className="bg-muted/60 mt-2 h-2 w-2/3 rounded" />
        <div className="bg-foreground text-background mt-3 inline-flex items-center rounded-md px-2 py-1 text-[8px]">
          {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextStartAReturne3430bb5')}
        </div>
        <div className="bg-primary text-primary-foreground absolute top-6 right-5 rounded-md px-1.5 py-0.5 text-[8px] font-medium shadow">
          You
        </div>
      </div>
    </div>
  );
}

// Real app screenshots (the same assets used on the marketing site), fanned as
// a phone trio that bleeds off the bottom edge like the other mockups.
const MOBILE_SHOTS = [
  { src: '/images/mobile-app/app-2.png', cls: 'mt-5 w-[74px] hidden sm:block' },
  { src: '/images/mobile-app/app-1.png', cls: 'w-[96px] z-10' },
  { src: '/images/mobile-app/app-3.png', cls: 'mt-5 w-[74px] hidden sm:block' },
];

function MobileMockup() {
  return (
    <div className="absolute inset-x-0 top-2 bottom-0 flex translate-y-1 items-start justify-center gap-2.5">
      {MOBILE_SHOTS.map((shot) => (
        <span
          key={shot.src}
          className={cn(
            'border-border/60 bg-background block shrink-0 overflow-hidden rounded-t-[20px] border border-b-0 shadow-[0_-1px_24px_-12px_rgba(0,0,0,0.3)]',
            shot.cls,
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shot.src} alt="Kortix mobile app" className="block w-full" />
        </span>
      ))}
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [platformId, setPlatformId] = useState<PlatformId>('macos');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setPlatformId(detectPlatform());
  }, [open]);

  const primary = PLATFORMS.find((p) => p.id === platformId) ?? PLATFORMS[0];
  const others = PLATFORMS.filter((p) => p.id !== platformId);

  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(CLI_INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      errorToast('Could not copy');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:max-w-none">
        {/* Desktop title-bar strip so the close button / content clears the OS
            window controls. No-op on the web. */}
        <div className="kx-titlebar-spacer shrink-0" data-tauri-drag-region />

        <div className="flex-1 [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:py-16">
            {/* Header */}
            <div className="mb-10 flex flex-col items-center text-center sm:mb-14">
              <KortixLogo variant="symbol" size={34} className="mb-5" />
              <DialogTitle className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
                {tI18nHardcoded.raw('autoFeaturesLayoutDownloadAppsModalJsxTextDoMoreWith33a6da8d')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground mt-3 max-w-xl text-sm sm:text-base">
                {tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxTextRunKortixNatively85de8599',
                )}
              </DialogDescription>
            </div>

            {/* Cards */}
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {/* Desktop — available */}
              <AppCard
                icon={<Monitor className="size-4.5" />}
                title="Desktop"
                description={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionChatCowork8b4379e0',
                )}
                tint={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrTintBgGradient25efe36b',
                )}
                action={
                  <div className="flex flex-col items-start gap-2.5">
                    <Button
                      onClick={() => startDownload(desktopDownloadUrl(primary.id))}
                      className="rounded-xl"
                    >
                      <primary.Mark className="mr-1.5 size-4" />
                      {tI18nHardcoded.raw(
                        'autoFeaturesLayoutDownloadAppsModalJsxTextDownloadFor926941d2',
                      )}
                      {primary.label}
                    </Button>
                    <div className="text-muted-foreground flex items-center gap-2">
                      <span className="text-[11px]">
                        {tI18nHardcoded.raw(
                          'autoFeaturesLayoutDownloadAppsModalJsxTextAlsoForff95d8c9',
                        )}
                      </span>
                      {others.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          title={p.label}
                          onClick={() => startDownload(desktopDownloadUrl(p.id))}
                          className="border-border/60 text-foreground hover:bg-muted inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition-colors"
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
                title={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrTitleLocalDevelopment31cefec4',
                )}
                description={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionBuildRun4761ab6f',
                )}
                action={
                  <button
                    type="button"
                    onClick={copyCli}
                    className="group/cmd border-border/60 bg-muted/50 text-foreground hover:bg-muted flex w-full max-w-sm items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-left font-mono text-[11px] transition-colors"
                    title={tI18nHardcoded.raw(
                      'autoFeaturesLayoutDownloadAppsModalJsxAttrTitleClickTob497d6e9',
                    )}
                  >
                    <span className="truncate">{CLI_INSTALL_CMD}</span>
                    {copied ? (
                      <Check className="size-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <Copy className="text-muted-foreground group-hover/cmd:text-foreground size-3.5 shrink-0" />
                    )}
                  </button>
                }
                mockup={<TerminalMockup />}
              />

              {/* Chrome — coming soon */}
              <AppCard
                icon={<ChromeMark className="size-[18px]" />}
                title="Chrome"
                description={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionKortixNavigates015d9350',
                )}
                badge={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrBadgeComingSoon291caabf',
                )}
                action={
                  <Button variant="outline" className="rounded-xl" disabled>
                    {tI18nHardcoded.raw(
                      'autoFeaturesLayoutDownloadAppsModalJsxTextComingSoon89fd3230',
                    )}
                  </Button>
                }
                mockup={<BrowserMockup />}
              />

              {/* Mobile — coming soon */}
              <AppCard
                icon={<Smartphone className="size-4.5" />}
                title="Mobile"
                description={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionChatHandsd5b305fb',
                )}
                badge={tI18nHardcoded.raw(
                  'autoFeaturesLayoutDownloadAppsModalJsxAttrBadgeComingSoon291caabf',
                )}
                action={
                  <Button variant="outline" className="rounded-xl" disabled>
                    {tI18nHardcoded.raw(
                      'autoFeaturesLayoutDownloadAppsModalJsxTextComingSoon89fd3230',
                    )}
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
