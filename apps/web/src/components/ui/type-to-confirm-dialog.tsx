'use client';

/**
 * A destructive confirmation that only arms once the user has TYPED an exact
 * phrase — the workspace name, the account name, whatever uniquely identifies
 * the thing being destroyed.
 *
 * **When to use this instead of `ConfirmDialog`.** `ConfirmDialog`
 * (`confirm-dialog.tsx`) stays the default for every destructive mutation:
 * revoke a key, delete a secret, disconnect a channel. Reach for THIS one only
 * when the action is both irreversible AND ambiguous — i.e. the user could
 * plausibly be looking at the wrong entity. A single click, even a confirmed
 * one, does not distinguish "delete this workspace" from "delete the workspace
 * I meant". Typing the name does.
 *
 * **Why `Modal` and not `AlertDialog`.** The moment a confirmation grows an
 * input it is a form, and `ConfirmDialog`'s `AlertDialog` shell has no room for
 * one. `profile-tab.tsx`'s Delete-account flow already made this call (it
 * hand-rolls a `Modal` with a "type delete to confirm" field); this component
 * is that same pattern promoted to a primitive so the next destructive flow
 * composes it instead of copying it. Profile's own dialog is deliberately left
 * alone here — it carries an extra grace-period radio group, so adopting this
 * is its own change, not a drive-by.
 *
 * **Why the phrase is the entity's name, not a fixed word.** A fixed word
 * ("delete", "DELETE") proves the user read a prompt. The entity's name proves
 * the user knows WHICH entity they are destroying. The expensive mistake in
 * practice is not clicking too fast — it is clicking correctly on the wrong
 * workspace.
 *
 * The matcher is `confirmationPhraseMatches` below, exported and tested
 * separately: this dialog renders through a Radix portal, which emits nothing
 * under `renderToStaticMarkup`, so a test that reached for the button's
 * `disabled` attribute in rendered output would silently be unable to fail.
 * See `type-to-confirm-dialog.test.ts`.
 */

import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';

/**
 * Does what the user typed authorize the destructive action?
 *
 * Three deliberate rules, each guarding a specific failure:
 *
 * 1. **An empty/blank `phrase` NEVER arms.** This is the important one. The
 *    phrase is usually a name read out of a query (`project?.name`), which is
 *    `undefined` while that query is still loading. A naive
 *    `typed === phrase` would then compare `'' === ''` and arm the destroy
 *    button on an untouched dialog — the precise opposite of this component's
 *    reason to exist.
 * 2. **Both sides are trimmed.** Names get copied out of the surrounding UI and
 *    arrive with a trailing space. Leading/trailing whitespace is a paste
 *    artifact, never intent, and rejecting it only teaches users to distrust
 *    the field.
 * 3. **The comparison is case-insensitive.** Case adds friction without adding
 *    safety: the guarantee being bought is "the user knows which entity this
 *    is", and typing `acme prod` for `Acme Prod` demonstrates that fully. A
 *    case-sensitive match would reject it and buy nothing.
 */
export function confirmationPhraseMatches(typed: string, phrase: string): boolean {
  const target = phrase.trim();
  if (!target) return false;
  return typed.trim().toLowerCase() === target.toLowerCase();
}

export interface TypeToConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stable across entities — "Delete workspace?", not "Delete Acme?". The
   *  entity's name belongs in `description`, where it does not make the
   *  heading jump around between openings. */
  title: string;
  /** One or two sentences naming the entity and the irreversibility. */
  description: ReactNode;
  /** What the action destroys or stops, one item per line. Rendered as a
   *  bulleted list inside a bordered panel. Static per call site, so index
   *  keys are safe. */
  consequences?: readonly ReactNode[];
  /** Heading above `consequences`. */
  consequencesTitle?: string;
  /** What SURVIVES the action. Optional, but include it whenever something
   *  meaningful does — a user who has just been told "this is permanent"
   *  reads an unqualified warning as "my code is gone too". */
  reassurance?: ReactNode;
  /** The exact string the user must type. While this is blank the confirm
   *  button never arms — see `confirmationPhraseMatches`. */
  confirmPhrase: string;
  /** Verb phrase for the armed button, e.g. "Delete workspace". */
  confirmLabel: string;
  /** Non-destructive dismissal. Phrase it as the safe outcome ("Keep
   *  workspace"), not as a neutral "Cancel" — at the moment of decision the
   *  escape hatch should read as a choice, not an abort. */
  cancelLabel?: string;
  onConfirm: () => void;
  isPending?: boolean;
}

