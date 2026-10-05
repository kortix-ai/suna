/**
 * The composer's model / effort / agent selection, held entirely in the SDK.
 *
 * There is no local selection state here, and that is the point. Each of the
 * three toggles writes to the exact SDK store `useSession`'s own `send` reads,
 * so a pick made in the TUI applies to the very next prompt without the host
 * passing anything down:
 *
 *  - **model** → `session.picks.setModel(key)` (`useSessionPicks`, per session).
 *    `useSession.sendParts` reads `picks.model` when the call gives no override
 *    (`use-session.ts:1218`), so this IS the send path.
 *  - **agent** → `session.picks.setAgent(name)` (same store, `:1219`).
 *  - **effort** → `session.picks.setVariant(value)`. `SessionPicks` carries the
 *    variant, and `sendParts` falls back to `picks.variant` exactly as it
 *    already did for model and agent, so the composer no longer passes an
 *    override on every send and no longer keeps the effort in a store of its
 *    own. The effort is now per SESSION, not per model: a variant the newly
 *    picked model does not publish reads as `Auto` (see `variant` below) and
 *    the next explicit choice replaces it.
 *
 * `useModelStore` survives for ONE thing — `pushRecent`, which orders the model
 * picker. It is no longer consulted for the effort.
 *
 * Under Bun neither store reaches a disk: `useSessionPicks` catches the
 * `localStorage is not defined` ReferenceError and `useModelStore` guards on
 * `typeof window`. Both therefore persist for the life of the process, which is
 * the life of the TUI. Nothing is silently dropped and nothing throws.
 */

import { type FlatModel, type ModelKey, useModelDefaults, useModelStore } from '@kortix/sdk/react';
import { useCallback, useMemo } from 'react';

import { type ModelGroup, groupModels } from './model-groups.ts';

/** The slice of `useSession`'s result this hook needs. */
export interface ComposerSelectionSession {
  models: FlatModel[];
  agents: ReadonlyArray<{ name: string; description?: string | null; mode?: string }>;
  defaultAgent: string | null;
  /** The immutable agent the session was created with, or null. */
  agentName?: string | null;
  picks: {
    model: ModelKey | null;
    agent: string | null;
    /** Reasoning effort, persisted per session by `useSessionPicks`. */
    variant: string | null;
    setModel: (model: ModelKey | null) => void;
    setAgent: (agent: string | null) => void;
    setVariant: (variant: string | null) => void;
  };
}

export interface ComposerAgent {
  name: string;
  description: string | null;
  isDefault: boolean;
}

export interface ComposerSelection {
  models: FlatModel[];
  groups: ModelGroup[];
  /** The picked model, resolved against the catalog. Undefined when none. */
  model: FlatModel | undefined;
  /** What the footer prints for the model toggle. */
  modelLabel: string;
  /** True when no explicit pick is active and the label is a resolved default. */
  modelIsDefault: boolean;
  setModel: (key: ModelKey | null) => void;

  agents: ComposerAgent[];
  agent: string | null;
  agentLabel: string;
  setAgent: (name: string | null) => void;

  /** The selected model's effort ids (`Object.keys(model.variants)`). */
  variants: string[];
  variant: string | null;
  variantLabel: string;
  setVariant: (value: string | null) => void;
}

/** `medium` → `Medium`. The catalog ships lowercase ids; the toggle must not. */
export function effortLabel(value: string | null): string {
  if (!value) return 'Auto';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The effort choices for a model: its own variant ids, de-duplicated, order
 * preserved. Empty when the model publishes none — the toggle then reads
 * "Auto" and the picker says so rather than offering a dead list.
 */
export function effortChoices(model: FlatModel | undefined): string[] {
  const variants = model?.variants ? Object.keys(model.variants) : [];
  return Array.from(new Set(variants.filter((value) => typeof value === 'string' && value)));
}

function sameModel(a: ModelKey | null | undefined, b: { providerID: string; modelID: string }) {
  return !!a && a.providerID === b.providerID && a.modelID === b.modelID;
}

export function useComposerSelection(
  session: ComposerSelectionSession,
  projectId: string,
): ComposerSelection {
  const models = session.models;
  const groups = useMemo(() => groupModels(models), [models]);
  const store = useModelStore(models);
  const defaults = useModelDefaults(projectId);

  const agent = session.picks.agent ?? session.agentName ?? session.defaultAgent ?? null;

  // With no explicit pick, the send goes out under the server-resolved default
  // (agent → project → account → platform). Print THAT, not "Default": the
  // toggle states the model the next prompt will really use.
  const resolvedDefault = defaults.resolveDefaultFor(agent ?? undefined);
  const activeKey = session.picks.model ?? resolvedDefault ?? null;
  const model = useMemo(
    () => (activeKey ? models.find((candidate) => sameModel(activeKey, candidate)) : undefined),
    [models, activeKey],
  );

  const variants = useMemo(() => effortChoices(model), [model]);
  const storedVariant = session.picks.variant;
  // A variant the current model does not publish reads as Auto rather than an
  // unlabelled value; the next explicit choice replaces it. The send path
  // applies `picks.variant` verbatim, so this is a DISPLAY rule — switching to
  // a model without that variant shows Auto, and picking any effort rewrites
  // the pick.
  const variant = storedVariant && variants.includes(storedVariant) ? storedVariant : null;

  const setModel = useCallback(
    (key: ModelKey | null) => {
      session.picks.setModel(key);
      if (key) store.pushRecent(key);
    },
    [session.picks, store],
  );

  const setVariant = session.picks.setVariant;

  const agents = useMemo<ComposerAgent[]>(
    () =>
      session.agents.map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        isDefault: entry.name === session.defaultAgent,
      })),
    [session.agents, session.defaultAgent],
  );

  return {
    models,
    groups,
    model,
    modelLabel: model?.modelName ?? (activeKey ? activeKey.modelID : 'Model'),
    modelIsDefault: !session.picks.model,
    setModel,

    agents,
    agent,
    agentLabel: agent ?? 'Agent',
    setAgent: session.picks.setAgent,

    variants,
    variant,
    variantLabel: effortLabel(variant),
    setVariant,
  };
}
