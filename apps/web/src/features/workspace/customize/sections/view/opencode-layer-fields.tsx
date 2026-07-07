'use client';

/** The OpenCode-layer field block (behavior + permission tree) — the
 *  runtime-specific half of the agent, saves to
 *  `.kortix/opencode/agents/<name>.md`. */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { cn } from '@/lib/utils';
import { modelKeyToWire, wireToModelKey } from '@kortix/sdk/react';
import type { OpencodeAgentConfig, PermissionConfig } from '@kortix/sdk/projects-client';
import { Gauge, Sliders } from 'lucide-react';
import { AGENT_MODE_HELP, AGENT_MODES, THEME_COLORS } from './agent-editor-catalog';
import { FieldRow, SectionHeader, Segmented } from './agent-editor-primitives';
import { PermissionEditor } from './permission-editor';

export function OpencodeLayerFields({
  agentName,
  oc,
  setOc,
}: {
  agentName: string;
  oc: OpencodeAgentConfig;
  setOc: <K extends keyof OpencodeAgentConfig>(key: K, value: OpencodeAgentConfig[K]) => void;
}) {
  const { data: providers } = useOpenCodeProviders();
  const models = flattenModels(providers);
  const selectedModelKey = oc.model ? wireToModelKey(oc.model) : null;
  const permCount =
    typeof oc.permission === 'string' ? 1 : oc.permission ? Object.keys(oc.permission).length : 0;

  return (
    <>
      <section className="space-y-4">
        <SectionHeader icon={Gauge} title="Behavior" />
        <FieldRow
          label="Description"
          hint={oc.mode === 'subagent' ? 'required for subagents' : 'shown to other agents when picking a subagent'}
        >
          <Textarea
            value={oc.description ?? ''}
            placeholder="What this agent is for"
            minHeight={44}
            onChange={(e) => setOc('description', e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Model" hint="declarative default; runtime prefs can override">
          <div className="flex items-center gap-2">
            <ModelSelector
              models={models}
              providers={providers}
              selectedModel={selectedModelKey}
              onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
            />
            {oc.model ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setOc('model', undefined)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </FieldRow>
        <FieldRow label="Mode">
          <div className="space-y-1.5">
            <Segmented
              options={AGENT_MODES.map((m) => ({ value: m, label: m }))}
              value={oc.mode}
              onChange={(v) => setOc('mode', v)}
              allowUnset
            />
            <p className="text-muted-foreground/60 text-[11px]">
              {oc.mode ? AGENT_MODE_HELP[oc.mode] : 'Inherits the project default.'}
            </p>
          </div>
        </FieldRow>
        <FieldRow label="Variant" hint="optional model variant">
          <Input
            value={oc.variant ?? ''}
            placeholder="e.g. thinking"
            variant="popover"
            className="h-8 max-w-[240px] text-xs"
            onChange={(e) => setOc('variant', e.target.value)}
          />
        </FieldRow>
        <FieldRow
          label={
            <>
              Temperature
              {oc.temperature !== undefined ? (
                <span className="tabular-nums"> — {oc.temperature}</span>
              ) : null}
            </>
          }
          hint="0 = deterministic, 2 = most random"
        >
          <div className="flex items-center gap-3">
            <Slider
              value={[oc.temperature ?? 0]}
              min={0}
              max={2}
              step={0.05}
              className="max-w-[240px]"
              onValueChange={([v]) => setOc('temperature', v)}
            />
            {oc.temperature !== undefined ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setOc('temperature', undefined)}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </FieldRow>
        <FieldRow
          label={
            <>
              Top-p
              {oc.top_p !== undefined ? <span className="tabular-nums"> — {oc.top_p}</span> : null}
            </>
          }
          hint="nucleus sampling cutoff; leave at 1 unless tuning"
        >
          <div className="flex items-center gap-3">
            <Slider
              value={[oc.top_p ?? 1]}
              min={0}
              max={1}
              step={0.01}
              className="max-w-[240px]"
              onValueChange={([v]) => setOc('top_p', v)}
            />
            {oc.top_p !== undefined ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setOc('top_p', undefined)}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </FieldRow>
        <FieldRow label="Steps" hint="max agent steps per run">
          <Input
            type="number"
            min={1}
            value={oc.steps ?? ''}
            placeholder="unset"
            variant="popover"
            className="h-8 max-w-[140px] text-xs"
            onChange={(e) =>
              setOc('steps', e.target.value ? Math.max(1, Number(e.target.value)) : undefined)
            }
          />
        </FieldRow>
        <FieldRow label="Color" hint="tints this agent's badge across pickers and session UI">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {THEME_COLORS.map((c) => {
                const active = oc.color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setOc('color', active ? undefined : c)}
                    className={cn(
                      'rounded-full border px-2 py-1 text-[11px] capitalize transition-[color,background-color,transform] active:scale-[0.96]',
                      active
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/70 text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <Hint label="Custom hex color">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(oc.color ?? '') ? oc.color : '#7c5cff'}
                onChange={(e) => setOc('color', e.target.value)}
                className="border-border/70 size-7 shrink-0 cursor-pointer rounded-full border bg-transparent transition-transform active:scale-[0.96]"
                aria-label="Custom hex color"
              />
            </Hint>
            {oc.color ? (
              <Badge variant="outline" size="xs" className="font-mono">
                {oc.color}
              </Badge>
            ) : null}
          </div>
        </FieldRow>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground/80 text-xs font-medium">Hidden</p>
            <p className="text-muted-foreground/60 text-[11px]">
              Keep this agent out of pickers.
            </p>
          </div>
          <Switch checked={!!oc.hidden} onCheckedChange={(v) => setOc('hidden', v || undefined)} />
        </div>
        <FieldRow
          label="System prompt"
          hint={`saved to .kortix/opencode/agents/${agentName}.md`}
        >
          <Textarea
            value={oc.prompt ?? ''}
            placeholder="You are..."
            minHeight={160}
            className="font-mono text-xs"
            onChange={(e) => setOc('prompt', e.target.value)}
          />
        </FieldRow>
      </section>

      {/* PERMISSIONS (advanced) */}
      <section>
        <Disclosure variant="outline" className="overflow-hidden rounded-md">
          <DisclosureTrigger variant="outline">
            <Button
              variant="popover"
              className="flex w-full items-center justify-start gap-2 rounded-none"
            >
              <Sliders className="text-muted-foreground/70 size-3.5 shrink-0" />
              <span className="text-xs font-medium">Advanced — permission tree</span>
              {permCount > 0 ? (
                <Badge variant="muted" size="xs" className="ml-auto">
                  {permCount} customized
                </Badge>
              ) : null}
            </Button>
          </DisclosureTrigger>
          <DisclosureContent variant="outline" contentClassName="border-border border-t">
            <div className="px-3 py-3">
              <PermissionEditor
                permission={oc.permission}
                onChange={(next: PermissionConfig | undefined) => setOc('permission', next)}
              />
            </div>
          </DisclosureContent>
        </Disclosure>
      </section>
    </>
  );
}
