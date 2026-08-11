'use client';

import { PageHead, Panel, Row, StatusDot } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { ChatGPT } from '@/features/icon/icons/chat-gpt';
import { Claude } from '@/features/icon/icons/claude';
import { Gemini } from '@/features/icon/icons/gemini';
import { dosco } from '@/features/icon/icons/kortix';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { GlobeIcon, KeyIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

type Glyph = (props: { className?: string }) => ReactNode;

const PROVIDERS: { glyph: Glyph; name: string; models: string; on: boolean }[] = [
  { glyph: Claude as Glyph, name: 'Anthropic', models: 'Opus · Sonnet · Haiku', on: true },
  { glyph: OpenAI as Glyph, name: 'OpenAI', models: 'GPT · Codex', on: true },
  { glyph: Gemini as Glyph, name: 'Google', models: 'Gemini Pro · Flash', on: true },
  {
    // The custom-provider form takes any base URL and drives it through
    // `@ai-sdk/openai-compatible` — vLLM, LiteLLM and Ollama all land here.
    glyph: GlobeIcon as Glyph,
    name: 'Your endpoint',
    models: 'anything OpenAI-compatible',
    on: false,
  },
];

/**
 * How the model gets paid for. The ChatGPT row is the Codex device-grant OAuth,
 * which is real. Cursor is not — there is no Cursor auth path in the codebase,
 * so it is not on this list however often the README says it.
 */
const BILLING: { glyph: Glyph; title: string; sub: string }[] = [
  { glyph: KeyIcon as Glyph, title: 'Your own API key', sub: 'any major provider' },
  {
    glyph: ChatGPT as Glyph,
    title: 'Your ChatGPT subscription',
    sub: 'the one you already pay for',
  },
  { glyph: dosco as Glyph, title: 'dosco Gateway', sub: 'managed — no key to bring' },
];

/** Layer 02 — the model slot is yours to fill, and so is the bill. */
export function StepModels(): ReactNode {
  return (
    <WebPanelWrapper activeTab="models">
      {/* No `sub` here: the card's own description column already says the
          panel is provider-agnostic, and the line cost 20px of a frame that
          has none to spare. */}
      <PageHead
        title="Models"
        action={
          <Badge variant="kortix" size="sm" className="shrink-0 rounded font-mono">
            model: auto
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Providers">
          {PROVIDERS.map((provider) => (
            <Row
              key={provider.name}
              leading={
                <span className="border-border bg-background text-muted-foreground flex size-8 items-center justify-center rounded-md border">
                  <provider.glyph className="size-4" />
                </span>
              }
              title={provider.name}
              subtitle={provider.models}
              trailing={<StatusDot on={provider.on} label={['connected', 'add yours']} />}
            />
          ))}
        </Panel>

        <div className="space-y-3">
          <Panel title="Billed through" count="pin per agent, or --model per session">
            {BILLING.map((option) => (
              <Row
                key={option.title}
                leading={
                  <span className="border-border bg-background text-muted-foreground flex size-8 items-center justify-center rounded-md border">
                    <option.glyph className="size-4" />
                  </span>
                }
                title={option.title}
                subtitle={option.sub}
              />
            ))}
          </Panel>
        </div>
      </div>
    </WebPanelWrapper>
  );
}
