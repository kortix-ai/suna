/**
 * Pure adapters that translate protocol-native ACP shapes into the UI
 * primitives ported from main (`HarnessModelSelector`, `TodoChip`,
 * `QuestionPrompt`). Kept framework-free and colocated with tests so the
 * mapping rules stay honest as harnesses evolve — no React here.
 */

import type { QuestionAnswer, QuestionRequest } from '@/ui';
import type {
  AcpAvailableCommand,
  AcpPendingOption,
  AcpPendingQuestion,
  AcpPlan,
  AcpSessionConfigOption,
} from '@kortix/sdk';

/** The composer's generic slash-command shape (`Command`, `@/hooks/runtime/
 *  use-runtime-sessions` — re-exported `@kortix/sdk/react` `Command`:
 *  `{name, id?, [key: string]: any}`). Declared structurally here instead of
 *  importing the app-facing type, so this module stays a thin,
 *  framework-free adapter layer. */
type ComposerCommand = { name: string; id: string; description?: string; hint?: string };

/**
 * Maps the connected harness's live, session-scoped `available_commands_update`
 * list (`AcpAvailableCommand[]`, `@kortix/sdk`) onto the composer's generic
 * `Command[]` shape — the "/" palette's discovery half. Execution is
 * unrelated and already worked before this fix (`acp-session-chat.tsx`'s
 * `handleCommand` sends `/${command.name} ${args}` as a normal prompt); this
 * function only turns "what the harness advertises" into "what the popover
 * can render/filter" (`name`/`description` — `session-chat-input.tsx`'s
 * `SlashCommandPopover` filters and displays both).
 */
export function mapAvailableCommandsToComposerCommands(
  commands: readonly AcpAvailableCommand[] | undefined,
): ComposerCommand[] {
  return (commands ?? []).map((command) => ({
    name: command.name,
    id: command.name,
    description: command.description ?? undefined,
    hint: command.hint ?? undefined,
  }));
}

/** Heuristic: does this ACP session config option represent the model choice?
 *  There's no fixed `id`/`category` vocabulary across harness bridges yet, so
 *  match on any of them mentioning "model" — the same signal a human would use
 *  reading the option's own name. */
export function isAcpModelConfigOption(option: AcpSessionConfigOption): boolean {
  const haystack = `${option.id} ${option.category ?? ''} ${option.name ?? ''}`.toLowerCase();
  return /\bmodel\b/.test(haystack);
}

export function findAcpModelConfigOption(
  options: readonly AcpSessionConfigOption[],
): AcpSessionConfigOption | null {
  return options.find(isAcpModelConfigOption) ?? null;
}

/**
 * Every `select`-/`mode`-typed config option a session advertises BESIDES
 * its model option (see {@link findAcpModelConfigOption}) — `mode`/`effort`/
 * `reasoning_effort`/`fast-mode`/etc., whatever the harness sends, with at
 * least one real choice. Extracted verbatim from `acp-session-chat.tsx`'s
 * live-only `otherConfigOptions` derivation (2026-07-14, Task 22/B1) so
 * `composer-chat-input.tsx` can reuse the SAME rule for the pre-session
 * cache/fallback path (`use-harness-config-options-store.ts`) — one filter,
 * shared by both states, so "which options render as pills" can never drift
 * between live and pre-session.
 */
export function otherAcpConfigOptions(
  options: readonly AcpSessionConfigOption[],
  modelOption: AcpSessionConfigOption | null,
): AcpSessionConfigOption[] {
  return options.filter(
    (option) =>
      option !== modelOption &&
      (option.type === 'select' || option.type === 'mode') &&
      (option.options?.length ?? 0) > 0,
  );
}

/**
 * Whether a model-shaped config option is actually something a user can pick
 * from — i.e. worth mounting a real selector for, vs. falling back to the
 * static harness-managed label. `type === 'select'` matches every real
 * payload observed live (claude-agent-acp and codex-acp both stamp `type:
 * 'select'` on their `model` option — verified against
 * `kortix.acp_session_envelopes`, dev DB, 2026-07-21); a missing `type` is
 * treated leniently as selectable too (older/other adapters may omit it),
 * but zero `options` never is — an option with no choices has nothing to
 * pick, so it degrades to the label exactly like "no model option at all"
 * would (never a selector that opens onto an empty list).
 */
