'use client';

import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';

const SAMPLE_MODEL = 'anthropic/claude-sonnet-4.6';

type Lang = 'curl' | 'python';

/** One copyable code sample — matches the `pre` styling used in the key-reveal
 * dialog, plus the buttery copy-icon crossfade from `CopyButton`. */
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="bg-muted/30 relative overflow-hidden rounded-md border">
      <pre className="scrollbar-hide overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed">
        <code className="text-foreground whitespace-pre">{code}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton code={code} />
      </div>
    </div>
  );
}

function Sample({ label, code }: { label?: string; code: string }) {
  return (
    <div className="space-y-1.5">
      {label && <div className="text-muted-foreground text-xs font-medium">{label}</div>}
      <CodeBlock code={code} />
    </div>
  );
}

function EndpointHeader({ method, path }: { method: 'POST' | 'GET'; path: string }) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" size="xs" className="font-mono">
        {method}
      </Badge>
      <code className="text-foreground font-mono text-xs">{path}</code>
    </div>
  );
}

/** curl / Python switch — a nested compact tab bar local to one endpoint panel. */
function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <Tabs value={lang} onValueChange={(v) => onChange(v as Lang)}>
      <TabsListCompact type="secondary">
        <TabsTriggerCompact value="curl">curl</TabsTriggerCompact>
        <TabsTriggerCompact value="python">Python</TabsTriggerCompact>
      </TabsListCompact>
    </Tabs>
  );
}

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

function messagesCurl(base: string, key: string, stream: boolean) {
  return `curl ${base}/v1/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\${stream ? '\n  -N \\' : ''}
  -d '{
    "model": "${SAMPLE_MODEL}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]${stream ? ',\n    "stream": true' : ''}
  }'`;
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

function modelsCurl(base: string, key: string) {
  return `curl ${base}/v1/models \\
  -H "Authorization: Bearer ${key}"`;
}

type EndpointTab = 'openai' | 'anthropic' | 'models';

const ENDPOINT_TABS: { id: EndpointTab; label: string }[] = [
  { id: 'openai', label: 'OpenAI-compatible' },
  { id: 'anthropic', label: 'Anthropic-compatible' },
  { id: 'models', label: 'List models' },
];

/**
 * Gateway API reference — base URL, auth header, and copyable examples for the
 * three live gateway surfaces (OpenAI chat/completions, Anthropic messages,
 * models list). Shared between the key-create success screen (real key) and
 * the persistent gateway "API" tab (masked placeholder key), so both stay in
 * sync with one source of truth.
 */
export function GatewayApiReference({
  apiKey,
  gatewayUrl,
  onViewModels,
}: {
  /** The real secret key when just created; a masked placeholder otherwise. */
  apiKey: string;
  /** Env-correct public gateway origin (dev vs prod); falls back to prod. */
  gatewayUrl: string | null;
  /** Jump to the Providers/Models tab — omitted when there's nowhere to jump to. */
  onViewModels?: () => void;
}) {
  const base = gatewayUrl ?? 'https://gateway.kortix.com';
  const [tab, setTab] = useState<EndpointTab>('openai');
  const [openaiLang, setOpenaiLang] = useState<Lang>('curl');
  const [anthropicLang, setAnthropicLang] = useState<Lang>('curl');

  return (
    <div className="space-y-4">
      <div className="bg-popover space-y-2 rounded-md border px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16 shrink-0 font-medium">Base URL</span>
          <code className="text-foreground min-w-0 flex-1 truncate font-mono">{base}</code>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16 shrink-0 font-medium">Auth</span>
          <code className="text-foreground min-w-0 flex-1 truncate font-mono">
            Authorization: Bearer {apiKey}
          </code>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as EndpointTab)}>
        <TabsList type="underline" size="sm">
          {ENDPOINT_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="w-fit flex-none">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="openai" className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <EndpointHeader method="POST" path="/v1/chat/completions" />
            <LangSwitch lang={openaiLang} onChange={setOpenaiLang} />
          </div>
          {openaiLang === 'curl' ? (
            <>
              <Sample label="Request" code={chatCompletionsCurl(base, apiKey, false)} />
              <Sample label="Streaming" code={chatCompletionsCurl(base, apiKey, true)} />
            </>
          ) : (
            <>
              <Sample label="Request" code={chatCompletionsPython(base, apiKey, false)} />
              <Sample label="Streaming" code={chatCompletionsPython(base, apiKey, true)} />
            </>
          )}
        </TabsContent>

        <TabsContent value="anthropic" className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <EndpointHeader method="POST" path="/v1/messages" />
            <LangSwitch lang={anthropicLang} onChange={setAnthropicLang} />
          </div>
          {anthropicLang === 'curl' ? (
            <>
              <Sample label="Request" code={messagesCurl(base, apiKey, false)} />
              <Sample label="Streaming" code={messagesCurl(base, apiKey, true)} />
            </>
          ) : (
            <>
              <Sample label="Request" code={messagesPython(base, apiKey, false)} />
              <Sample label="Streaming" code={messagesPython(base, apiKey, true)} />
            </>
          )}
        </TabsContent>

        <TabsContent value="models" className="mt-3 space-y-3">
          <EndpointHeader method="GET" path="/v1/models" />
          <Sample code={modelsCurl(base, apiKey)} />
          <p className="text-muted-foreground text-xs">
            Or with the OpenAI SDK:{' '}
            <code className="bg-muted rounded-sm px-1 py-0.5 font-mono">client.models.list()</code>
          </p>
        </TabsContent>
      </Tabs>

      <p className="text-muted-foreground text-pretty text-xs">
        Model ids are{' '}
        <code className="bg-muted rounded-sm px-1 py-0.5 font-mono">provider/model</code> from the
        live models.dev catalog (e.g. <code className="font-mono">{SAMPLE_MODEL}</code>,{' '}
        <code className="font-mono">openai/gpt-5.6</code>).
        {onViewModels ? (
          <Button
            type="button"
            variant="transparent"
            size="sm"
            className="h-auto gap-1 px-1 py-0 align-baseline text-xs"
            onClick={onViewModels}
          >
            See available models
            <ArrowRight className="size-3" />
          </Button>
        ) : (
          ' See the Providers tab for models available to this key.'
        )}
      </p>
    </div>
  );
}
