'use client';

import Hint from '@/components/ui/hint';
import { Brain, Eye, Wrench } from 'lucide-react';

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
  if (!reasoning && !toolCall && !vision) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {reasoning && (
        <Hint label="Reasoning">
          <Brain className={ICON_CLASS} />
        </Hint>
      )}
      {toolCall && (
        <Hint label="Tool calling">
          <Wrench className={ICON_CLASS} />
        </Hint>
      )}
      {vision && (
        <Hint label="Vision / file input">
          <Eye className={ICON_CLASS} />
        </Hint>
      )}
    </div>
  );
}
