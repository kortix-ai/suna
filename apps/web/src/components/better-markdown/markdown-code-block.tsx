"use client";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks/use-copy";
import { useHighlightedCode } from "@/lib/shiki";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";

const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  ts: "typescript",
  yml: "yaml",
  txt: "text",
  plaintext: "text",
  md: "markdown",
};

const normalizeLanguage = (language?: string): string => {
  if (!language) return "";

  const normalizedLanguage = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage;
};

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
  autoScrollToBottom?: boolean;
  showCopyButton?: boolean;
  showHeader?: boolean;
}

export function CodeBlock({
  code,
  language,
  className,
  autoScrollToBottom = false,
  showCopyButton = true,
  showHeader = true,
}: CodeBlockProps) {
  const normalizedLanguage = useMemo(() => normalizeLanguage(language), [language]);
  const hasLanguageLabel = Boolean(language?.trim());
  const highlightedHtml = useHighlightedCode({
    code,
    language: normalizedLanguage,
    showBackgroundColors: false,
    theme: {
      dark: "plastic",
      light: "slack-ochin",
    },
  });
  const { copied, copy } = useCopy();
  const highlightedScrollRef = useRef<HTMLDivElement | null>(null);
  const preScrollRef = useRef<HTMLPreElement | null>(null);

  useLayoutEffect(() => {
    if (!autoScrollToBottom) return;
    const el = highlightedHtml ? highlightedScrollRef.current : preScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScrollToBottom, code, highlightedHtml]);

  const languageLabel = hasLanguageLabel ? (showHeader ? normalizedLanguage : null) : null;

  return (
    <div
      className={cn(
        "group bg-sidebar-accent text-muted-foreground dark:bg-card relative w-full overflow-hidden rounded-lg",
        className,
      )}
    >
      {languageLabel ? (
        <div className="border-b-primary/10 flex items-center justify-between gap-2 border-b border-dashed py-[0.2rem] ps-4 pe-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {languageLabel}
          </span>
          {showCopyButton && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => copy(code)}
              className="rounded-md"
              aria-label={copied ? "Code copied to clipboard" : "Copy code to clipboard"}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="text-muted-foreground size-3.5" />
              )}
            </Button>
          )}
        </div>
      ) : (
        showCopyButton && (
          <div className="absolute top-2 right-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={() => copy(code)}
              className="rounded-md"
              aria-label={copied ? "Code copied to clipboard" : "Copy code to clipboard"}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="text-muted-foreground size-3.5" />
              )}
            </Button>
          </div>
        )
      )}

      {highlightedHtml ? (
        <div
          ref={highlightedScrollRef}
          className={cn(
            "max-h-[520px] overflow-auto p-4 font-mono text-sm",
            "text-muted-foreground [&_.shiki]:!bg-transparent [&_.shiki]:!p-0",
            "[&_pre]:!bg-transparent [&_pre]:!p-0",
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre ref={preScrollRef} className="max-h-[520px] overflow-auto p-4 font-mono text-sm">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
