'use client';

import { lazyClient } from '../lib/lazy-client';
import { TrashIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import type { EmojiSelection } from './emoji-picker';
import type { GlyphSelection } from './glyph-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { cn } from '../lib/utils';

/**
 * Icons and Emojis side by side, one popover. Icons is the default tab.
 *
 * `EmojiPicker` is rendered exactly as `emoji-picker.tsx` exports it — no
 * extra props, no wrapper markup around it. frimousse owns its search field
 * as a compound child of `Frimousse.Root`; pulling that state out to share one
 * search box across both tabs would mean either forking frimousse's internals
 * or reimplementing emoji search from scratch. Two independent search fields,
 * one per tab, is the tradeoff this component makes instead.
 *
 * The Icon tab owns `color` — the colour a NEW glyph pick will carry, not a
 * property of any already-chosen icon — so it lives here, in the wrapper that
 * outlives a single tab switch, rather than inside `GlyphPicker` itself,
 * which would reset it every time the tab remounts.
 *
 * Radix only mounts the ACTIVE `TabsContent` (`Presence` gates on
 * `forceMount || isSelected`), so switching to Icon is also the first moment
 * `GlyphPicker` renders — cheap, since unlike `EmojiPicker` it fetches
 * nothing.
 */
/**
 * The two panels load on demand. The settings panel is mounted on every
 * project page (project-shell.tsx) and renders this picker through
 * ProjectIconField, so static imports put frimousse and the 202-glyph
 * registry in the project home's largest chunk (338 KB decoded on dev,
 * 2026-09-27) for a popover almost nobody opens. The placeholder has both
 * panels' exact geometry (`h-[388px] w-full`), so the popover never resizes
 * when a panel arrives; `preloadProjectIconPicker` fetches them before the
 * popover opens.
 */
const loadEmojiPicker = () => import('./emoji-picker');
const loadGlyphPicker = () => import('./glyph-picker');

function PanelPlaceholder() {
  return <div aria-busy="true" className="h-[388px] w-full" />;
}

const EmojiPicker = lazyClient(() => loadEmojiPicker().then((m) => m.EmojiPicker), {
  fallback: <PanelPlaceholder />,
});
const GlyphPicker = lazyClient(() => loadGlyphPicker().then((m) => m.GlyphPicker), {
  fallback: <PanelPlaceholder />,
});

/** Start fetching both panels; safe to call repeatedly. */
export function preloadProjectIconPicker(): void {
  void loadEmojiPicker();
  void loadGlyphPicker();
}

export function ProjectIconPicker({
  onEmojiSelect,
  onGlyphSelect,
  defaultTab = 'icon',
  defaultColor = 'grey',
  selectedGlyph,
  onRemove,
  removeLabel = 'Remove icon',
  className,
}: {
  onEmojiSelect: (emoji: EmojiSelection) => void;
  onGlyphSelect: (glyph: GlyphSelection) => void;
  defaultTab?: 'emoji' | 'icon';
  defaultColor?: string;
  /** The glyph the project wears now. A colour change re-commits it in the new
   *  colour, so the trigger recolours live whichever you pick first. */
  selectedGlyph?: string;
  /** Present only when there is an icon to take off: draws the trash button
   *  at the right end of the tab header. */
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}) {
  const [color, setColor] = useState(defaultColor);
  const changeColor = (next: string) => {
    setColor(next);
    if (selectedGlyph) onGlyphSelect({ name: selectedGlyph, color: next });
  };

  // Icons first and open by default: a project icon is usually a coloured
  // glyph, and the Kortix marks lead that grid.
  return (
    <Tabs defaultValue={defaultTab} className={cn('w-full gap-0', className)}>
      <div className="relative">
        <TabsList type="underline" className="h-10 w-full justify-start gap-5 px-4">
          <TabsTrigger value="icon" className="flex-none px-0 text-sm font-medium">
            Icons
          </TabsTrigger>
          <TabsTrigger value="emoji" className="flex-none px-0 text-sm font-medium">
            Emojis
          </TabsTrigger>
        </TabsList>
        {onRemove ? (
          <button
            type="button"
            aria-label={removeLabel}
            title={removeLabel}
            onClick={onRemove}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-foreground/6 absolute top-1/2 right-2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md',
              'transition-[color,background-color,scale] duration-fast active:scale-[0.94]',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            <TrashIcon weight="fill" className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Both panels are the same fixed height (PANEL_HEIGHT in each file),
          so the popover never resizes on a tab switch. */}
      <TabsContent value="icon">
        <GlyphPicker
          color={color}
          selected={selectedGlyph}
          onColorChange={changeColor}
          onGlyphSelect={onGlyphSelect}
        />
      </TabsContent>
      <TabsContent value="emoji">
        <EmojiPicker onEmojiSelect={onEmojiSelect} />
      </TabsContent>
    </Tabs>
  );
}
