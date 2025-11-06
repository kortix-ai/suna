'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Coins, HelpCircle } from 'lucide-react';
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

interface HelpSearchModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

interface HelpPage {
    title: string;
    description: string;
    url: string;
    category: string;
    icon: React.ElementType;
    keywords?: string[];
}

const helpPages: HelpPage[] = [
    {
        title: 'What are Credits?',
        description: 'Learn about credit types, how they are consumed, and pricing',
        url: '/credits-explained',
        category: 'Billing & Usage',
        icon: Coins,
        keywords: ['credits', 'billing', 'pricing', 'costs', 'usage', 'expiring', 'non-expiring', 'subscription'],
    }
];

export function HelpSearchModal({ open, onOpenChange }: HelpSearchModalProps) {
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
                page.keywords?.some(keyword => keyword.includes(searchLower))
            );
        })
        : helpPages;

    const groupedPages = filtered.reduce((acc, page) => {
        if (!acc[page.category]) {
            acc[page.category] = [];
        }
        acc[page.category].push(page);
        return acc;
    }, {} as Record<string, HelpPage[]>);

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
            <DialogContent className="max-w-2xl p-0 overflow-hidden bg-background">
                <Command className="bg-background border-0" shouldFilter={false}>
                    <div className="px-4 py-3 border-b">
                        <CommandInput
                            placeholder="Search help center..."
                            value={search}
                            onValueChange={setSearch}
                            className="px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                    </div>
                    <CommandList className="max-h-[400px] p-3">
                        <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                            No help articles found
                        </CommandEmpty>
                        {Object.entries(groupedPages).map(([category, pages]) => (
                            <CommandGroup key={category} heading={category} className="mb-4">
                                <div className="space-y-1.5 mt-2">
                                    {pages.map((page) => {
                                        const Icon = page.icon;
                                        return (
                                            <CommandItem
                                                key={page.url}
                                                value={page.title}
                                                onSelect={() => handleSelect(page.url)}
                                                className="p-0 rounded-2xl"
                                            >
                                                <SpotlightCard className="w-full cursor-pointer">
                                                    <div className="flex items-start gap-3 px-3 py-2.5">
                                                        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/5 border border-primary/10 shrink-0 mt-0.5">
                                                            <Icon className="h-4 w-4 text-primary" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-sm font-medium truncate">{page.title}</div>
                                                            <div className="text-xs text-muted-foreground line-clamp-1">
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