export function isWritableAcpModelConfigOption(option: AcpSessionConfigOption | null): boolean {
  if (!option) return false;
  if (option.type !== undefined && option.type !== 'select') return false;
  return (option.options?.length ?? 0) > 0;
}

/** The raw `value`/`id`/`optionId` (falling back to index, matching
 *  `acp-config-option-pills.tsx`'s own `choiceValue`) of one entry in a
 *  `select`-typed config option's `options` array, as a string — the same
 *  identity space `AcpConfigOptionPill`'s `onChange`/`currentValue` compare
 *  against. */
function configOptionChoiceValue(raw: Record<string, unknown>, index: number): string {
  return String(raw.value ?? raw.id ?? raw.optionId ?? index);
}

/**
 * Decides whether a deferred (pre-session) harness-native model pick should
 * actually be sent over `session/set_config_option` once a live session's
 * writable `model` option first arrives — the seam this backs is
 * `composer-chat-input.tsx`'s bootstrap-ready effect (see its doc comment for
 * exactly where that fires).
 *
 * Returns the value to apply, or `null` when nothing should happen:
 * - no deferred pick was ever stored for this agent,
 * - `option` isn't a genuinely writable model option (see
 *   {@link isWritableAcpModelConfigOption}) — nothing to apply it TO,
 * - the deferred pick already matches `option.currentValue` (a no-op RPC call
 *   would just be wasted round-trip latency for zero effect),
 * - the deferred pick isn't one of `option.options`' real advertised values —
 *   a stale pick from a prior adapter version, or from the OTHER harness's
 *   fallback list bleeding in through a bug. Applying an unadvertised value
 *   would either silently no-op server-side or (worse) desync the pill from
 *   what the harness actually has selected — dropping it silently and
 *   letting the harness's own `currentValue` win is the honest behavior the
 *   composer's "never lie" rule requires (see `HarnessManagedModelState`'s
 *   doc comment, `composer-model-controls.tsx`).
 */
export function resolveDeferredModelApply(input: {
  deferredValue: string | null | undefined;
  option: AcpSessionConfigOption | null;
}): string | null {
  if (!input.deferredValue) return null;
  if (!isWritableAcpModelConfigOption(input.option)) return null;
  const option = input.option as AcpSessionConfigOption;
  if (String(option.currentValue ?? '') === input.deferredValue) return null;
  const advertised = (option.options ?? []).some(
    (choice, index) =>
      configOptionChoiceValue(choice as Record<string, unknown>, index) === input.deferredValue,
  );
  return advertised ? input.deferredValue : null;
}

/**
 * The "at most once per session" gate around {@link resolveDeferredModelApply}
 * — a pure extraction of `composer-chat-input.tsx`'s deferred-apply effect's
 * guard, so the "a later live change is never clobbered by re-sending a stale
 * deferred pick" behavior is testable without mounting the component. `false`
 * whenever `sessionId` is missing (no live session to apply anything to), the
 * writable option hasn't arrived yet (nothing to apply against), or this
 * exact `sessionId` was already attempted — `alreadyAttemptedSessionId` is
 * the effect's own ref value, unconditionally overwritten to `sessionId` the
 * moment this returns `true` (see the call site), so a later render for the
 * SAME session — whether the option's `currentValue` moved because the user
 * picked something else live, or a `config_option_update` changed it
 * out-of-band — always returns `false` here and the stale deferred pick is
 * never resent.
 */
export function shouldAttemptDeferredModelApply(input: {
  sessionId: string | null | undefined;
  alreadyAttemptedSessionId: string | null;
  optionAvailable: boolean;
}): boolean {
  if (!input.sessionId || !input.optionAvailable) return false;
  return input.alreadyAttemptedSessionId !== input.sessionId;
}

/** `AcpSessionConfigOption.options` (generic `{value,label,...}` records) into
 *  the `{id,name,source}` preset shape `HarnessModelSelector` expects. */
