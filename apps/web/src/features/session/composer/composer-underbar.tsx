'use client';

import { useTranslations } from 'next-intl';

import type { Agent, MessageWithParts } from '@kortix/sdk/react';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import type { FlatModel } from '../model-flatten';
import { AgentSelector } from './agent-selector';
import { NO_AGENT_ACCESS_MESSAGE } from './composer-agent-access';
import { TokenProgress } from './token-progress';

/** `AgentSelector.onSelect` is required, but a LOCKED picker never calls it.
 *  Module-level so the memoized selector isn't handed a fresh inline arrow on
 *  every keystroke in the editor above it. */
const NO_AGENT_SELECT = () => {};

/** Stable identity so the empty roster doesn't remount the picker per render. */
const EMPTY_AGENTS: Agent[] = [];

/**
 * The row directly BELOW the composer card.
 *
 * What you BRING to the message — files, agent — sits left; what it COSTS —
 * the context ring — sits hard right. Both moved out of `ComposerToolbar`
 * (which stays inside the card) on purpose: the card holds the message and
 * the controls that shape the reply (model, effort, voice, send), and these
 * three are neither. They are also the two ends of one sentence, which is why
 * this is a single `justify-between` row and not two clusters.
 *
 * Extracted rather than inlined into `composer.tsx` for one concrete reason:
 * `Composer` cannot mount without an `AuthProvider` (`useRuntimeSessions`), so
 * the matrix-row-18 regression test — the ring must never be hidden at a
 * breakpoint — would have had nothing to render. See `composer-underbar.test.tsx`.
 */
export interface ComposerUnderbarProps {
  onAttachClick: () => void;

  /** Already filtered to non-hidden, non-subagent agents (`primaryAgents` in
   *  composer.tsx) — this component does no further filtering. */
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  agentSelectorLocked: boolean;
  /**
   * The roster loaded and this user may run NOTHING here (deny-by-default
   * project agents). The picker is rendered anyway — disabled, saying so —
   * because hiding it is what made the empty case indistinguishable from a
   * normal composer right up to the server's 403.
   */
  noAccessibleAgents?: boolean;

  messages: MessageWithParts[] | undefined;
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onContextClick?: () => void;
  /**
   * `'row'` (default) is the rail beneath the card: `justify-between`, so what
   * you bring sits left and what it costs sits hard right.
   *
   * `'inline'` is the same controls folded onto the toolbar itself, ahead of
   * the model selector. Project Home is a HERO composer floating mid-page, so
   * a second rail hanging under it has no column to align to and reads as a
   * detached strip; there the controls belong on the one bar. Nothing is
   * duplicated for it — same component, different packing.
   */
  variant?: 'row' | 'inline';
  toolbarSlot?: React.ReactNode;
}

export function ComposerUnderbar({
  onAttachClick,
  agents,
  selectedAgent,
  onAgentChange,
  agentSelectorLocked,
  noAccessibleAgents = false,
  messages,
  models,
  selectedModel,
  onContextClick,
  variant = 'row',
  toolbarSlot,
}: ComposerUnderbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  /*
    The agent picker is UNCONDITIONAL. It used to earn its slot
    (`agents.length > 0 && (onAgentChange || agentSelectorLocked)`), and that
    condition is exactly how a prompt went out with no agent on screen: the
    roster came back empty for a member with no grant, the control vanished,
    the composer looked entirely normal, and the server ran its manifest
    default. Nothing may send until the agent that will run is VISIBLE, so the
    control that shows it cannot be conditional. An empty roster renders it
    inert (see `AgentSelector`), never absent.
  */

  /*
    The horizontal padding here is an OPTICAL value, tuned by eye, not a
    derived one — leave it to whoever is looking at the screen. What it is
    fighting, for context: this row is a sibling of the card, so it measures
    from the card's BORDER, while the toolbar's controls measure from the
    card's content box (`composer.tsx`'s inner column `px-2`, plus whatever the
    toolbar row itself carries). The two rails therefore do not agree for free,
    and this padding is what reconciles them. If the composer's inner padding
    ever changes, this is the value that has to move with it.

    The one hard rule: no `hidden`/`sm:` display class on this row or anything
    between it and the ring. That exact regression removed the only route to
    the context modal on a phone, and `composer-underbar.test.tsx` asserts it.
    Same reason the gutter above (`COMPOSER_SHELL_CLASS`) may be trimmed by a
    breakpoint but never zeroed by one.
  */
  const inline = variant === 'inline';

  return (
    // `kortix-composer-underbar` is not decoration — `globals.css` hangs the
    // coarse-pointer 40×40 minimum off it. Without the class this row's
    // buttons stayed 32px on touch while the identical controls inside
    // `.kortix-composer-toolbar` were 40px.
    <div
      className={
        inline
          ? 'kortix-composer-underbar flex min-w-0 items-center gap-1'
          : 'kortix-composer-underbar flex items-center justify-between gap-2 px-px pt-1.5 pb-2'
      }
    >
      <div className="flex min-w-0 items-center gap-1">
        <Hint
          side="top"
          label={tHardcodedUi.raw('componentsSessionSessionChatInput.line2252JsxTextAttachFiles')}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-base"
            onClick={onAttachClick}
            aria-label="Attach files"
            // `hit-area-1` — the same extension the toolbar's send/voice
            // buttons carry. The visible chip stays 32px; the pressable box
            // grows to 40, on a mouse as well as on a finger.
            className="text-muted-foreground hit-area-1 rounded-lg"
          >
            <Paperclip className="size-4 shrink-0" />
          </Button>
        </Hint>

        <AgentSelector
          agents={noAccessibleAgents ? EMPTY_AGENTS : agents}
          selectedAgent={selectedAgent}
          onSelect={onAgentChange ?? NO_AGENT_SELECT}
          disabled={agentSelectorLocked}
          triggerLabelClassName="max-w-[7rem]"
          unavailableHint={noAccessibleAgents ? NO_AGENT_ACCESS_MESSAGE : undefined}
        />
      </div>

      <div className="flex items-center gap-1">
        {inline && !messages ? null : (
          <TokenProgress
            messages={messages}
            models={models}
            selectedModel={selectedModel}
            onContextClick={onContextClick}
          />
        )}

        {toolbarSlot}
      </div>
    </div>
  );
}
