'use client';

import { CopyButton } from '../markdown/copy-button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Disclosure, DisclosureTrigger } from '../components/ui/disclosure';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../components/ui/input-group';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../components/ui/tabs';
import { useTranslations } from '../i18n';
import type { SessionLogMessage } from '@kortix/sdk';
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
import { Copy } from '../icons/copy';

type Formatter = { time: (value: number | undefined) => string };

/** A v1 store row, as much of it as the explorer reads. */
export type RawV1Row = {
  info: { id: string; role: string; time?: { created?: number } };
  parts: ReadonlyArray<object>;
};

/** One explorer row of either source. `value` is what an opened row shows as JSON. */
export type RawRow = { id: string; role: string; created: number | undefined; value: unknown; texts: string[] };

// Keyed on the source object, which keeps its identity while unchanged, so a
// memoized row skips its render and an open row skips its stringify.
const rowCache = new WeakMap<object, RawRow>();
function cachedRow<T extends object>(source: T, build: (source: T) => RawRow): RawRow {
  let row = rowCache.get(source);
  if (!row) rowCache.set(source, (row = build(source)));
  return row;
}

const v1Row = (m: RawV1Row): RawRow => ({
  id: m.info.id,
  role: m.info.role,
  created: m.info.time?.created,
  value: { message: m.info, parts: m.parts },
  texts: m.parts.flatMap((p) => ('text' in p && typeof p.text === 'string' ? [p.text] : [])),
});

const recordRow = (m: SessionLogMessage): RawRow => ({
  id: m.message_id,
  role: m.role,
  created: Date.parse(m.created_at),
  value: m,
  texts: m.blocks.flatMap((b) => (b.type === 'text' || b.type === 'reasoning' ? [b.text] : [])),
});

/**
 * What the raw explorer lists and Copy JSON copies: the session-log records on
 * v2, else the v1 rows (each row's JSON is `{ message, parts }`, as before).
 */
export function rawExplorerData(
  source: 'v1' | 'v2' | undefined,
  records: SessionLogMessage[] | undefined,
  rows: readonly RawV1Row[] | undefined,
): { rows: RawRow[]; copy: unknown } {
  if (source === 'v2') {
    const list = records ?? [];
    return { rows: list.map((m) => cachedRow(m, recordRow)), copy: list };
  }
  const list = rows ?? [];
  return { rows: list.map((m) => cachedRow(m, v1Row)), copy: list };
}

// ============================================================================
// Copy-all button (header action)
// ============================================================================

export function CopyAllButton({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: unknown;
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
    navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [value]);

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
function RawMessageJson({ value }: { value: unknown }) {
  const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
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
  row,
  formatTime,
}: {
  row: RawRow;
  formatTime: Formatter['time'];
}) {
  return (
    <AccordionItem
      value={row.id}
      className="border-b-0 [contain-intrinsic-size:auto_37px] [content-visibility:auto]"
    >
      <AccordionTrigger className="hover:bg-muted/40 rounded-md px-3 py-2 text-xs hover:no-underline">
        <div className="flex w-full items-center justify-between gap-2 pr-2">
          <div className="min-w-0 truncate font-mono">
            <Badge
              variant={row.role === 'user' ? 'info' : 'success'}
              size="sm"
              className="mr-2 font-semibold uppercase"
            >
              {row.role}
            </Badge>
            <span className="text-muted-foreground">{row.id}</span>
          </div>
          <div className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">
            {formatTime(row.created)}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-2">
        <RawMessageJson value={row.value} />
      </AccordionContent>
    </AccordionItem>
  );
});

/** Preserve the raw explorer's role and case-insensitive ID/text search. */
export function filterRawMessages(
  rows: RawRow[] | undefined,
  rawRole: 'all' | 'user' | 'assistant',
  deferredRawQuery: string,
) {
  let list = rows ?? [];
  if (rawRole !== 'all') list = list.filter((m) => m.role === rawRole);
  const query = deferredRawQuery.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (m) =>
        m.id.toLowerCase().includes(query) ||
        m.texts.some((text) => text.toLowerCase().includes(query)),
    );
  }
  return list;
}

export function SessionContextMessageExplorer({
  rows,
  formatTime,
  count,
}: {
  rows: RawRow[];
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
    () => filterRawMessages(rows, rawRole, deferredRawQuery),
    [rows, rawRole, deferredRawQuery],
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
                  {filteredRawMessages.map((row) => (
                    <RawMessage key={row.id} row={row} formatTime={formatTime} />
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
