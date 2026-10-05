'use client';

import Hint from '@/components/ui/hint';
import { BrainIcon as Brain, EyeIcon as Eye, WrenchIcon as Wrench } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

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
}: {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (!reasoning && !toolCall && !vision) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {reasoning && (
        <Hint label={tI18nComplete.raw('textd8211e24e83d')}>
          <Brain className={ICON_CLASS} />
        </Hint>
      )}
      {toolCall && (
        <Hint label={tI18nComplete.raw('text10d67f48de99')}>
          <Wrench className={ICON_CLASS} />
        </Hint>
      )}
      {vision && (
        <Hint label={tI18nComplete.raw('text1f7ad27866ae')}>
          <Eye className={ICON_CLASS} />
        </Hint>
      )}
    </div>
  );
}
