'use client';

import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { ChevronRight, Globe, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import {
  parseWebSearchOutput,
  type WebSearchSource,
  wsDomain,
  wsRootDomain,
} from '@/features/session/tool/shared/web-helpers';
import Link from 'next/link';

interface ResolvedWebSearchSource {
  src: WebSearchSource;
  url: string;
  hostname: string;
}

interface WebSearchDomainGroup {
  rootDomain: string;
  items: ResolvedWebSearchSource[];
}

function groupSourcesByDomain(sources: WebSearchSource[]): WebSearchDomainGroup[] {
  const map = new Map<string, ResolvedWebSearchSource[]>();
  const order: string[] = [];

  for (const src of sources) {
    const url = safeHttpUrl(src.url);
    if (!url) continue;
    const rootDomain = wsRootDomain(url);
    if (!map.has(rootDomain)) {
      map.set(rootDomain, []);
      order.push(rootDomain);
    }
    map.get(rootDomain)!.push({ src, url, hostname: wsDomain(url) });
  }

  return order.map((rootDomain) => ({ rootDomain, items: map.get(rootDomain)! }));
}

function DomainSourceGroup({ group }: { group: WebSearchDomainGroup }) {
  const count = group.items.length;

  return (
    <Disclosure open variant="outline" className="group rounded-md">
      <DisclosureTrigger className="overflow-hidden rounded-md">
        <div className="group-data-[state=closed]:hover:bg-accent flex w-full cursor-pointer items-center justify-between p-3 transition-colors group-data-[state=open]:bg-transparent group-data-[state=open]:hover:bg-transparent">
          <div className="flex min-w-0 items-center gap-2">
            <Globe className="text-muted-foreground size-4 shrink-0" />
            <p className="text-foreground truncate text-sm font-medium">{group.rootDomain}</p>
          </div>
          {count > 1 && (
            <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {count} result{count > 1 ? 's' : ''}
            </p>
          )}
        </div>
      </DisclosureTrigger>
      <DisclosureContent className="p-0">
        <DisclosureBody className="space-y-1 px-1 pb-2">
          {group.items.map((item) => (
            <Link
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1 transition-colors active:scale-[0.99]"
            >
              <FaviconAvatar value={item.url} size="xs" className="shrink-0" />
              <p className="text-foreground min-w-0 truncate text-sm font-medium">
                {item.src.title}
              </p>
              <p className="text-muted-foreground ml-auto min-w-0 shrink-0 truncate font-mono text-xs">
                {item.hostname}
              </p>
            </Link>
          ))}
        </DisclosureBody>
      </DisclosureContent>
    </Disclosure>
  );
}

export function WebSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  const rawOutput = part.state.status === 'completed' ? (part.state as any).output : undefined;
  const queryResults = useMemo(
    () => parseWebSearchOutput(rawOutput ?? output),
    [rawOutput, output],
  );
  const totalSources = useMemo(
    () => queryResults.reduce((n, q) => n + q.sources.length, 0),
    [queryResults],
  );
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);
  const isError = status === 'completed' && isErrorOutput(output);

  const triggerBadge =
    status === 'completed' && !isError && queryResults.length > 0
      ? queryResults.length > 1
        ? `${queryResults.length} queries`
        : totalSources > 0
          ? `${totalSources} ${totalSources === 1 ? 'source' : 'sources'}`
          : undefined
      : undefined;

  return (
    <BasicTool
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line3806JsxTextWebSearch')}
          </span>
          <span className="text-muted-foreground truncate text-xs font-medium">{query}</span>
          {triggerBadge && (
            <span className="text-primary/70 ml-auto flex-shrink-0 text-xs font-medium whitespace-nowrap">
              {triggerBadge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="web_search" />
      ) : queryResults.length > 0 ? (
        <div data-scrollable className="max-h-[400px] overflow-auto">
          {queryResults.map((qr, qi) => {
            const isMulti = queryResults.length > 1;
            const isExpanded = expandedQuery === qi;

            return (
              <div key={qi} className={cn(qi > 0 && 'border-border border-t')}>
                {isMulti && (
                  <button
                    type="button"
                    className="hover:bg-muted/30 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors"
                    onClick={() => setExpandedQuery(isExpanded ? null : qi)}
                  >
                    <Search className="text-muted-foreground/50 size-3 flex-shrink-0" />
                    <span className="text-foreground flex-1 truncate text-xs font-medium">
                      {qr.query}
                    </span>
                    {qr.sources.length > 0 && (
                      <span className="text-muted-foreground/60 flex-shrink-0 text-xs">
                        {qr.sources.length}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        'text-muted-foreground/40 size-3 flex-shrink-0 transition-transform',
                        (isExpanded || !isMulti) && 'rotate-90',
                      )}
                    />
                  </button>
                )}

                {(!isMulti || isExpanded) && (
                  <div>
                    {/* {qr.answer && (
                      <div className="mt-1 mb-2.5">
                        <p className="text-foreground/80 text-xs leading-relaxed">{qr.answer}</p>
                      </div>
                    )} */}

                    {qr.sources.length > 0 && (
                      <div className="space-y-2">
                        {groupSourcesByDomain(qr.sources).map((group) => (
                          <DomainSourceGroup key={group.rootDomain} group={group} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="web_search"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('websearch', WebSearchTool);
ToolRegistry.register('web-search', WebSearchTool);
ToolRegistry.register('web_search', WebSearchTool);
