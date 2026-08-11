'use client';

import { useState } from 'react';

import { EmojiPicker, type EmojiSelection } from '@/components/ui/emoji-picker';
import { GlyphPicker, type GlyphSelection } from '@/components/ui/glyph-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Emoji and Icon side by side, one popover.
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
export function WorkspaceIconPicker({
  onEmojiSelect,
  onGlyphSelect,
  defaultTab = 'emoji',
  defaultColor = 'grey',
  className,
}: {
  onEmojiSelect: (emoji: EmojiSelection) => void;
  onGlyphSelect: (glyph: GlyphSelection) => void;
  defaultTab?: 'emoji' | 'icon';
  defaultColor?: string;
  className?: string;
}) {
  const [color, setColor] = useState(defaultColor);

  return (
    <Tabs defaultValue={defaultTab} className={cn('w-full gap-0', className)}>
      <div className="border-border/60 border-b p-1">
        <TabsList className="w-full">
          <TabsTrigger value="emoji">Emoji</TabsTrigger>
          <TabsTrigger value="icon">Icon</TabsTrigger>
        </TabsList>
      </div>

      {/* Both panels carry the emoji grid's exact geometry (GlyphPicker's own
          h-[368px], 9-column grid) so the popover around this component never
          resizes on tab switch — see workspace-icon-field.tsx's popover width
          comment for the full width derivation. */}
      <TabsContent value="emoji">
        <EmojiPicker onEmojiSelect={onEmojiSelect} />
      </TabsContent>
      <TabsContent value="icon">
        <GlyphPicker color={color} onColorChange={setColor} onGlyphSelect={onGlyphSelect} />
      </TabsContent>
    </Tabs>
  );
}
