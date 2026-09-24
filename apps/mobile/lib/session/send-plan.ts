/**
 * send-plan — what a thread composer's Send does with the current draft
 * (COR-185). Pure, so the rules test with plain `bun test`;
 * `SessionChatInput.handleSubmit` acts on the result.
 *
 * Files never go into the local message queue: `onEnqueue` carries text only.
 * A send with files while the agent is busy is refused with a toast, and the
 * draft and files stay in the composer for a send after the reply.
 */

export type ComposerSendPlan = 'noop' | 'send' | 'queue' | 'refuse-busy-files' | 'refuse-no-session';

export function planComposerSend(i: {
  text: string;
  fileCount: number;
  disabled: boolean;
  isBusy: boolean;
  canQueue: boolean;
  canAttach: boolean;
}): ComposerSendPlan {
  if (i.disabled) return 'noop';
  if (!i.text.trim() && i.fileCount === 0) return 'noop';
  if (i.fileCount > 0 && !i.canAttach) return 'refuse-no-session';
  if (i.isBusy && i.canQueue && i.fileCount > 0) return 'refuse-busy-files';
  if (i.isBusy && i.canQueue) return 'queue';
  return 'send';
}
