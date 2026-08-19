/**
 * Whether a `/` command submission may carry the composer's attachments.
 *
 * It may not, and the honest answer is to say so.
 *
 * `handleSubmit`'s command branch used to ignore `attachedFiles` completely
 * and then clear them — revoking every `blob:` URL on the way out. Attach a
 * screenshot, run `/webapp`, and the screenshot was gone with nothing on
 * screen to say it had ever existed. The queued command path introduced in
 * `27279d2232` inherited the same hole: it passes `undefined` for files.
 *
 * ## Why refuse instead of carrying the files
 *
 * Carrying them is the better product outcome and it is not reachable from
 * here. The wire call is `client.session.command(...)`, which opencode does
 * accept a `parts` array for — but every layer between this composer and that
 * call drops it: `useSession.runCommand(command, args, options)` takes no
 * parts, `buildSessionCommandInput` builds `{sessionId, command, args, agent,
 * model, variant}`, and `executeOpenCodeCommand` forwards exactly those six
 * fields. All three live in `@kortix/sdk`, and a host must never reach past
 * the SDK to the opencode client (see the repo's SDK rules). So the file parts
 * cannot be delivered without a change to the published package.
 *
 * Refusing keeps the one property that matters: nothing the user attached is
 * ever destroyed without being sent or reported. The composer disables submit,
 * shows the reason inline, and keeps every file — so the user picks which of
 * the two things they meant, with both still in front of them.
 *
 * Pure, and tested, because `composer.tsx` cannot be: `apps/web` has no DOM
 * harness, and the composer sits behind a `React.lazy` boundary.
 */

/**
 * The `data-*` attribute a mention chip renders its kind into, and the value a
 * `/` command chip carries — see `editor/mention-node.ts`'s `addAttributes`.
 *
 * The composer needs to know a command chip is in the draft *while the user is
 * typing*, not only at submit: the warning has to appear before anything can
 * be lost. The editor's `onEmptyChange` fires only on the empty↔non-empty
 * boundary (`trackEmptyBoundary`), so it cannot see a chip inserted into an
 * already-non-empty draft. Querying the editor's DOM for the chip is what is
 * available without changing the editor's props, and `command-attachments.test.ts`
 * pins the selector against `MentionNode`'s real rendered output so a rename
 * cannot silently switch the warning off.
 */
export const COMMAND_CHIP_ATTRIBUTE = 'data-mention';
export const COMMAND_CHIP_VALUE = 'command';
export const COMMAND_CHIP_SELECTOR = `[${COMMAND_CHIP_ATTRIBUTE}="${COMMAND_CHIP_VALUE}"]`;
/** Where the chip keeps the command's name. See `MentionNode.addAttributes`. */
export const COMMAND_CHIP_LABEL_ATTRIBUTE = 'data-mention-label';

/**
 * The part of the editor element this read touches — an `HTMLElement`
 * satisfies it structurally. Narrow on purpose: `apps/web` has no DOM harness,
 * and a two-method interface is the difference between a tested read and five
 * untestable lines inside a component.
 */
export interface CommandChipHost {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The name on the first `/` command chip in the live draft, or `null`.
 *
 * First, matching `collectCommandName`'s rule — `querySelector` returns the
 * first match in document order, which is the same chip the serializer picks.
 */
export function readCommandChipLabel(host: CommandChipHost | null): string | null {
  if (!host) return null;
  const label = host
    .querySelector(COMMAND_CHIP_SELECTOR)
    ?.getAttribute(COMMAND_CHIP_LABEL_ATTRIBUTE);
  return label || null;
}

/**
 * Whether a draft carrying this chip label will actually RUN a command.
 *
 * The same resolution `planDraftSubmission` performs at submit time, against
 * the same live list — deliberately, so the warning shown while typing and the
 * decision taken on submit can never disagree.
 *
 * The case that makes this necessary: a chip whose command is no longer in the
 * list does not run anything. `planDraftSubmission` re-inlines it as `/name
 * args` and sends it as an ordinary message, which carries attachments fine.
 * Treating the chip alone as "this is a command" would disable the send button
 * for a submission that was about to work.
 */
export function draftWillRunCommand(
  chipLabel: string | null | undefined,
  commands: readonly { name: string }[],
): boolean {
  if (!chipLabel) return false;
  return commands.some((candidate) => candidate.name === chipLabel);
}

export type CommandAttachmentPlan =
  /** Nothing is at risk — send, queue, or run it as usual. */
  | { kind: 'dispatch' }
  /** Do not send, do not clear, and put both strings in front of the user. */
  | { kind: 'refuse'; message: string; description: string };

export interface CommandAttachmentInput {
  /**
   * Whether this submission runs a `/` command. At submit time that is
   * `planDraftSubmission(...).kind === 'command'`; for the live warning it is
   * `draftWillRunCommand(readCommandChipLabel(editor), commands)`.
   *
   * Both resolve the same chip name against the same live list, so the warning
   * shown while typing and the decision taken on submit agree. They are still
   * two separate checks because only one of them can gate the keyboard: a
   * disabled send button does nothing to Enter.
   */
  isCommand: boolean;
  /** `attachedFiles.length`. */
  attachmentCount: number;
}

/**
 * Whether this submission may proceed, and what to tell the user if not.
 *
 * Called twice with different sources for `isCommand` — once per render for
 * the inline warning and the disabled send button, once inside `handleSubmit`
 * for the keyboard path, which no disabled button can gate.
 */
export function planCommandAttachments({
  isCommand,
  attachmentCount,
}: CommandAttachmentInput): CommandAttachmentPlan {
  if (!isCommand || attachmentCount < 1) return { kind: 'dispatch' };

  const one = attachmentCount === 1;
  return {
    kind: 'refuse',
    message: 'A / command cannot send attachments',
    description: one
      ? '1 file stays attached. Remove it to run the command, or remove the command to send the file as a message.'
      : `${attachmentCount} files stay attached. Remove them to run the command, or remove the command to send them as a message.`,
  };
}
