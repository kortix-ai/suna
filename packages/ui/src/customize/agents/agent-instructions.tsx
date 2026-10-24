'use client';

/**
 * The Instructions tab: the description on top, then the system prompt in an
 * editor panel with Write, Preview and Split (both side by side, the default
 * where it fits). Below `lg` there is no room for two panes, so the control
 * offers Write and Preview only and a Split choice reads as Write.
 *
 * The source is set in the body font, not mono: instructions are prose a
 * person writes, and mono is for literal values only (typography.md).
 */

import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon, SparkleIcon } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useMediaQuery } from '../../internal/hooks';
import { cn } from '../../internal/lib/utils';
import { MarkdownWithFrontmatter } from '../../markdown/markdown-frontmatter';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';

type View = 'write' | 'preview' | 'split';

export function InstructionsEditor({
  value,
  onChange,
  path,
  name,
  description,
  onAskMyKortix,
  readOnly = false,
}: {
  value: string;
  onChange?: (next: string) => void;
  /** The agent's source file, shown in mono in the toolbar. */
  path: string;
  name: string;
  /** The description field, above the editor. */
  description?: ReactNode;
  /** Opens a configure thread that asks My Kortix to edit the instructions. */
  onAskMyKortix?: () => void;
  readOnly?: boolean;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const wide = useMediaQuery('(min-width: 1024px)');
  const [chosen, setChosen] = useState<View>(readOnly ? 'preview' : 'split');
  const [full, setFull] = useState(false);
  const view: View = chosen === 'split' && !wide ? 'write' : chosen;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const source = (
    <textarea
      aria-label={tPage('instructions')}
      value={value}
      readOnly={readOnly}
      placeholder={t('instructionsPlaceholder')}
      onChange={(e) => onChange?.(e.target.value)}
      className="text-foreground placeholder:text-muted-foreground block h-full w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none"
    />
  );
  const preview = (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-3">
      {value.trim() ? (
        <MarkdownWithFrontmatter content={value} />
      ) : (
        <p className="text-muted-foreground text-sm">{tPage('instructionsEmpty')}</p>
      )}
    </div>
  );

  const panel = (
    <div
      className={cn(
        'bg-background flex flex-col overflow-hidden border',
        full ? 'fixed inset-0 z-50' : 'min-h-0 flex-1 rounded-md',
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
        {readOnly ? null : (
          <Tabs value={view} onValueChange={(next) => setChosen(next as View)}>
            <TabsList aria-label={t('editorView')}>
              <TabsTrigger value="write">{t('write')}</TabsTrigger>
              <TabsTrigger value="preview">{t('preview')}</TabsTrigger>
              {wide ? <TabsTrigger value="split">{t('split')}</TabsTrigger> : null}
            </TabsList>
          </Tabs>
        )}
        {onAskMyKortix ? (
          <Button variant="ghost" size="sm" onClick={onAskMyKortix} className="gap-1.5">
            <SparkleIcon className="size-4" />
            {t('askToEdit')}
          </Button>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-3 pr-1">
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{tPage('words', { count: words })}</span>
          <span className="text-muted-foreground hidden min-w-0 truncate font-mono text-xs sm:block">{path}</span>
          <Hint label={full ? t('exitFullScreen') : t('fullScreen')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={full ? t('exitFullScreen') : t('fullScreen')}
              onClick={() => setFull((v) => !v)}
            >
              {full ? <ArrowsInSimpleIcon className="size-4" /> : <ArrowsOutSimpleIcon className="size-4" />}
            </Button>
          </Hint>
        </div>
      </div>
      <div className={cn('grid min-h-0 flex-1', view === 'split' && 'grid-cols-2 divide-x divide-border')}>
        {view === 'preview' ? null : <div className="min-h-0">{source}</div>}
        {view === 'write' ? null : preview}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {description}
      <section className="flex min-h-80 flex-1 flex-col gap-2">
        <h2 className="text-foreground flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {tPage('instructions')}
          <span className="text-muted-foreground text-xs font-normal">{t('instructionsHint', { name })}</span>
        </h2>
        {panel}
      </section>
    </div>
  );
}
