'use client';

import { useTranslations } from '../../../../i18n';
import { ArrowRightIcon as ArrowRight, CheckIcon as Check } from '@phosphor-icons/react';
import { useState } from 'react';

import { HighlightedCode } from '../../../../markdown/code/code-block';
import { Badge } from '../../../../primitives/badge';
import { Button } from '../../../../primitives/button';
import { Tabs, TabsList, TabsTrigger } from '../../../../primitives/tabs';
import { Copy } from '../../../../icons/copy';
import { useCopy } from '../../../../internal/hooks/use-copy';
import { cn } from '../../../../internal/lib/utils';

const SAMPLE_MODEL = 'anthropic/claude-sonnet-4.6';

function chatCompletionsCurl(base: string, key: string, stream: boolean) {
  return `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\${stream ? '\n  -N \\' : ''}
  -d '{
    "model": "${SAMPLE_MODEL}",
    "messages": [{"role": "user", "content": "Hello"}]${stream ? ',\n    "stream": true' : ''}
  }'`;
}

function chatCompletionsPython(base: string, key: string, stream: boolean) {
  if (!stream) {
    return `from openai import OpenAI

client = OpenAI(api_key="${key}", base_url="${base}/v1")

response = client.chat.completions.create(
    model="${SAMPLE_MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`;
  }
  return `from openai import OpenAI

client = OpenAI(api_key="${key}", base_url="${base}/v1")

stream = client.chat.completions.create(
    model="${SAMPLE_MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`;
}

function messagesPython(base: string, key: string, stream: boolean) {
  if (!stream) {
    return `from anthropic import Anthropic

client = Anthropic(api_key="${key}", base_url="${base}")

message = client.messages.create(
    model="${SAMPLE_MODEL}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content)`;
  }
  return `from anthropic import Anthropic

client = Anthropic(api_key="${key}", base_url="${base}")

with client.messages.stream(
    model="${SAMPLE_MODEL}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")`;
}

/** The gateway origin a reader would type: the env-correct one, else prod. */
export function gatewayBase(gatewayUrl: string | null): string {
  return gatewayUrl ?? 'https://gateway.kortix.com';
}

type QuickTab = 'curl' | 'python' | 'anthropic';

/**
 * The Gateway tab's one code panel (Paper GW09, after Vercel's getting-started
 * card): curl / Python / Anthropic SDK over a single highlighted request, with
 * a labelled Copy in the header. Streaming, list-models and both endpoints'
 * full samples stay in `GatewayApiReference`.
 */
