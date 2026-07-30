'use client';

/**
 * The API call behind the control you are looking at.
 *
 * Lumen exists to show a wrapper author what to call, and until this panel
 * existed every answer lived in the source: the dialog started a session and
 * nothing on screen said which request that was. So each KaaB control carries
 * its own disclosure, showing the SDK call this app runs and the HTTP request
 * that reaches Kortix — next to the button that performs it, not in a README.
 *
 * Both blocks are copy-pasteable, and neither ever carries real credentials:
 * the bearer is always the `$KORTIX_API_KEY` placeholder and secret values are
 * never rendered at all (`src/lib/call-snippets.ts` has nowhere to put one).
 *
 * Colouring is presentation and nothing else. The tokenizer
 * (`src/lib/syntax-highlight.ts`) only ever slices the snippet, so this file
 * holds the class per token role and no logic about what a token is.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  type CallSnippetId,
  type SnippetContext,
  callSnippet,
  isCopyableHttp,
  renderHttp,
} from '@/lib/call-snippets';
import { type SnippetLanguage, type TokenKind, highlight } from '@/lib/syntax-highlight';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Code2, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function CallSnippet({
  id,
  context,
  className,
  defaultOpen = false,
}: {
  id: CallSnippetId;
  context?: SnippetContext;
  className?: string;
  defaultOpen?: boolean;
}) {
  const snippet = callSnippet(id, context ?? {});
  const http = renderHttp(snippet.http);

  return (
    <Collapsible defaultOpen={defaultOpen} className={cn('w-full', className)}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="group gap-1.5 text-muted-foreground">
          <Code2 className="size-3" />
          The API call
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-3 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{snippet.summary}</p>

          <Block label="SDK" caption="What this app runs." code={snippet.sdk} language="ts" />

          <Block
            label="HTTP"
            caption={
              isCopyableHttp(snippet.http)
                ? 'What reaches Kortix — the form to use from any language.'
                : 'Not a REST call.'
            }
            code={http}
            language="http"
            copyable={isCopyableHttp(snippet.http)}
          />

          {/* Named explicitly rather than left implicit in the body above: a
              snippet that let someone believe the browser sets `end_user_ref`
              would teach exactly the forgery the proxy refuses. */}
          {snippet.serverInjected.length > 0 && (
            <div className="rounded-md border border-brand/30 bg-brand/5 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">Added by the server, not the browser</span>
                {snippet.serverInjected.map((field) => (
                  <Badge key={field} variant="outline" className="font-mono text-[11px]">
                    {field}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <ul className="space-y-1.5">
            {snippet.notes.map((note) => (
              <li key={note} className="text-xs leading-relaxed text-muted-foreground">
                {note}
              </li>
            ))}
          </ul>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-mono">$KORTIX_API_KEY</span> is a placeholder. Nothing here ever
            renders a real key, token or secret value — the key stays on your server, and the end
            user&apos;s own token never reaches Kortix.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Colour per token role, from the theme tokens `globals.css` already defines —
 * no palette of its own, so both themes stay correct for free. The values a
 * wrapper author retypes (strings, numbers) carry the brand tint; the structure
 * they read past (braces, commas, comments) recedes.
 */
const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  punctuation: 'text-muted-foreground',
  comment: 'text-muted-foreground italic',
  keyword: 'text-brand',
  string: 'text-brand/80',
  number: 'text-brand/70',
  property: 'text-foreground',
  method: 'text-brand font-medium',
  path: 'text-foreground',
};

function Block({
  label,
  caption,
  code,
  language,
  copyable = true,
}: {
  label: string;
  caption: string;
  code: string;
  language: SnippetLanguage;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success(`${label} call copied`);
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          {label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{caption}</span>
        {copyable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy the ${label} call`}
            onClick={copy}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        )}
      </div>
      {copyable ? (
        <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 text-[11px] leading-relaxed text-foreground/80 scrollbar-thin">
          {/* Spans are slices of `code` in order — the copy button above still
              writes `code` itself, so what lands in an editor is byte for byte
              what this block shows (src/lib/syntax-highlight.ts). */}
          <code>
            {highlight(code, language).map((token, i) => (
              <span key={i} className={TOKEN_CLASS[token.kind]}>
                {token.text}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        // Prose, not a code block: there is no path to copy, and printing one
        // would teach hand-rolling the runtime transport the SDK owns.
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{code}</p>
      )}
    </div>
  );
}
