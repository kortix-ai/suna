'use client';

import { useEffect, useState, useMemo, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Frown, Loader2 } from 'lucide-react';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { ThreadIcon } from './thread-icon';
import { useThreads } from '@/hooks/sidebar/use-sidebar';
import { useThreadSearch } from '@/hooks/threads/use-thread-search';
import { useIsMobile } from '@/hooks/utils';
import { useSidebar } from '@/components/ui/sidebar';
import { useTranslations } from 'next-intl';

interface ThreadSearchModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type ThreadWithProject = {
    threadId: string;
    projectId: string;
    projectName: string;
    url: string;
    updatedAt: string;
    iconName?: string;
    textPreview?: string;
};

// Highlight matching terms in text
function highlightText(text: string, query: string): ReactNode {
    if (!query.trim() || !text) return text;

    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return text;

    // Create regex pattern for all words
    const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const parts = text.split(pattern);

    return parts.map((part, i) => {
        const isMatch = words.some(w => part.toLowerCase() === w);
        return isMatch ? (
            <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
                {part}
            </mark>
        ) : part;
    });
}

export function ThreadSearchModal({ open, onOpenChange }: ThreadSearchModalProps) {
    const [search, setSearch] = useState('');
    const router = useRouter();
    const isMobile = useIsMobile();
    const { setOpenMobile } = useSidebar();
    const t = useTranslations('sidebar');

    const { data: threadsResponse } = useThreads({ page: 1, limit: 20 });

    const {
        results: searchResults,
        isSearching,
        shouldSearch,
    } = useThreadSearch(search, 20);

    // Process threads directly from backend data
    const combinedThreads = useMemo(() => {
        const threads = threadsResponse?.threads || [];
        if (!threads.length) return [];

        const processed: ThreadWithProject[] = [];

        for (const thread of threads) {
            const projectId = thread.project_id;
            const project = thread.project;

            if (!projectId || !project) continue;

            processed.push({
                threadId: thread.thread_id,
                projectId: projectId,
                projectName: project.name || 'Unnamed Project',
                url: `/projects/${projectId}/thread/${thread.thread_id}`,
                updatedAt: thread.updated_at || project.updated_at || new Date().toISOString(),
                iconName: project.icon_name,
            });
        }

        return processed.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
    }, [threadsResponse]);

    // Create a map for quick thread lookup by ID
    const threadMap = useMemo(() => {
        const map = new Map<string, ThreadWithProject>();
        for (const thread of combinedThreads) {
            map.set(thread.threadId, thread);
        }
        return map;
    }, [combinedThreads]);

    // Determine filtered threads based on search mode
    const filtered = useMemo(() => {
        // If using semantic search and we have results
        if (shouldSearch && searchResults.length > 0) {
            // Deduplicate by thread_id, keeping highest score and its text_preview
            const seen = new Map<string, { score: number; textPreview: string }>();
            for (const result of searchResults) {
                const existing = seen.get(result.thread_id);
                if (!existing || result.score > existing.score) {
                    seen.set(result.thread_id, {
                        score: result.score,
                        textPreview: result.text_preview
                    });
                }
            }

            // Map to thread objects with text preview
            const semanticResults: ThreadWithProject[] = [];
            for (const [threadId, data] of seen) {
                const thread = threadMap.get(threadId);
                if (thread) {
                    semanticResults.push({
                        ...thread,
                        textPreview: data.textPreview,
                    });
                }
            }
            return semanticResults;
        }

        // If searching but no results yet (still searching or no matches)
        if (shouldSearch && isSearching) {
            return [];
        }

        // Fall back to client-side filtering for short queries
        if (search) {
            return combinedThreads.filter((t) =>
                t.projectName.toLowerCase().includes(search.toLowerCase())
            );
        }

        // No search - show recent threads
        return combinedThreads.slice(0, 50);
    }, [search, shouldSearch, searchResults, isSearching, combinedThreads, threadMap]);

    const handleSelect = (url: string) => {
        onOpenChange(false);
        setSearch('');
        router.push(url);
        if (isMobile) setOpenMobile(false);
    };

    useEffect(() => {
        if (!open) setSearch('');
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl p-0 overflow-hidden bg-background" hideCloseButton>
                <VisuallyHidden>
                    <DialogTitle>Search chats</DialogTitle>
                </VisuallyHidden>
                <Command className="bg-background border-0" shouldFilter={false}>
                    <div className="px-4 py-3 border-b">
                        <div className="relative">
                            <CommandInput
                                placeholder="Search chats..."
                                value={search}
                                onValueChange={setSearch}
                                className=" px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                            />
                            {isSearching && (
                                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                </div>
                            )}
                        </div>
                    </div>
                    <CommandList className="max-h-[400px] p-3">
                        {combinedThreads.length === 0 && !search ? (
                            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                                <Frown className="h-12 w-12 text-muted-foreground/40 mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    {t('noConversations')}
                                </p>
                            </div>
                        ) : isSearching && shouldSearch ? (
                            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40 mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    Searching...
                                </p>
                            </div>
                        ) : filtered.length === 0 ? (
                            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                                No chats found
                            </CommandEmpty>
                        ) : (
                            <CommandGroup className="p-0 [&_[cmdk-group-heading]]:hidden">
                                <div className="space-y-1.5">
                                    {filtered.map((thread) => (
                                        <CommandItem
                                            key={thread.threadId}
                                            value={thread.threadId}
                                            onSelect={() => handleSelect(thread.url)}
                                            className="p-0 rounded-2xl"
                                        >
                                            <SpotlightCard className="w-full cursor-pointer">
                                                <div className="flex items-start gap-3 px-3 py-2">
                                                    <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border shrink-0 mt-0.5">
                                                        <ThreadIcon
                                                            iconName={thread.iconName}
                                                            className="text-muted-foreground"
                                                            size={16}
                                                        />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="truncate text-sm font-medium">{thread.projectName}</span>
                                                        </div>
                                                        {thread.textPreview && shouldSearch && (
                                                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                                                {highlightText(thread.textPreview.slice(0, 150), search)}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            </SpotlightCard>
                                        </CommandItem>
                                    ))}
                                </div>
                            </CommandGroup>
                        )}
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
