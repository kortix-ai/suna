'use client';

/**
 * The agent page's Model view, in the Settings dialect the rest of the agent
 * page uses (`EditorSection` in `panel` style): a title per group, no
 * sentence under it, and the settings as rows in one bordered group. The
 * model (the project default or a pinned one) and its thinking effort, then
 * sampling and limits, then the provider options. Every control writes the
 * page's draft through `setOc`, the same keys `ModelSection` writes.
 */

import { type RuntimeAgentConfig, modelRefToKey } from '@kortix/sdk';
import { flattenModels, modelKeyToWire, modelProviderMode, useRuntimeProviders } from '@kortix/sdk/react';
import { type ReactNode, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { Input } from '../../primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Slider } from '../../primitives/slider';
import { Textarea } from '../../primitives/textarea';
import { ModelSelector } from '../../session/models/model-selector';
import { isSliderAtDefault } from '../sections/view/agent-editor-basics-fields';
import {
  EditorSection,
  EditorSectionStyleProvider,
  SettingBlock,
  SettingRow,
} from '../sections/view/agent-editor-primitives';

type SetRuntime = <K extends keyof RuntimeAgentConfig>(key: K, value: RuntimeAgentConfig[K]) => void;

/** The select's value for "no variant": the model decides. */
const AUTO = '__auto__';

/** A slider that can be unset: `—` and no Reset while it follows the default. */
function SliderField({
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
  help: ReactNode;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | undefined) => void;
}) {
  const t = useI18nTranslations('agentEditor.modelView');
  return (
    <SettingBlock label={label} help={help}>
      <div className="flex items-center gap-4">
        <Slider
          className="flex-1"
          value={[value ?? fallback]}
          min={min}
          max={max}
          step={step}
          thumbLabel={label}
          formatValue={(v) => v.toFixed(2)}
          onValueChange={([v]) => onChange(v)}
        />
        <div className="flex w-24 shrink-0 items-baseline justify-end gap-2.5 text-sm tabular-nums">
          {isSliderAtDefault(value, fallback) ? null : (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-muted-foreground hover:text-foreground transition-colors duration-fast"
            >
              {t('reset')}
            </button>
          )}
          <span className={value === undefined ? 'text-muted-foreground' : 'text-foreground'}>
            {value === undefined ? '—' : value.toFixed(2)}
          </span>
        </div>
      </div>
    </SettingBlock>
  );
}

/** `options` as JSON: the draft changes only when the text parses to an object. */
function ProviderOptions({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
}) {
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [invalid, setInvalid] = useState(false);
  const commit = (next: string) => {
    setText(next);
    if (!next.trim()) {
      setInvalid(false);
      return onChange(undefined);
    }
    try {
      const parsed: unknown = JSON.parse(next);
      const ok = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      setInvalid(!ok);
      if (ok) onChange(parsed as Record<string, unknown>);
    } catch {
      setInvalid(true);
    }
  };
  return (
    // The section title names it; the row holds the rule and the field.
    <div className="space-y-2.5 px-4 py-3">
      <p className="text-muted-foreground text-xs leading-normal text-pretty">{tTabs('providerOptionsHelp')}</p>
      <Textarea
        aria-label={tTabs('providerOptions')}
        value={text}
        placeholder='{ "reasoning": "high" }'
        className="min-h-20 font-mono text-xs"
        aria-invalid={invalid || undefined}
        onChange={(e) => commit(e.target.value)}
      />
      {invalid ? <p className="text-destructive text-xs">{tTabs('providerOptionsInvalid')}</p> : null}
    </div>
  );
}

export function AgentModelView({ oc, setOc, footer }: { oc: RuntimeAgentConfig; setOc: SetRuntime; footer?: ReactNode }) {
  const t = useI18nTranslations('agentEditor.modelView');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const { data: providers } = useRuntimeProviders();
  const models = flattenModels(providers, { providerMode: modelProviderMode(providers) });
  const pinned = oc.model ? modelRefToKey(oc.model) : null;
  const pinnedModel = pinned
    ? models.find((m) => m.providerID === pinned.providerID && m.modelID === pinned.modelID)
    : undefined;
  // The pinned model's published variants: the composer's thinking-effort choices.
  const variants = pinnedModel?.variants ? Object.keys(pinnedModel.variants) : [];

  return (
    <EditorSectionStyleProvider value="panel">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <EditorSection title={t('title')} lead>
          <SettingRow
            label={pinned ? (pinnedModel?.modelName ?? pinned.modelID) : t('projectDefault')}
            help={
              pinned ? (
                <>
                  {t('pinned')} ·{' '}
                  <button
                    type="button"
                    onClick={() => setOc('model', undefined)}
                    className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4 transition-colors"
                  >
                    {t('followDefault')}
                  </button>
                </>
              ) : (
                t('followsDefault')
              )
            }
          >
            <div className="flex sm:justify-end">
              <ModelSelector
                models={models}
                providers={providers}
                selectedModel={pinned}
                unsetLabel={t('pinModel')}
                triggerVariant="secondary"
                onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
              />
            </div>
          </SettingRow>
          <SettingRow
            label={t('thinkingEffort')}
            help={variants.length > 0 ? (oc.variant ? t('effortSetHelp') : t('effortAutoHelp')) : t('effortNoVariantsHelp')}
          >
            {variants.length > 0 ? (
              <Select
                value={oc.variant && variants.includes(oc.variant) ? oc.variant : AUTO}
                onValueChange={(v) => setOc('variant', v === AUTO ? undefined : v)}
              >
                <SelectTrigger aria-label={t('thinkingEffort')} size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>{t('auto')}</SelectItem>
                  {variants.map((v) => (
                    <SelectItem key={v} value={v} className="capitalize">
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label={t('thinkingEffort')}
                value={oc.variant ?? ''}
                placeholder={t('auto')}
                className="h-8"
                onChange={(e) => setOc('variant', e.target.value || undefined)}
              />
            )}
          </SettingRow>
        </EditorSection>

        <EditorSection title={t('samplingTitle')}>
          <SliderField
            label={t('temperature')}
            help={`${t('temperatureMin')} · ${t('temperatureMax')}`}
            value={oc.temperature}
            fallback={0}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => setOc('temperature', v)}
          />
          <SliderField
            label={t('topP')}
            help={t('topPHelp')}
            value={oc.top_p}
            fallback={1}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setOc('top_p', v)}
          />
          <SettingRow label={t('stepLimit')} help={t('stepLimitHelp')}>
            <div className="relative">
              <Input
                aria-label={t('stepLimit')}
                type="number"
                min={1}
                value={oc.steps ?? ''}
                placeholder={t('noLimit')}
                className="h-8 pr-12 tabular-nums"
                onChange={(e) => setOc('steps', e.target.value ? Math.max(1, Number(e.target.value)) : undefined)}
              />
              <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">
                {t('steps')}
              </span>
            </div>
          </SettingRow>
        </EditorSection>

        <EditorSection title={tTabs('providerOptions')}>
          <ProviderOptions value={oc.options} onChange={(next) => setOc('options', next)} />
        </EditorSection>
        {footer}
      </div>
    </EditorSectionStyleProvider>
  );
}
