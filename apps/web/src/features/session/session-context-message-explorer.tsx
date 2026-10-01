'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';
import type { MessageWithParts } from '@/ui/types';
import type { Message, Part } from '@kortix/sdk';
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Copy } from '../icon/icons/copy';

type Formatter = { time: (value: number | undefined) => string };

// ============================================================================
// Copy-all button (header action)
// ============================================================================

export function CopyAllButton({
  messages,
  copyLabel,
  copiedLabel,
}: {
  messages: MessageWithParts[] | undefined;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    // Stringify on click only — never during render.
    navigator.clipboard.writeText(JSON.stringify(messages ?? [], null, 2));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [messages]);

  return (
    <Button
      onClick={handleCopy}
      variant="outline"
      size="sm"
      className="gap-1.5 transition-colors active:scale-[0.97]"
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        {copied ? <CheckIcon className="text-kortix-green size-4" /> : <Copy className="size-4" />}
      </span>
      {copied ? copiedLabel : copyLabel}
    </Button>
  );
}

// ============================================================================
// Raw message accordion item
// ============================================================================

/** Stringifies only while its accordion item is open — Radix unmounts closed content. */
function RawMessageJson({ message, parts }: { message: Message; parts: Part[] }) {
  const json = useMemo(() => JSON.stringify({ message, parts }, null, 2), [message, parts]);
  return (
    <div className="relative">
      <pre className="bg-muted/40 max-h-[400px] overflow-x-auto overflow-y-auto rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">
        {json}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton code={json} size="sm" />
      </div>
    </div>
  );
}

const RawMessage = memo(function RawMessage({
  message,
  parts,
  formatTime,
}: {
  message: Message;
  parts: Part[];
  formatTime: Formatter['time'];
}) {
  return (
    <AccordionItem
      value={message.id}
      className="border-b-0 [contain-intrinsic-size:auto_37px] [content-visibility:auto]"
    >
      <AccordionTrigger className="hover:bg-muted/40 rounded-md px-3 py-2 text-xs hover:no-underline">
        <div className="flex w-full items-center justify-between gap-2 pr-2">
          <div className="min-w-0 truncate font-mono">
            <Badge
              variant={message.role === 'user' ? 'info' : 'success'}
              size="sm"
              className="mr-2 font-semibold uppercase"
            >
              {message.role}
            </Badge>
            <span className="text-muted-foreground">{message.id}</span>
          </div>
          <div className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">
            {formatTime(message.time?.created)}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-2">
        <RawMessageJson message={message} parts={parts} />
      </AccordionContent>
    </AccordionItem>
  );
});

/** Preserve the raw explorer's role and case-insensitive ID/text search. */
export function filterRawMessages(
  messages: MessageWithParts[] | undefined,
  rawRole: 'all' | 'user' | 'assistant',
  deferredRawQuery: string,
) {
  let list = messages ?? [];
  if (rawRole !== 'all') list = list.filter((m) => m.info.role === rawRole);
  const query = deferredRawQuery.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (m) =>
        m.info.id.toLowerCase().includes(query) ||
        m.parts.some(
          (p) =>
            typeof (p as any).text === 'string' && (p as any).text.toLowerCase().includes(query),
        ),
    );
  }
  return list;
}

export function SessionContextMessageExplorer({
  messages,
  formatTime,
  count,
}: {
  messages: MessageWithParts[] | undefined;
  formatTime: Formatter['time'];
  count: number;
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const [rawOpen, setRawOpen] = useState(false);
  // Sticky: once true, the row list stays mounted so reopening is instant.
  const [rawMounted, setRawMounted] = useState(false);
  const handleRawOpenChange = useCallback((open: boolean) => {
    setRawOpen(open);
    // Mount the heavy row list in a non-urgent render so the trigger's own
    // state flip paints first and the click never feels stuck.
    if (open) startTransition(() => setRawMounted(true));
  }, []);

  const [rawQuery, setRawQuery] = useState('');
  // Keystrokes stay urgent; filtering the full message list runs deferred.
  const deferredRawQuery = useDeferredValue(rawQuery);
  const [rawRole, setRawRole] = useState<'all' | 'user' | 'assistant'>('all');

  const filteredRawMessages = useMemo(
    () => filterRawMessages(messages, rawRole, deferredRawQuery),
    [messages, rawRole, deferredRawQuery],
  );

  return (
    <>
      {/* Raw message data — collapsed by default, paginated. The content is a
            plain hidden div rather than an animated DisclosureContent: animating
            height over 30 fresh accordion rows is what caused the open lag, and
            keeping the rows mounted after the first open makes reopening a pure
            display flip. */}
      <Disclosure
        variant="outline"
        className="overflow-hidden"
        open={rawOpen}
        onOpenChange={handleRawOpenChange}
      >
        <DisclosureTrigger variant="outline">
          <Button
            variant="popover"
            className="flex w-full items-center justify-between rounded-none px-4"
          >
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium">{t.raw('rawLabel')}</span>
              <Badge variant="muted" size="sm" className="tabular-nums">
                {count}
              </Badge>
            </span>
            <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </DisclosureTrigger>
        <div hidden={!rawOpen} className="border-border border-t">
          {rawMounted ? (
            <>
              <p className="text-muted-foreground px-4 pt-3 text-xs">{t.raw('rawDescription')}</p>
              <div className="flex flex-col gap-2 px-4 pt-3 sm:flex-row sm:items-center">
                <InputGroupSearch className="flex-1">
                  <InputGroupSearchIcon>
                    <MagnifyingGlassIcon />
                  </InputGroupSearchIcon>
                  <InputGroupSearchInput
                    placeholder={t.raw('rawSearchPlaceholder')}
                    value={rawQuery}
                    onChange={(e) => setRawQuery(e.target.value)}
                    variant="popover"
                  />
                  <InputGroupSearchClear onClick={() => setRawQuery('')} />
                </InputGroupSearch>
                <Tabs
                  value={rawRole}
                  onValueChange={(value) => setRawRole(value as typeof rawRole)}
                  className="w-fit"
                >
                  <TabsListCompact type="default">
                    <TabsTriggerCompact value="all">{t.raw('rawFilterAll')}</TabsTriggerCompact>
                    <TabsTriggerCompact value="user">{t.raw('rawFilterUser')}</TabsTriggerCompact>
                    <TabsTriggerCompact value="assistant">
                      {t.raw('rawFilterAssistant')}
                    </TabsTriggerCompact>
                  </TabsListCompact>
                </Tabs>
              </div>
              {filteredRawMessages.length === 0 ? (
                <p className="text-muted-foreground px-4 py-6 text-center text-xs">
                  {t.raw('rawNoMatches')}
                </p>
              ) : (
                // Every matching message, not a first page behind a "Show
                // more" click — each closed row is `content-visibility:auto`
                // (see RawMessage below), so the browser skips layout/paint
                // for whatever is off-screen and rendering the full list up
                // front costs nothing more than rendering 30 of it did.
                <Accordion type="multiple" className="px-2 py-2">
                  {filteredRawMessages.map((msg) => (
                    <RawMessage
                      key={msg.info.id}
                      message={msg.info}
                      parts={msg.parts}
                      formatTime={formatTime}
                    />
                  ))}
                </Accordion>
              )}
            </>
          ) : null}
        </div>
      </Disclosure>
    </>
  );
}
