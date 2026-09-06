'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <EditorSection
      title={tI18nComplete.raw('text8fdd2ee8475e')}
      description={tI18nComplete.raw('text4e420a5186f0')}
    >
      <SettingRow
        label={tI18nComplete.raw('text92c1cdfdf4cb')}
        help={tI18nComplete.raw('textbe90a56d29da')}
      >
        <div className="flex sm:justify-end">
          <Switch
            aria-label={tI18nComplete.raw('text92c1cdfdf4cb')}
            checked={draft.enabled !== false}
            onCheckedChange={(v) => set('enabled', v ? undefined : false)}
          />
        </div>
      </SettingRow>

      {showDescription ? (
        <SettingBlock
          label={tI18nComplete.raw('text526e0087cc3f')}
          help={
            oc.mode === 'subagent'
              ? tI18nComplete.raw('text77e2bc11f6ab')
              : tI18nComplete.raw('text9965df7c3221')
          }
        >
          <Textarea
            aria-label={tI18nComplete.raw('text526e0087cc3f')}
            value={oc.description ?? ''}
            placeholder={tI18nComplete.raw('text446f4eabf99f')}
            minHeight={44}
            className="text-sm"
            onChange={(e) => setOc('description', e.target.value)}
          />
        </SettingBlock>
      ) : null}

      <SettingRow
        label={tI18nComplete.raw('text12f67f8539c4')}
        help={oc.mode ? AGENT_MODE_HELP[oc.mode] : tI18nComplete.raw('text64f405e80a8d')}
      >
        <Select
          value={oc.mode ?? INHERIT}
          onValueChange={(value) =>
            setOc('mode', value === INHERIT ? undefined : (value as typeof oc.mode))
          }
        >
          <SelectTrigger aria-label={tI18nComplete.raw('text12f67f8539c4')} className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{tI18nComplete.raw('texte8cb80e5c5cb')}</SelectItem>
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
        label={tI18nComplete.raw('textc7bcb471c03d')}
        help={tI18nComplete.raw('textdd4971af3f91')}
      >
        <div className="flex sm:justify-end">
          <Switch
            aria-label={tI18nComplete.raw('textc7bcb471c03d')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      <EditorSection
        title={tI18nComplete.raw('text5e2c614c23f0')}
        description={tI18nComplete.raw('text32398dbb68e2')}
      >
        {/* "Provider model", not "Model": the section is already titled Model,
          and a row that repeats its section's name reads as a typo. */}
        <SettingRow
          label={tI18nComplete.raw('text34455bf1d857')}
          help={
            oc.model ? (
              <InlineAction onClick={() => setOc('model', undefined)}>
                {tI18nComplete.raw('text9db60344e984')}
              </InlineAction>
            ) : (
              tI18nComplete.raw('text64f405e80a8d')
            )
          }
        >
          <div className="flex sm:justify-end">
            <ModelSelector
              models={models}
              providers={providers}
              selectedModel={selectedModelKey}
              unsetLabel={tI18nComplete.raw('texte8cb80e5c5cb')}
              onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
            />
          </div>
        </SettingRow>

        {variantChoices.length > 0 ? (
          <SettingRow
            label={tI18nComplete.raw('text264c28cbf01c')}
            help={
              oc.variant
                ? tI18nComplete.raw('text4dd21464c579')
                : tI18nComplete.raw('textf39c806f5724')
            }
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
            label={tI18nComplete.raw('text3f19fe84a2de')}
            help={
              selectedModelKey
                ? tI18nComplete.raw('text0443f619cb33')
                : tI18nComplete.raw('text6376d74077c0')
            }
          >
            <Input
              aria-label={tI18nComplete.raw('text3f19fe84a2de')}
              value={oc.variant ?? ''}
              placeholder={tI18nComplete.raw('text352a25678fb9')}
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
            label={tI18nComplete.raw('text561257c019e5')}
            help={tI18nComplete.raw('textad63817393a7')}
          >
            <Disclosure variant="outline" className="overflow-hidden rounded-md">
              <DisclosureTrigger variant="outline">
                <Button
                  variant="popover"
                  className="flex w-full items-center justify-between gap-3 rounded-none text-sm font-normal"
                >
                  <span className="min-w-0 truncate">
                    {oc.prompt ? firstLine(oc.prompt) : tI18nComplete.raw('textdaaf5ab03267')}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {oc.prompt ? 'Edit' : tI18nComplete.raw('text47f3fe537320')}
                  </span>
                </Button>
              </DisclosureTrigger>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <Textarea
                  aria-label={tI18nComplete.raw('text561257c019e5')}
                  value={oc.prompt ?? ''}
                  placeholder={tI18nComplete.raw('text94a18ea1d428')}
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
        title={tI18nComplete.raw('text6d06116595a9')}
        description={tI18nComplete.raw('text33439eb47c9a')}
        trailing={
          <Badge variant={advancedSet ? 'outline' : 'muted'} size="sm">
            {advancedSet ? 'Customized' : 'Defaults'}
          </Badge>
        }
      >
        <SliderRow
          label={tI18nComplete.raw('textb958ce8b871a')}
          help={tI18nComplete.raw('textd380d30f3d60')}
          value={oc.temperature}
          fallback={0}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => setOc('temperature', v)}
        />

        <SliderRow
          label={tI18nComplete.raw('text714db3dbb0b7')}
          help={tI18nComplete.raw('text4f370db531ba')}
          value={oc.top_p}
          fallback={1}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setOc('top_p', v)}
        />

        <SettingRow
          label={tI18nComplete.raw('textfdc639c47624')}
          help={tI18nComplete.raw('textbf7ff92baea3')}
        >
          <Input
            aria-label={tI18nComplete.raw('textfdc639c47624')}
            type="number"
            min={1}
            value={oc.steps ?? ''}
            placeholder={tI18nComplete.raw('textf7fcff0d8fea')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <SettingRow
      label={label}
      help={
        isSliderAtDefault(value, fallback) ? (
          help
        ) : (
          <>
            {help} ·{' '}
            <InlineAction onClick={() => onChange(undefined)}>
              {tI18nComplete.raw('textdaee7606b339')}
            </InlineAction>
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
