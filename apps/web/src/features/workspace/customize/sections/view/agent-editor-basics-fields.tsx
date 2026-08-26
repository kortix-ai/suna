'use client';

/**
 * The first two sections of the agent editor: what the agent IS (Basics) and
 * how it thinks (Model).
 *
 * These used to be one "OpenCode layer" block, headed by a chip icon and named
 * after the runtime that stores them. The runtime is not what anyone is
 * looking for. Both sections write to the same place they always did — the
 * agent's markdown file, via `setOc` — but the grouping now follows the
 * question being answered, not the file being written.
 *
 * `Basics` spans both writers on purpose: "Enabled" is a Kortix-side key
 * (`set`) and everything beside it is runtime-side (`setOc`). Splitting the
 * section to match would strand one switch in a section of its own for a
 * reason no reader could see.
 */

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { cn } from '@/lib/utils';
import type { AgentConfigBlock, RuntimeAgentConfig } from '@kortix/sdk';
import { modelKeyToWire, useFeatureFlag, useKortixRouteProjectId, useRuntimeProviders } from '@kortix/sdk/react';
import { storedModelRefToKey } from '@/lib/llm-gateway';
import {
  AGENT_MODE_HELP,
  AGENT_MODE_LABEL,
  AGENT_MODES,
  THEME_COLOR_SWATCH,
  THEME_COLORS,
} from './agent-editor-catalog';
import { EditorSection, InlineAction, SettingBlock, SettingRow } from './agent-editor-primitives';

/** Matches the access section's inherit sentinel — Radix forbids `""`. */
const INHERIT = '__inherit__';

type SetKortix = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => void;
type SetRuntime = <K extends keyof RuntimeAgentConfig>(
  key: K,
  value: RuntimeAgentConfig[K],
) => void;

export function BasicsSection({
  draft,
  set,
  oc,
  setOc,
}: {
  draft: AgentConfigBlock;
  set: SetKortix;
  oc: RuntimeAgentConfig;
  setOc: SetRuntime;
}) {
  return (
    <EditorSection title="Basics" description="What this agent is, and whether it can run.">
      <SettingRow label="Enabled" help="Turn off to stop this agent starting any new session.">
        <div className="flex sm:justify-end">
          <Switch
            aria-label="Enabled"
            checked={draft.enabled !== false}
            onCheckedChange={(v) => set('enabled', v ? undefined : false)}
          />
        </div>
      </SettingRow>

      <SettingBlock
        label="Description"
        help={
          oc.mode === 'subagent'
            ? 'Required. This is how other agents decide to call it.'
            : 'One line on what this agent is for. Other agents read it when picking a subagent.'
        }
      >
        <Textarea
          aria-label="Description"
          value={oc.description ?? ''}
          placeholder="What this agent is for"
          minHeight={44}
          className="text-sm"
          onChange={(e) => setOc('description', e.target.value)}
        />
      </SettingBlock>

      <SettingRow
        label="Availability"
        help={oc.mode ? AGENT_MODE_HELP[oc.mode] : 'Follows the project default.'}
      >
        <Select
          value={oc.mode ?? INHERIT}
          onValueChange={(value) =>
            setOc('mode', value === INHERIT ? undefined : (value as typeof oc.mode))
          }
        >
          <SelectTrigger aria-label="Availability" className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Project default</SelectItem>
            {AGENT_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {AGENT_MODE_LABEL[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Stored as `hidden`, shown as "Show in pickers". A switch you turn ON
          to make something disappear is a double negative, and it sat two rows
          under "Enabled" — two toggles whose ON states meant opposite things. */}
      <SettingRow
        label="Show in pickers"
        help="Off keeps it out of the session picker. Other agents can still call it."
      >
        <div className="flex sm:justify-end">
          <Switch
            aria-label="Show in pickers"
            checked={!oc.hidden}
            onCheckedChange={(v) => setOc('hidden', v ? undefined : true)}
          />
        </div>
      </SettingRow>

      <SettingRow
        label="Badge color"
        help={
          oc.color ? (
            <>
              <span className="font-mono">{oc.color}</span> ·{' '}
              <InlineAction onClick={() => setOc('color', undefined)}>Clear</InlineAction>
            </>
          ) : (
            "Tints this agent's badge in session lists."
          )
        }
      >
        <ColorSwatches value={oc.color} onChange={(v) => setOc('color', v)} />
      </SettingRow>
    </EditorSection>
  );
}

/**
 * Seven named theme colours as swatches, plus a custom hex well.
 *
 * This replaced seven text pills reading "primary secondary accent success
 * warning error info", a colour input, and a mono badge echoing the value —
 * nine controls for a badge tint. A colour picker should show colour.
 */
function ColorSwatches({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value ?? '');
  // Eight size-7 targets at gap-0.5 is 238px — two under the row's 240px
  // control slot. `flex-wrap` is the safety net for a zoom or font change that
  // pushes it over, rather than letting one swatch clip.
  return (
    <div className="flex flex-wrap items-center gap-0.5 sm:flex-nowrap sm:justify-end">
      {THEME_COLORS.map((c) => {
        const active = value === c;
        return (
          <Hint key={c} label={c} side="bottom">
            <button
              type="button"
              aria-label={c}
              aria-pressed={active}
              onClick={() => onChange(active ? undefined : c)}
              className={cn(
                // size-7 keeps the tap target honest while the dot stays size-4.
                'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm transition-transform active:scale-[0.96]',
                'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
              )}
            >
              <span
                className={cn(
                  'size-5 rounded-sm transition-shadow',
                  THEME_COLOR_SWATCH[c],
                  active
                    ? 'ring-foreground ring-offset-popover ring-1 ring-offset-1'
                    : 'ring-border ring-[1px] ring-inset',
                )}
              />
            </button>
          </Hint>
        );
      })}
      <Hint label="Custom color" side="bottom">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-sm">
          {/* Native color inputs only paint a solid hex. When nothing custom is
              selected, cover the well with a rainbow wheel so the control reads
              as "pick any colour" rather than a fixed purple seed. */}
          <span
            className={cn(
              'relative size-5 overflow-hidden rounded-sm transition-shadow',
              isHex
                ? 'ring-foreground ring-offset-popover ring-1 ring-offset-1'
                : 'ring-border ring-[1px] ring-inset',
            )}
          >
            {!isHex && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'conic-gradient(from 0deg, #ff0040, #ff9a00, #ffe600, #00e676, #00d4ff, #2979ff, #d500f9, #ff0040)',
                }}
              />
            )}
            <input
              type="color"
              aria-label="Custom color"
              value={isHex ? value : '#7c5cff'}
              onChange={(e) => onChange(e.target.value)}
              className={cn(
                'absolute inset-0 size-full cursor-pointer appearance-none bg-transparent p-0',
                '[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0',
                !isHex && 'opacity-0',
              )}
            />
          </span>
        </span>
      </Hint>
    </div>
  );
}