export function TypeToConfirmDialog({ open, onOpenChange, ...content }: TypeToConfirmDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        {/* The typed text lives in `TypeToConfirmBody`, one level down, and
            that is load-bearing rather than tidiness. Radix unmounts portal
            children on close, so the state is born fresh on every open — which
            is what stops the "type the name, dismiss, reopen, find the button
            already armed" bug WITHOUT a reset effect. State that has to be
            reset by an effect is state whose remount boundary is in the wrong
            place. */}
        <TypeToConfirmBody onOpenChange={onOpenChange} {...content} />
      </ModalContent>
    </Modal>
  );
}

function TypeToConfirmBody({
  onOpenChange,
  title,
  description,
  consequences,
  consequencesTitle = 'This removes:',
  reassurance,
  confirmPhrase,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  isPending = false,
}: Omit<TypeToConfirmDialogProps, 'open'>) {
  const [typed, setTyped] = useState('');
  const inputId = useId();

  // Derived, never stored: if `confirmPhrase` changes while the dialog is open
  // (the entity is renamed in another tab), the button disarms on the next
  // render instead of holding a stale "armed" flag.
  const armed = confirmationPhraseMatches(typed, confirmPhrase);
  const canSubmit = armed && !isPending;

  return (
    <>
      <ModalHeader className="space-y-1.5">
        <ModalTitle>{title}</ModalTitle>
        <ModalDescription className="text-pretty">{description}</ModalDescription>
      </ModalHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Guarded, not just visually disabled: Enter in the text field
          // submits the form, and a disabled button does not stop that.
          if (canSubmit) onConfirm();
        }}
      >
        <ModalBody>
          {consequences?.length ? (
            <div className="bg-popover space-y-2 rounded-md border px-4 py-3">
              <p className="text-sm font-medium">{consequencesTitle}</p>
              <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm text-pretty">
                {consequences.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {reassurance ? (
            <p className="text-muted-foreground text-sm text-pretty">{reassurance}</p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={inputId} className="text-sm font-normal">
              Type{' '}
              {/* The phrase is shown, not memorised. Hiding it would only
                    convert a deliberateness check into a recall test, and the
                    user would go read the name off the page behind the dialog
                    anyway. `break-all` keeps a long name from widening the
                    modal. */}
              <span className="text-foreground font-medium break-all">{confirmPhrase}</span> to
              confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              // Radix focuses the first tabbable child on open, which is this
              // input — the user can start typing immediately.
              aria-describedby={`${inputId}-hint`}
            />
            {/* Read on focus (via aria-describedby) AND announced at the
                moment it flips (via aria-live). Without the live region a
                screen-reader user gets no signal that the button armed — the
                confirm button is `disabled`, so it is not in the tab order to
                be discovered. The text only changes once, at the
                disarmed→armed boundary, so this does not chatter per
                keystroke. */}
            <p id={`${inputId}-hint`} className="sr-only" aria-live="polite">
              {armed
                ? `Confirmed. ${confirmLabel} is now enabled.`
                : `Type the exact name to enable ${confirmLabel}.`}
            </p>
          </div>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={!canSubmit}
            className="w-full gap-1.5 sm:w-auto"
          >
            {isPending ? <Loading className="size-4 shrink-0" /> : null}
            {confirmLabel}
          </Button>
        </ModalFooter>
      </form>
    </>
  );
}
