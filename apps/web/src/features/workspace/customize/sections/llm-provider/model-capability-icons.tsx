'use client';

import Hint from '@/components/ui/hint';
import type { LlmProviderModel } from '@/lib/llm-providers';
import { Brain, Eye, Wrench } from 'lucide-react';

const ICON_CLASS = 'text-muted-foreground/50 size-3.5 shrink-0';

/**
 * Compact capability chips — reasoning / tool-calling / vision — mirrored
 * verbatim from models.dev (`LlmProviderModel.reasoning` / `tool_call` /
 * `attachment`). Icon-only with a `Hint` tooltip so a dense model row stays
 * scannable; renders nothing when a model declares no capabilities.
 */
export function ModelCapabilityIcons({ model }: { model: LlmProviderModel }) {
  if (!model.reasoning && !model.tool_call && !model.attachment) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {model.reasoning && (
        <Hint label="Reasoning">
          <Brain className={ICON_CLASS} />
        </Hint>
      )}
      {model.tool_call && (
        <Hint label="Tool calling">
          <Wrench className={ICON_CLASS} />
        </Hint>
      )}
      {model.attachment && (
        <Hint label="Vision / file input">
          <Eye className={ICON_CLASS} />
        </Hint>
      )}
    </div>
  );
}
