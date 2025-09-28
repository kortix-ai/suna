'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';

interface TokenEditorProps {
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

function renderHtmlWithTokens(text: string): string {
    const regex = /\{\{\s*([a-zA-Z0-9_\.\-]+)\s*\}\}/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const [full, token] = match;
        result += escapeHtml(text.slice(lastIndex, match.index));
        const tokenDisplay = `{{${token}}}`;
        result += `<span class="token-chip">${escapeHtml(tokenDisplay)}</span>`;
        lastIndex = match.index + full.length;
    }
    result += escapeHtml(text.slice(lastIndex));
    return result || '';
}

function getCaretCharacterOffsetWithin(element: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(element);
    preRange.setEnd(range.endContainer, range.endOffset);
    return preRange.toString().length;
}

function setCaretAt(element: HTMLElement, offset: number) {
    const nodeStack: Node[] = [element];
    let charCount = 0;
    let node: Node | undefined;
    let found = false;

    while ((node = nodeStack.pop())) {
        if (node.nodeType === Node.TEXT_NODE) {
            const nextCharCount = charCount + (node.textContent?.length || 0);
            if (offset <= nextCharCount) {
                const range = document.createRange();
                const sel = window.getSelection();
                const withinNodeOffset = offset - charCount;
                range.setStart(node, withinNodeOffset);
                range.collapse(true);
                sel?.removeAllRanges();
                sel?.addRange(range);
                found = true;
                break;
            }
            charCount = nextCharCount;
        } else {
            let i = node.childNodes.length - 1;
            while (i >= 0) {
                nodeStack.push(node.childNodes[i]);
                i -= 1;
            }
        }
    }

    if (!found) {
        // Place at end
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
}

export const TokenEditor: React.FC<TokenEditorProps> = ({ value, onChange, placeholder, className }) => {
    const ref = useRef<HTMLDivElement | null>(null);
    const lastHtmlRef = useRef<string>('');

    const html = useMemo(() => renderHtmlWithTokens(value), [value]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const current = el.innerHTML;
        if (current === html) return;
        const caret = getCaretCharacterOffsetWithin(el);
        el.innerHTML = html || '';
        lastHtmlRef.current = html;
        setCaretAt(el, caret);
    }, [html]);

    const handleInput = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        // Read plain text; spans are for display only
        const text = el.innerText.replace(/\u00A0/g, ' ');
        if (text !== value) onChange(text);
    }, [onChange, value]);

    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
    }, []);

    return (
        <div
            ref={ref}
            contentEditable
            role="textbox"
            aria-multiline="true"
            data-placeholder={placeholder || ''}
            onInput={handleInput}
            onPaste={handlePaste}
            className={cn(
                'min-h-[200px] max-h-[200px] overflow-y-auto w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'whitespace-pre-wrap break-words',
                'token-editor',
                className,
            )}
            suppressContentEditableWarning
        />
    );
};

// Lightweight styles for token chips and placeholder
// Consumers inherit theme tokens.
// We avoid global CSS; rely on class selectors present on this component.
export const tokenEditorStyles = `
.token-editor .token-chip { color: var(--primary); background: color-mix(in oklab, var(--primary) 10%, transparent); border-radius: 0.25rem; padding: 0 0.125rem; }
.token-editor:empty::before { content: attr(data-placeholder); color: hsl(var(--muted-foreground)); }
`;


