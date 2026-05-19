'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki/bundle/web';
import { cn } from '../../lib/utils';
import { Check } from 'lucide-react';
import { Copy } from 'lucide-react';

export type CodeLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'bash'
  | 'shell'
  | 'python'
  | 'rust'
  | 'sql'
  | 'yaml'
  | 'markdown'
  | 'html'
  | 'css'
  | 'text';

export interface CodeTab {
  value: string;
  label: string;
  language: CodeLanguage | string;
  code: string;
  filename?: string;
}

interface CodeBlockProps {
  code: string;
  language: CodeLanguage | string;
  filename?: string;
  className?: string;
  copyable?: boolean;
  /** Tone forces a specific themed background, ignoring filename/copyable header chrome */
  bare?: boolean;
}

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'vesper';

async function highlight(code: string, lang: string): Promise<string> {
  return codeToHtml(code, {
    lang: normalizeLang(lang),
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: false,
  });
}

function normalizeLang(l: string): string {
  switch (l) {
    case 'sh':
    case 'zsh':
      return 'shell';
    case 'js':
      return 'javascript';
    case 'ts':
      return 'typescript';
    case 'py':
      return 'python';
    default:
      return l;
  }
}

export function CodeBlock({
  code,
  language,
  filename,
  className,
  copyable = true,
  bare = false,
}: CodeBlockProps) {
  const html = useShikiHtml(code, language);
  const hasHeader = !bare && (filename || copyable);

  return (
    <div
      className={cn(
        'group/cb relative overflow-hidden rounded-lg border border-border/70',
        'bg-[var(--code-bg-light)] dark:bg-[var(--code-bg-dark)]',
        '[--code-bg-light:#fafaf9] [--code-bg-dark:#08090b]',
        className,
      )}
    >
      {hasHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border/40 px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {filename ? (
              <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
                {filename}
              </span>
            ) : null}
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-muted-foreground/60">
              {normalizeLang(language)}
            </span>
          </div>
          {copyable ? <CopyButton text={code} /> : null}
        </header>
      ) : null}
      <div className="relative">
        <ShikiOutput html={html} fallback={code} padded={!bare} />
        {bare && copyable ? (
          <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-150 group-hover/cb:opacity-100">
            <CopyButton text={code} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CodeTabs({
  tabs,
  defaultValue,
  className,
}: {
  tabs: CodeTab[];
  defaultValue?: string;
  className?: string;
}) {
  const initial = defaultValue ?? tabs[0]?.value ?? '';
  const [active, setActive] = useState(initial);
  const current = tabs.find((t) => t.value === active) ?? tabs[0];
  const html = useShikiHtml(current?.code ?? '', current?.language ?? 'text');

  if (!current) return null;

  return (
    <div
      className={cn(
        'group/cb relative overflow-hidden rounded-lg border border-border/70',
        'bg-[var(--code-bg-light)] dark:bg-[var(--code-bg-dark)]',
        '[--code-bg-light:#fafaf9] [--code-bg-dark:#08090b]',
        className,
      )}
    >
      <header
        role="tablist"
        className="flex items-center justify-between gap-2 border-b border-border/40 pl-1 pr-2"
      >
        <div className="flex items-center min-w-0">
          {tabs.map((t) => {
            const isActive = t.value === active;
            return (
              <button
                key={t.value}
                role="tab"
                aria-selected={isActive}
                type="button"
                onClick={() => setActive(t.value)}
                className={cn(
                  'relative px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.16em] transition-colors',
                  isActive ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground',
                )}
              >
                {t.label}
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute bottom-0 inset-x-3 h-px origin-center transition-transform duration-200',
                    isActive ? 'bg-foreground scale-x-100' : 'bg-foreground/40 scale-x-0',
                  )}
                />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {current.filename ? (
            <span className="truncate font-mono text-[0.65rem] text-muted-foreground/70">
              {current.filename}
            </span>
          ) : null}
          <CopyButton text={current.code} />
        </div>
      </header>
      <ShikiOutput html={html} fallback={current.code} padded />
    </div>
  );
}

function useShikiHtml(code: string, language: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlight(code, language)
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);
  return html;
}

function ShikiOutput({
  html,
  fallback,
  padded,
}: {
  html: string | null;
  fallback: string;
  padded: boolean;
}) {
  const padClass = padded ? 'px-4 py-3.5' : '';
  if (html) {
    return (
      <div
        className={cn(
          'shiki-host overflow-x-auto font-mono text-[0.78rem] leading-[1.65]',
          padClass,
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre
      className={cn(
        'overflow-x-auto font-mono text-[0.78rem] leading-[1.65] text-muted-foreground',
        padClass,
      )}
    >
      {fallback}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy'}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground/70',
        'hover:bg-muted/50 hover:text-foreground transition-colors',
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-500 dark:text-emerald-400" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}
