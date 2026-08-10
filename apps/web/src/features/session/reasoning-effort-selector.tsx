'use client';

/**
 * Reasoning-effort control for the session chat composer — shown only for a
 * model that actually exposes a tunable effort knob, driven off the SAME
 * live models.dev capability data (`@kortix/llm-catalog`'s
 * `generationControlCapabilities`) that gates the gateway settings'
 * Generation Controls panel (`generation-controls.tsx`, #4995). Never a
 * hardcoded per-model list — a reasoning model with no `reasoning_options`
 * entry still gets the generic low/medium/high fallback, a model that isn't
 * `reasoning: true` at all gets nothing.
 *
 * *** WHY THIS WRITES A PROJECT-LEVEL SETTING, NOT A PER-MESSAGE ONE ***
 * OpenCode's own message-send payload (`SendMessageOptions` in
 * `@kortix/sdk`'s `use-opencode-sessions/keys.ts`, consumed by
 * `promptRuntimeMessage`) only ever carries `model` / `agent` / `variant` /
 * `directory` — there is no per-message reasoning-effort field to set on a
 * chat send today. Separately, models.dev-sourced models don't populate
 * OpenCode's legacy per-model `variant` map, so a model like
 * `openai/gpt-5.6-sol` has no per-model variant to cycle even though it's
 * very much a reasoning model.
 *
 * The one path that reliably reaches the wire today is the per-project
 * **model_generation_config** the gateway injects at resolution time —
 * `packages/llm-gateway/src/pipeline/generation-defaults.ts` merges it into
 * the outbound OpenAI-shaped body (`reasoning_effort`) for any field the
 * client didn't already set, and `apps/api/src/llm-gateway/routing/
 * resolve-route.ts` re-clamps + supplies it per request from
 * `project_llm_routing_policies.model_generation_config` (same table/API the
 * Gateway → Routing settings page's "Generation defaults" panel writes).
 * This component reads/writes that same config, scoped to
 * (this project, this exact wire model) — every session in the project
 * sending to this model picks up the change immediately, and an explicit
 * per-request value (should OpenCode ever grow one) would still win, since
 * injection only ever fills a field the client left unset.
 *
 * Writing requires the `gateway.routing-policy` PUT's capability gate
 * (`PROJECT_CUSTOMIZE_WRITE`, editor+) — a plain project member can see the
 * currently configured effort but not change it; the control disables with
 * an explanatory tooltip in that case rather than hiding outright, so it
 * stays discoverable.
 */

import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { catalogModelForGateway } from '@/features/workspace/customize/sections/view/gateway/generation-controls';
import { cn } from '@/lib/utils';
import { modelKeyToWire } from '@kortix/sdk/react';
import { generationControlCapabilities } from '@kortix/llm-catalog';
import type { GatewayProjectRoutingPolicy } from '@kortix/sdk';
import { useGatewayRoutingPolicy } from '@kortix/sdk/react';
import { BrainIcon, CaretDownIcon } from '@phosphor-icons/react';

export interface ReasoningEffortModelKey {
  providerID: string;
  modelID: string;
}

export interface ReasoningEffortControl {
  /** False when the model has no reasoning-effort knob, or there's no
   *  project to scope the setting to — render nothing. */
  visible: boolean;
  /** The model's own effort labels (e.g. ['none','low','medium','high','xhigh','max']). */
  values: string[];
  /** Currently configured effort for this (project, model), or null = model default. */
  current: string | null;
  /** Whether the current user can change it (editor+ on the project). */
  canWrite: boolean;
  /** Initial load or a write in flight. */
  pending: boolean;
  wireModel: string | undefined;
  setEffort: (next: string | null) => void;
}

/**
 * The model's own effort labels for the composer to offer — the show/hide
 * source of truth. Pure wrapper around `@kortix/llm-catalog`'s
 * `generationControlCapabilities` so it's testable without mounting React or
 * a query client; a model with no reasoning-effort knob returns `[]`, which
 * is exactly what makes the control render nothing.
 */
export function reasoningEffortValuesFor(wireModel: string | undefined): string[] {
  if (!wireModel) return [];
  const catalogModel = catalogModelForGateway(wireModel);
  return generationControlCapabilities(catalogModel).reasoningEffort?.values ?? [];
}

/**
 * Merge a new (or cleared) reasoning-effort choice for `wireModel` into a
 * project's `modelGenerationConfig`, preserving any other generation-config
 * fields already set for that model (temperature, topP, maxOutputTokens) and
 * every OTHER model's entry untouched. `next: null` clears the override back
 * to "model default"; if that empties the model's entry entirely, the key is
 * dropped rather than left as `{}`. Pure — no network, no React — so the
 * exact object the PUT would send is directly assertable in a test.
 */
export function applyReasoningEffort(
  modelGenerationConfig: GatewayProjectRoutingPolicy['modelGenerationConfig'],
  wireModel: string,
  next: string | null,
): GatewayProjectRoutingPolicy['modelGenerationConfig'] {
  const current = modelGenerationConfig ?? {};
  const { reasoningEffort: _currentEffort, ...restForModel } = current[wireModel] ?? {};
  const entry = next ? { ...restForModel, reasoningEffort: next } : restForModel;
  const otherEntries = Object.entries(current).filter(([key]) => key !== wireModel);
  return Object.fromEntries(
    Object.keys(entry).length > 0 ? [...otherEntries, [wireModel, entry]] : otherEntries,
  );
}

