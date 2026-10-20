'use client';

import Hint from '../../../primitives/hint';
import { BrainIcon as Brain, EyeIcon as Eye, WrenchIcon as Wrench } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';

const ICON_CLASS = 'text-muted-foreground/50 size-3.5 shrink-0';

/**
 * Compact capability chips — reasoning / tool-calling / vision — mirrored
 * verbatim from models.dev. Takes the three flags rather than a model object
 * so it serves every catalog shape that carries them; renders nothing when a
 * model declares no capabilities.
 */
export function ModelCapabilityIcons({
  reasoning,
  toolCall,
  vision,
  chips = false,
}: {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  /** Each glyph on its own small filled tile (the Models tab rows). */
  chips?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (!reasoning && !toolCall && !vision) return null;
  const items = [
    reasoning && { key: 'reasoning', label: tI18nComplete.raw('textd8211e24e83d'), Icon: Brain },
    toolCall && { key: 'tools', label: tI18nComplete.raw('text10d67f48de99'), Icon: Wrench },
    vision && { key: 'vision', label: tI18nComplete.raw('text1f7ad27866ae'), Icon: Eye },
  ].filter((item): item is { key: string; label: string; Icon: typeof Brain } => !!item);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {items.map(({ key, label, Icon }) => (
        <Hint key={key} label={label} side="bottom">
          {chips ? (
            <span
              data-capability={key}
              className="bg-muted flex size-5 shrink-0 items-center justify-center rounded-sm"
            >
              <Icon className="text-muted-foreground size-3 shrink-0" />
            </span>
          ) : (
            <Icon className={ICON_CLASS} />
          )}
        </Hint>
      ))}
    </div>
  );
}
