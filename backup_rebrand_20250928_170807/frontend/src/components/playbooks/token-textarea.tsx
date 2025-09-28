'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';

interface TokenTextareaProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function highlightTokens(value: string): string {
    const regex = /\{\{\s*([a-zA-Z0-9_\.\-]+)\s*\}\}/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(value)) !== null) {
        const [full, token] = match;
        result += escapeHtml(value.slice(lastIndex, match.index));
        const tokenDisplay = `{{${token}}}`;
        result += `<span class="text-primary/90 bg-primary/10 rounded px-0.5">${escapeHtml(tokenDisplay)}</span>`;
        lastIndex = match.index + full.length;
    }

    result += escapeHtml(value.slice(lastIndex));
    return result;
}

export const TokenTextarea: React.FC<TokenTextareaProps> = ({ value, onChange, placeholder, className }) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const highlighted = useMemo(() => highlightTokens(value), [value]);

    const syncScroll = useCallback(() => {
        if (!overlayRef.current || !textareaRef.current) return;
        overlayRef.current.scrollTop = textareaRef.current.scrollTop;
        overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }, []);

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        const handler = () => syncScroll();
        el.addEventListener('scroll', handler);
        return () => el.removeEventListener('scroll', handler);
    }, [syncScroll]);

    return (
        <div className={cn('relative', className)}>
            <div
                aria-hidden
                ref={overlayRef}
                className="pointer-events-none absolute inset-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm font-normal leading-6 text-muted-foreground whitespace-pre-wrap break-words"
                dangerouslySetInnerHTML={{ __html: highlighted || (placeholder ? escapeHtml(placeholder) : '') }}
            />
            <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="relative z-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[200px]"
            />
        </div>
    );
};


