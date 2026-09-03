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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
import { ReasoningEffortSelector } from '@/features/session/reasoning-effort-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { storedModelRefToKey } from '@/lib/llm-gateway';
import type { AgentConfigBlock, RuntimeAgentConfig } from '@kortix/sdk';
import {
  modelKeyToWire,
  useFeatureFlag,
  useKortixRouteProjectId,
  useRuntimeProviders,
} from '@kortix/sdk/react';
import { AGENT_MODE_HELP, AGENT_MODE_LABEL, AGENT_MODES } from './agent-editor-catalog';
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
  showDescription = true,
}: {
  draft: AgentConfigBlock;
  set: SetKortix;
  oc: RuntimeAgentConfig;
  setOc: SetRuntime;
  /** The agent page edits the description in its own header, beside the
   *  instructions — pass `false` there so the field is not offered twice. */
  showDescription?: boolean;
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

      {showDescription ? (
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
      ) : null}

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
    </EditorSection>
  );
}

export function ModelSection({
  oc,
  setOc,
  showPrompt = true,
}: {
  oc: RuntimeAgentConfig;
  setOc: SetRuntime;
  /** The agent page gives the system prompt the whole left column — pass
   *  `false` there so the collapsed copy of it does not sit in this section. */
  showPrompt?: boolean;
}) {
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
  // The pinned model's published variants — the same list the composer's
  // thinking-effort pill offers. With a list, the knob is that pill (Marko,
  // 2026-09-03: "look in chat input how we do it"); without one (no pin, or a
  // model that publishes none) the raw variant id stays typeable.
  const selectedModel = selectedModelKey
    ? models.find(
        (m) =>
          m.providerID === selectedModelKey.providerID && m.modelID === selectedModelKey.modelID,
      )
    : undefined;
  const variantChoices = selectedModel?.variants ? Object.keys(selectedModel.variants) : [];

  // The sampling knobs and the step cap are set on a handful of agents and
  // read by fewer. They open only when one of them carries a value, so an
  // agent that tunes nothing shows one row — the model — and nothing else.
  const advancedSet =
    !isSliderAtDefault(oc.temperature, 0) ||
    !isSliderAtDefault(oc.top_p, 1) ||
    oc.steps !== undefined;

  return (
    <>
      <EditorSection title="Model" description="How this agent thinks.">
        {/* "Provider model", not "Model": the section is already titled Model,
          and a row that repeats its section's name reads as a typo. */}
        <SettingRow
          label="Provider model"
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
              unsetLabel="Project default"
              onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
            />
          </div>
        </SettingRow>

        {variantChoices.length > 0 ? (
          <SettingRow
            label="Thinking effort"
            help={oc.variant ? 'Pinned for this agent.' : 'Auto — the model decides per turn.'}
          >
            <div className="flex sm:justify-end">
              <ReasoningEffortSelector
                variants={variantChoices}
                selectedVariant={oc.variant ?? null}
                onVariantChange={(v) => setOc('variant', v ?? undefined)}
              />
            </div>
          </SettingRow>
        ) : (
          <SettingRow
            label="Variant"
            help={
              selectedModelKey
                ? 'This model publishes no variants. A raw variant id still applies.'
                : 'Pin a model above to pick from its variants, or type a variant id.'
            }
          >
            <Input
              aria-label="Variant"
              value={oc.variant ?? ''}
              placeholder="Provider default"
              variant="popover"
              className="h-9 w-full text-sm"
              onChange={(e) => setOc('variant', e.target.value)}
            />
          </SettingRow>
        )}

        {/* A wall of text most agents never set — collapsed, like the tool
          permissions at the foot of the editor. */}
        {showPrompt ? (
          <SettingBlock
            label="System prompt"
            help="Replaces the default instructions for this agent."
          >
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
        ) : null}
      </EditorSection>

      {/* Its own card, rows open: the page gives each topic a full column, so
          nothing needs hiding behind a disclosure. `advancedSet` still feeds
          the header chip so an untouched agent reads "Defaults" at a glance. */}
      <EditorSection
        title="Sampling and limits"
        description="How the model samples, and how many tool calls one run may make."
        trailing={
          <Badge variant={advancedSet ? 'outline' : 'muted'} size="sm">
            {advancedSet ? 'Customized' : 'Defaults'}
          </Badge>
        }
      >
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
      </EditorSection>
    </>
  );
}

/**
 * Whether a slider row is showing its default.
 *
 * True for an absent key (inherit) AND for an explicit value that equals the
 * value the row parks at. Both put the handle where an untouched row puts it,
 * so neither is worth offering a Reset for: dragging away and back left
 * "Reset" sitting under a slider that looked untouched, which reads as a
 * control with nothing to undo.
 *
 * The two states stay distinguishable in the readout — `—` is inherit, a
 * number is explicit — so no information is lost. To go from an explicit
 * parked value back to inherit, move the handle; Reset returns with it.
 *
 * Compared with a tolerance because `step` is fractional (0.05 / 0.01) and
 * slider arithmetic does not land on exact binary fractions.
 */
export function isSliderAtDefault(value: number | undefined, fallback: number): boolean {
  return value === undefined || Math.abs(value - fallback) < 1e-9;
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
        isSliderAtDefault(value, fallback) ? (
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
