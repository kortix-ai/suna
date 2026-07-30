'use client';

import { useTranslations } from 'next-intl';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { useIsMobile } from '@/hooks/utils';
import { CoinsIcon as Coins } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface HelpSearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HelpPage {
  title: string;
  description: string;
  url: string;
  category: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string[];
}

const helpPages: HelpPage[] = [
  {
    title: 'What are Credits?',
    description: 'Learn about credit types, how they are consumed, and pricing',
    url: '/credits-explained',
    category: 'Billing & Usage',
    icon: Coins,
    keywords: [
      'credits',
      'billing',
      'pricing',
      'costs',
      'usage',
      'expiring',
      'non-expiring',
      'subscription',
    ],
  },
];

export function HelpSearchModal({ open, onOpenChange }: HelpSearchModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [search, setSearch] = useState('');
  const router = useRouter();
  const isMobile = useIsMobile();

  const filtered = search
    ? helpPages.filter((page) => {
        const searchLower = search.toLowerCase();
        return (
          page.title.toLowerCase().includes(searchLower) ||
          page.description.toLowerCase().includes(searchLower) ||
          page.category.toLowerCase().includes(searchLower) ||
          page.keywords?.some((keyword) => keyword.includes(searchLower))
        );
      })
    : helpPages;

  const groupedPages = filtered.reduce(
    (acc, page) => {
      if (!acc[page.category]) {
        acc[page.category] = [];
      }
      acc[page.category].push(page);
      return acc;
    },
    {} as Record<string, HelpPage[]>,
  );

  const handleSelect = (url: string) => {
    onOpenChange(false);
    setSearch('');
    router.push(url);
  };

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background max-w-2xl overflow-hidden p-0">
        <Command className="bg-background border-0" shouldFilter={false}>
          <div className="border-b px-4 py-3">
            <CommandInput
              placeholder={tHardcodedUi.raw(
                'componentsHelpHelpSearchModal.line84JsxAttrPlaceholderSearchHelpCenter',
              )}
              value={search}
              onValueChange={setSearch}
              className="px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <CommandList className="max-h-[400px] p-3">
            <CommandEmpty className="text-muted-foreground py-6 text-center text-sm">
              {tHardcodedUi.raw('componentsHelpHelpSearchModal.line92JsxTextNoHelpArticlesFound')}
            </CommandEmpty>
            {Object.entries(groupedPages).map(([category, pages]) => (
              <CommandGroup key={category} heading={category} className="mb-4">
                <div className="mt-2 space-y-1.5">
                  {pages.map((page) => {
                    const Icon = page.icon;
                    return (
                      <CommandItem
                        key={page.url}
                        value={page.title}
                        onSelect={() => handleSelect(page.url)}
                        className="rounded-2xl p-0"
                      >
                        <SpotlightCard className="w-full cursor-pointer">
                          <div className="flex items-start gap-3 px-3 py-2.5">
                            <div className="bg-muted border-border mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border">
                              <Icon className="text-muted-foreground h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{page.title}</div>
                              <div className="text-muted-foreground line-clamp-1 text-xs">
                                {page.description}
                              </div>
                            </div>
                          </div>
                        </SpotlightCard>
                      </CommandItem>
                    );
                  })}
                </div>
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
