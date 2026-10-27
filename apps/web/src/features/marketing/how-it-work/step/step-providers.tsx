import { cn } from '@kortix/ui';

/*
 * Every provider is a BYOK target the LLM gateway routes today (the gate in
 * step-models.tsx). Marks come from `public/provider-icons`, drawn as a mask
 * in the text colour so every logo reads at one weight.
 */
const PROVIDERS = [
  { slug: 'anthropic', name: 'Anthropic' },
  { slug: 'openai', name: 'OpenAI' },
  { slug: 'google', name: 'Google' },
  { slug: 'xai', name: 'xAI' },
  { slug: 'mistral', name: 'Mistral' },
  { slug: 'deepseek', name: 'DeepSeek' },
  { slug: 'moonshotai', name: 'Moonshot' },
  { slug: 'openrouter', name: 'OpenRouter' },
  { slug: 'amazon-bedrock', name: 'Bedrock' },
  { slug: 'azure', name: 'Azure' },
  { slug: 'groq', name: 'Groq' },
  { slug: 'generic-provider', name: 'Your endpoint' },
];

/**
 * The managed lineup, by name with its version (D23). Platinum Inference is
 * the source (`GET /v1/inference/models`, managed-models.ts): check it and
 * update this list when the lineup changes.
 */
export const MANAGED_MODELS = ['DeepSeek V4.1 Flash', 'GLM 5.3 Flash'];

function Mark({ slug, className }: { slug: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: `url(/provider-icons/${slug}.svg)`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
      }}
    />
  );
}

/** Any provider with your keys as a wall of marks, then the managed models. */
export function StepProviders() {
  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden rounded-lg border">
      <div className="flex items-baseline justify-between border-b px-4 py-3">
        <p className="text-foreground text-sm font-medium">Model providers</p>
        <p className="text-muted-foreground text-xs">Your keys</p>
      </div>
      <ul className="bg-border grid flex-1 grid-cols-4 gap-px">
        {PROVIDERS.map((p) => (
          <li key={p.slug} className="bg-background flex flex-col items-center justify-center gap-2 px-1">
            <Mark slug={p.slug} className="text-foreground size-5" />
            <span className="text-muted-foreground w-full truncate text-center text-xs">{p.name}</span>
          </li>
        ))}
      </ul>
      <div className="bg-muted/40 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">Managed by Kortix, zero data retention</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {MANAGED_MODELS.map((name) => (
            <li key={name} className="bg-background text-foreground rounded-md border px-2.5 py-1 text-sm">
              {name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