/**
 * Derive show/hide + values + current value + write mechanics for the
 * reasoning-effort control on a given (model, project). Thin React/query
 * wiring over the two pure functions above.
 */
export function useReasoningEffortControl(
  model: ReasoningEffortModelKey | null | undefined,
  projectId: string | undefined,
): ReasoningEffortControl {
  const wireModel = model ? modelKeyToWire(model) : undefined;
  const values = useMemo(() => reasoningEffortValuesFor(wireModel), [wireModel]);
  const routing = useGatewayRoutingPolicy(projectId);

  const current =
    wireModel && routing.data
      ? (routing.data.project.modelGenerationConfig?.[wireModel]?.reasoningEffort ?? null)
      : null;
  const canWrite = routing.data?.capabilities?.write ?? false;

  const setEffort = (next: string | null) => {
    if (!wireModel || !projectId || !routing.data) return;
    const policy: GatewayProjectRoutingPolicy = routing.data.project;
    routing.set.mutate({
      ...policy,
      modelGenerationConfig: applyReasoningEffort(policy.modelGenerationConfig, wireModel, next),
    });
  };

  return {
    visible: !!projectId && values.length > 0,
    values,
    current,
    canWrite,
    pending: !!projectId && (routing.isLoading || routing.set.isPending),
    wireModel,
    setEffort,
  };
}

/**
 * The value `setEffort(null)` means: no project override, let the model decide.
 * A sentinel is needed because Radix's radio group addresses items by string
 * and cannot carry `null`.
 */
const AUTO = '__auto__';

/** `medium` → `Medium`. The catalog ships lowercase ids; the trigger and the
 *  menu should not. */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface ReasoningEffortSelectorProps {
  model: ReasoningEffortModelKey | null | undefined;
  projectId: string | undefined;
  /**
   * Controlled open state — omit and the trigger owns it. Supplied by
   * `composer.tsx` so the `/` palette's "Set reasoning effort" row can open
   * this directly. Same controlled/uncontrolled rule as `ModelSelector`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Reasoning effort as its own composer-toolbar control.
 *
 * It previously lived as a chip row folded into the bottom of the model
 * popover. That put a per-project setting two clicks deep behind a per-message
 * one, and — because the popover only renders that footer once a model is
 * selected and the section is non-empty — made it invisible at rest, so
 * nothing in the composer showed the effort a turn would actually run at. As a
 * peer of the model pill it states its own value without being opened.
 *
 * Renders NOTHING when `visible` is false — the model exposes no effort knob,
 * or there is no project to scope the setting to. That is the same gate the
 * folded-in row used, so a model without reasoning never grows a dead control.
 *
 * A `DropdownMenu` rather than the `CommandPopover` the model and agent
 * pickers use: this is a fixed list of four to six values with no search, no
 * grouping and no empty state, and `DropdownMenuRadioGroup` gives the
 * single-select semantics — roving focus, typeahead, `aria-checked` — for
 * free, where the command palette would need them re-implemented.
 */
export function ReasoningEffortSelector({
  model,
  projectId,
  open: openProp,
  onOpenChange,
}: ReasoningEffortSelectorProps) {
  const { visible, values, current, canWrite, pending, setEffort } = useReasoningEffortControl(
    model,
    projectId,
  );

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const onValueChange = useCallback(
    (next: string) => setEffort(next === AUTO ? null : next),
    [setEffort],
  );

  if (!visible) return null;

  const locked = !canWrite;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Hint
        side="top"
        label={
          locked
            ? 'Only project editors can change reasoning effort for this model'
            : 'Reasoning effort — how much the model thinks before answering'
        }
        delayDuration={400}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // `aria-disabled`, not `disabled`: a viewer must still be able to
            // focus this and read the hint explaining why it is locked.
            // `disabled` would make it unreachable by keyboard and strip the
            // hint with it, which is how a permission boundary turns into
            // "the control is just missing".
            aria-disabled={locked || pending || undefined}
            onClick={(e) => {
              if (locked || pending) e.preventDefault();
            }}
            className={cn(
              'text-foreground/70 gap-1.5 rounded-full',
              (locked || pending) && 'cursor-not-allowed opacity-60',
            )}
          >
            <BrainIcon className="size-4 shrink-0" />
            <span className="max-w-[7rem] truncate">{current ? label(current) : 'Auto'}</span>
            <CaretDownIcon className={cn('size-3 opacity-50', open && 'rotate-180')} />
          </Button>
        </DropdownMenuTrigger>
      </Hint>

      <DropdownMenuContent side="top" align="start" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={current ?? AUTO} onValueChange={onValueChange}>
          {/* Auto is first and always present: it is the only way BACK to the
              model's own default once an override is set, and without it the
              control would be a one-way door. */}
          <DropdownMenuRadioItem value={AUTO} disabled={locked || pending}>
            Auto
          </DropdownMenuRadioItem>
          {values.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} disabled={locked || pending}>
              {label(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
