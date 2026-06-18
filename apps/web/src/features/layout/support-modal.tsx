'use client';

import { ArrowUpRight } from '@mynaui/icons-react';
import { BookOpen } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Icon } from '@/features/icon/icon';
import { openExternalRoute } from '@/lib/desktop';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';

const SUPPORT_EMAIL = 'support@kortix.ai';
const MAILTO_SUBJECT = 'Kortix support request';

const DISCORD_URL =
  siteConfig.footerLinks.flatMap((group) => group.links).find((link) => link.title === 'Discord')
    ?.url ?? 'https://discord.com/invite/RvFhXUdZ9H';

type SupportPath = {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  external?: boolean;
  onSelect: () => void;
};

export function SupportModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const openLink = useCallback(
    (url: string, newTab = false) => {
      close();
      if (openExternalRoute(url)) return;
      if (newTab) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      router.push(url);
    },
    [close, router],
  );

  const openEmail = useCallback(() => {
    close();
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(MAILTO_SUBJECT)}`;
  }, [close]);

  const paths = useMemo<SupportPath[]>(
    () => [
      {
        id: 'email',
        title: 'Email support',
        subtitle: SUPPORT_EMAIL,
        icon: <Icon.Gmail className="size-4" />,
        onSelect: openEmail,
      },
      {
        id: 'docs',
        title: 'Read the docs',
        subtitle: 'Guides, setup, and troubleshooting',
        icon: <BookOpen className="size-4" strokeWidth={1.75} />,
        external: true,
        onSelect: () => openLink('/docs'),
      },
      {
        id: 'discord',
        title: 'Discord community',
        subtitle: 'Ask questions and share feedback',
        icon: <Icon.Discord className="size-4" />,
        external: true,
        onSelect: () => openLink(DISCORD_URL, true),
      },
    ],
    [openEmail, openLink],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full space-y-0 p-0 sm:max-w-sm">
        <SheetHeader className="border-border/40 space-y-1 border-b px-5 pt-5 pb-4">
          <SheetTitle className="text-base font-semibold">Help center</SheetTitle>
        </SheetHeader>

        <SheetBody className="gap-2 px-5 py-0.5">
          {paths.map((path) => (
            <button
              key={path.id}
              type="button"
              className={cn(
                'border-border flex w-full cursor-pointer items-center gap-3 rounded-md border p-3 text-left',
                'hover:bg-muted/40 transition-colors duration-150 ease-out',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              )}
              onClick={path.onSelect}
            >
              <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                {path.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{path.title}</p>
                <p className="text-muted-foreground/70 mt-0.5 text-xs">{path.subtitle}</p>
              </div>
              {path.external ? (
                <ArrowUpRight
                  className="text-muted-foreground size-4 shrink-0"
                  strokeWidth={1.75}
                  aria-hidden
                />
              ) : null}
            </button>
          ))}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