export function acpConfigOptionPresets(
  option: AcpSessionConfigOption | null,
): Array<{ id: string; name: string; source: string }> {
  if (!option?.options?.length) return [];
  return option.options.map((raw, index) => {
    const record = raw as Record<string, unknown>;
    const id = String(record.value ?? record.id ?? record.optionId ?? index);
    const name = String(record.label ?? record.name ?? record.title ?? id);
    return { id, name, source: 'session' };
  });
}

/** ACP `session/update` plan entries into the `{id,content,status}` shape
 *  `TodoChip` renders. Entries are protocol-untyped (`unknown[]`), so this
 *  degrades gracefully for anything that isn't the expected object shape. */
export function acpTodosFromPlanEntries(
  entries: AcpPlan['entries'] | undefined,
): Array<{ id: string; content: string; status: string }> {
  if (!entries?.length) return [];
  return entries.map((entry, index) => {
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const content = record.content ?? record.title ?? record.text;
      return {
        id: String(record.id ?? index),
        content: typeof content === 'string' ? content : JSON.stringify(entry),
        status: typeof record.status === 'string' ? record.status : 'pending',
      };
    }
    return { id: String(index), content: String(entry), status: 'pending' };
  });
}

/** ACP's pending elicitation/question envelope into the harness-neutral
 *  `QuestionRequest` the ported `QuestionPrompt` chip already renders. */
export function toQuestionRequest(pending: AcpPendingQuestion, sessionId: string): QuestionRequest {
  return {
    id: String(pending.id),
    sessionID: sessionId,
    questions: pending.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      // ACP's projection carries no multi-select signal today — every
      // question is single-select-or-type, matching the option data we get.
      multiple: false,
      custom: question.allowText !== false,
    })),
  };
}

function questionKey(pending: AcpPendingQuestion, index: number): string {
  return pending.questions[index]?.key ?? `answer_${index + 1}`;
}

/** `QuestionPrompt`'s `onReply(id, answers)` gives back one `string[]` of
 *  chosen option *labels* per question (labels double as values in that
 *  component). Map each chosen label back to the option's real `value`/
 *  `optionId` when the option is a known one, and build the
 *  `{ [key]: value }` content object `use-acp-session`'s `respondQuestion`
 *  sends as the ACP `action:'accept'` payload. */
export function buildAcpQuestionContent(
  pending: AcpPendingQuestion,
  answers: QuestionAnswer[],
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  pending.questions.forEach((question, index) => {
    const key = questionKey(pending, index);
    const chosen = answers[index] ?? [];
    const values = chosen.map((label) => {
      const match = question.options.find((option: AcpPendingOption) => option.label === label);
      return match?.value ?? match?.optionId ?? match?.id ?? label;
    });
    content[key] = values.length <= 1 ? (values[0] ?? '') : values;
  });
  return content;
}

/**
 * Whether the connected harness's negotiated `agentCapabilities`
 * (`protocol/v1/initialization.md`, stored on `AcpSessionSnapshot.capabilities`
 * — `session.ts:667`) advertise baseline image content support
 * (`promptCapabilities.image`, per `protocol/v1/content.md`). Permissive by
 * default: `true` when `capabilities` hasn't loaded yet (pre-bootstrap,
 * `{}`) or a harness simply omits the field — only an EXPLICIT `false`
 * blocks it. Verified real: all four currently-integrated harnesses
 * (claude-agent-acp, codex-acp, OpenCode, pi-acp — `kortix.acp_session_envelopes`,
 * local DB, 2026-07-22) advertise `image: true`, so this never changes
 * today's behavior for any of them; it's a defensive gate for a future/
 * different adapter that doesn't. `capabilities` is untyped
 * (`Record<string, unknown>` — the SDK stores the raw negotiated object
 * verbatim), so every layer here is read defensively.
 */
export function acpSupportsImagePrompt(capabilities: Record<string, unknown> | null | undefined): boolean {
  const promptCapabilities = capabilities?.promptCapabilities;
  if (!promptCapabilities || typeof promptCapabilities !== 'object') return true;
  const image = (promptCapabilities as Record<string, unknown>).image;
  return image !== false;
}