export function GatewayQuickstartCode({ gatewayUrl }: { gatewayUrl: string | null }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayAccess');
  const base = gatewayBase(gatewayUrl);
  const [tab, setTab] = useState<QuickTab>('curl');
  const { copied, copy } = useCopy({
    successMessage: tI18nComplete.raw('texte957fd04449d'),
    errorMessage: tI18nComplete.raw('text94f69e8f103e'),
  });
  // The key lives in an env var in curl; the SDKs take a string literal.
  const samples: Record<QuickTab, { code: string; language: string }> = {
    curl: { code: chatCompletionsCurl(base, '$KORTIX_GATEWAY_KEY', false), language: 'bash' },
    python: { code: chatCompletionsPython(base, 'kortix_gw_...', false), language: 'python' },
    anthropic: { code: messagesPython(base, 'kortix_gw_...', false), language: 'python' },
  };
  const sample = samples[tab];
  const QUICK_TABS = Object.keys(samples) as QuickTab[];

  return (
    <div className="bg-muted/40 flex min-w-0 flex-1 flex-col" data-gateway-quickstart-code="">
      {/* Top padding only: the underline tabs sit flush on this bottom rule. */}
      <div className="border-border flex items-end justify-between gap-3 border-b px-3.5 pt-2 pb-0">
        <Tabs value={tab} onValueChange={(v) => setTab(v as QuickTab)}>
          <TabsList type="underline" size="sm" className="h-10 border-b-0">
            <TabsTrigger value="curl" className="w-fit flex-none pb-2">
              {tI18nComplete.raw('text427e4b79b1f0')}
            </TabsTrigger>
            <TabsTrigger value="python" className="w-fit flex-none pb-2">
              {tI18nComplete.raw('text18885f27b5af')}
            </TabsTrigger>
            <TabsTrigger value="anthropic" className="w-fit flex-none pb-2">
              {t('anthropicSdk')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {/* Same height and bottom inset as the tab list (h-10, pb-2), so the
            button centres on the tab labels, not on the underline gap. */}
        <div className="flex h-10 items-center pb-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5"
            aria-label={copied ? tI18nComplete.raw('text8d525e5f158b') : undefined}
            onClick={() => void copy(sample.code)}
          >
            {/* Copied: the check alone, in ink — no label, no green. */}
            {copied ? (
              <Check className="text-foreground size-3.5 shrink-0" />
            ) : (
              <>
                <Copy className="size-3.5 shrink-0" />
                {tI18nComplete.raw('texte21f935f11d7')}
              </>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? tI18nComplete.raw('text8d525e5f158b') : ''}
            </span>
          </Button>
        </div>
      </div>
      {/* Every sample is rendered in the same grid cell and only the active
          one is visible, so the panel is always as tall as the longest sample
          (the Anthropic SDK one) and does not jump when you switch to curl. */}
      <div className="grid">
        {QUICK_TABS.map((key) => (
          <pre
            key={key}
            aria-hidden={key !== tab || undefined}
            className={cn(
              'col-start-1 row-start-1 overflow-x-auto p-4 font-mono text-xs leading-relaxed',
              key !== tab && 'invisible',
              // Shiki resets, as in manifest-copy-block.tsx.
              '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs',
              '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
            )}
          >
            <HighlightedCode code={samples[key].code} language={samples[key].language} />
          </pre>
        ))}
      </div>
    </div>
  );
}

/** First-request samples for the key-reveal dialog (Paper KM01). The key is
 * always read from `KORTIX_GATEWAY_KEY`, never inlined, so no line runs past
 * the dialog's width and the secret is not pasted into shell history. */
function firstRequestPython(base: string) {
  return `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["KORTIX_GATEWAY_KEY"],
    base_url="${base}/v1",
)

response = client.chat.completions.create(
    model="${SAMPLE_MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`;
}

function firstRequestNode(base: string) {
  return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.KORTIX_GATEWAY_KEY,
  baseURL: "${base}/v1",
});

const response = await client.chat.completions.create({
  model: "${SAMPLE_MODEL}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0].message.content);`;
}

type FirstRequestLang = 'curl' | 'python' | 'node';
const FIRST_REQUEST_LANGS: readonly FirstRequestLang[] = ['curl', 'python', 'node'];

export function firstRequestSamples(
  gatewayUrl: string | null,
): Record<FirstRequestLang, { code: string; language: string }> {
  const base = gatewayBase(gatewayUrl);
  return {
    curl: { code: chatCompletionsCurl(base, '$KORTIX_GATEWAY_KEY', false), language: 'bash' },
    python: { code: firstRequestPython(base), language: 'python' },
    node: { code: firstRequestNode(base), language: 'javascript' },
  };
}

/**
 * "Make your first request" — the reveal dialog's one code card (Paper KM01):
 * curl / Python / Node over a line-numbered, highlighted request, with Copy in
 * the card header. Every sample sits in one grid cell so the card keeps the
 * tallest one's height and never jumps when the language changes.
 */
export function GatewayFirstRequest({
  gatewayUrl,
  onViewModels,
}: {
  gatewayUrl: string | null;
  onViewModels?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayAccess');
  const [lang, setLang] = useState<FirstRequestLang>('curl');
  const samples = firstRequestSamples(gatewayUrl);
  const { copied, copy } = useCopy({
    successMessage: tI18nComplete.raw('texte957fd04449d'),
    errorMessage: tI18nComplete.raw('text94f69e8f103e'),
  });
  const labels: Record<FirstRequestLang, string> = {
    curl: tI18nComplete.raw('text427e4b79b1f0'),
    python: tI18nComplete.raw('text18885f27b5af'),
    node: t('node'),
  };

  return (
    <div className="space-y-3" data-gateway-first-request="">
      <div className="flex items-center justify-between gap-3">
        <span className="text-foreground text-xs font-medium">{t('firstRequest')}</span>
        <Tabs value={lang} onValueChange={(v) => setLang(v as FirstRequestLang)}>
          <TabsList size="sm">
            {FIRST_REQUEST_LANGS.map((key) => (
              <TabsTrigger key={key} value={key} size="xs">
                {labels[key]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="bg-muted/40 overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between gap-3 border-b py-2 pr-2 pl-3">
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="default" size="xs">
              POST
            </Badge>
            <code className="text-muted-foreground truncate font-mono text-xs">
              /v1/chat/completions
            </code>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5"
            aria-label={copied ? tI18nComplete.raw('text8d525e5f158b') : undefined}
            onClick={() => void copy(samples[lang].code)}
          >
            {/* Copied: the check alone, in ink — no label, no green. */}
            {copied ? (
              <Check className="text-foreground size-3.5 shrink-0" />
            ) : (
              <>
                <Copy className="size-3.5 shrink-0" />
                {tI18nComplete.raw('texte21f935f11d7')}
              </>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? tI18nComplete.raw('text8d525e5f158b') : ''}
            </span>
          </Button>
        </div>
        <div className="grid">
          {FIRST_REQUEST_LANGS.map((key) => {
            const lines = samples[key].code.split('\n').length;
            return (
              <div
                key={key}
                aria-hidden={key !== lang || undefined}
                className={cn(
                  'col-start-1 row-start-1 flex gap-3 px-3 py-2.5',
                  key !== lang && 'invisible',
                )}
              >
                {/* Line numbers: same size and leading as the code beside them. */}
                <span
                  aria-hidden
                  className="text-muted-foreground flex w-4 shrink-0 flex-col items-end font-mono text-xs leading-5 select-none"
                >
                  {Array.from({ length: lines }, (_, i) => (
                    <span key={i}>{i + 1}</span>
                  ))}
                </span>
                <pre
                  className={cn(
                    'min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-5',
                    // Shiki resets, as in manifest-copy-block.tsx.
                    '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:leading-5',
                    '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
                  )}
                >
                  <HighlightedCode code={samples[key].code} language={samples[key].language} />
                </pre>
              </div>
            );
          })}
        </div>
      </div>

      {/* Markdown-style: prose with inline code chips, the link on its own line. */}
      <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed text-pretty">
        <p>
          {t.rich('envHint', {
            base: `${gatewayBase(gatewayUrl)}/v1`,
            code: (chunks) => (
              <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">
                {chunks}
              </code>
            ),
          })}
        </p>
        {onViewModels ? (
          <button
            type="button"
            onClick={onViewModels}
            className="text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            {tI18nComplete.raw('text1814e0a6cb50')}
            <ArrowRight className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