export function ModelSection({ oc, setOc }: { oc: RuntimeAgentConfig; setOc: SetRuntime }) {
  const { data: providers } = useRuntimeProviders();
  const models = flattenModels(providers);
  // Mode-aware read-back: a native (gateway-off) agent model is
  // `provider/model` — see storedModelRefToKey. This editor renders under
  // /projects/[id], so the route supplies the project.
  const projectId = useKortixRouteProjectId();
  const llmGatewayFlag = useFeatureFlag(projectId, 'llm_gateway');
  const selectedModelKey = oc.model
    ? storedModelRefToKey(oc.model, llmGatewayFlag.enabled === true)
    : null;

  return (
    <EditorSection title="Model" description="How this agent thinks.">
      <SettingRow
        label="Model"
        help={
          oc.model ? (
            <InlineAction onClick={() => setOc('model', undefined)}>
              Reset to project default
            </InlineAction>
          ) : (
            'Follows the project default.'
          )
        }
      >
        <div className="flex sm:justify-end">
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={selectedModelKey}
            onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
          />
        </div>
      </SettingRow>

      <SettingRow label="Variant" help="Provider variant to request, such as thinking.">
        <Input
          aria-label="Variant"
          value={oc.variant ?? ''}
          placeholder="Provider default"
          variant="popover"
          className="h-9 w-full text-sm"
          onChange={(e) => setOc('variant', e.target.value)}
        />
      </SettingRow>

      <SliderRow
        label="Temperature"
        help="0 gives the same answer every time. 2 is the most random."
        value={oc.temperature}
        fallback={0}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => setOc('temperature', v)}
      />

      <SliderRow
        label="Top-p"
        help="Nucleus sampling. Leave it alone unless you are tuning the model."
        value={oc.top_p}
        fallback={1}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => setOc('top_p', v)}
      />

      <SettingRow label="Step limit" help="Most tool calls this agent may make in one run.">
        <Input
          aria-label="Step limit"
          type="number"
          min={1}
          value={oc.steps ?? ''}
          placeholder="No limit"
          variant="popover"
          className="h-9 w-full text-sm tabular-nums"
          onChange={(e) =>
            setOc('steps', e.target.value ? Math.max(1, Number(e.target.value)) : undefined)
          }
        />
      </SettingRow>

      {/* A wall of text most agents never set — collapsed, like the tool
          permissions at the foot of the editor. */}
      <SettingBlock label="System prompt" help="Replaces the default instructions for this agent.">
        <Disclosure variant="outline" className="overflow-hidden rounded-md">
          <DisclosureTrigger variant="outline">
            <Button
              variant="popover"
              className="flex w-full items-center justify-between gap-3 rounded-none text-sm font-normal"
            >
              <span className="min-w-0 truncate">
                {oc.prompt ? firstLine(oc.prompt) : 'Not set — using the default instructions'}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {oc.prompt ? 'Edit' : 'Write one'}
              </span>
            </Button>
          </DisclosureTrigger>
          <DisclosureContent variant="outline" contentClassName="border-border border-t">
            <Textarea
              aria-label="System prompt"
              value={oc.prompt ?? ''}
              placeholder="You are…"
              minHeight={160}
              className="rounded-none border-0 font-mono text-xs focus-visible:border-0 focus-visible:ring-0"
              onChange={(e) => setOc('prompt', e.target.value)}
            />
          </DisclosureContent>
        </Disclosure>
      </SettingBlock>
    </EditorSection>
  );
}

/**
 * A slider row that can be UNSET.
 *
 * The readout prints `—` rather than the fallback when the key is absent: an
 * unset temperature parked the handle at 0 and printed "0", which reads as
 * "pinned to deterministic" when it actually means "inherits the default".
 */
function SliderRow({
  label,
  help,
  value,
  fallback,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  help: string;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <SettingRow
      label={label}
      help={
        value === undefined ? (
          help
        ) : (
          <>
            {help} · <InlineAction onClick={() => onChange(undefined)}>Reset</InlineAction>
          </>
        )
      }
    >
      <div className="flex items-center gap-3">
        <Slider
          value={[value ?? fallback]}
          min={min}
          max={max}
          step={step}
          className="min-w-0 flex-1"
          thumbLabel={label}
          formatValue={(v) => v.toFixed(2)}
          onValueChange={([v]) => onChange(v)}
        />
        <span className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">
          {value === undefined ? '—' : value}
        </span>
      </div>
    </SettingRow>
  );
}

/** First non-empty line of the prompt, for the collapsed summary. */
function firstLine(prompt: string): string {
  return (
    prompt
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? 'Set'
  );
}
