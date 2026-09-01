import { isModelNativeAttachmentMime } from '@kortix/shared';

import type { PromptPartWire } from './store';

export interface LegacyPendingFirstPrompt {
  commandId: string;
  deliveredMessageIds: string[];
  parts: PromptPartWire[];
}

export interface LegacyRuntimeMessage {
  info: { id: string; role: string };
  parts: Array<{
    id: string;
    type: string;
    mime?: string;
    filename?: string;
    url?: string;
    text?: string;
  }>;
}

function sameAttachment(
  staged: PromptPartWire,
  runtime: LegacyRuntimeMessage['parts'][number],
): boolean {
  return (
    runtime.type === 'file' &&
    runtime.filename === staged.filename &&
    runtime.mime?.toLowerCase() === staged.mime?.toLowerCase()
  );
}

export async function repairLegacyInlineAttachments(input: {
  sessionId: string;
  externalId: string;
  opencodeSessionId: string;
  userId: string;
  loadPendingFirst: () => Promise<LegacyPendingFirstPrompt | null>;
  readMessage: (messageId: string) => Promise<LegacyRuntimeMessage | null>;
  materialize: (parts: PromptPartWire[], key: string) => Promise<PromptPartWire[]>;
  updatePart: (input: { messageId: string; partId: string; text: string }) => Promise<void>;
  markRepaired: () => Promise<void>;
}): Promise<{ repaired: number }> {
  const pending = await input.loadPendingFirst();
  if (!pending) {
    await input.markRepaired();
    return { repaired: 0 };
  }

  const candidates = pending.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.type === 'file' && !isModelNativeAttachmentMime(part.mime ?? ''));
  if (candidates.length === 0) {
    await input.markRepaired();
    return { repaired: 0 };
  }

  let message: LegacyRuntimeMessage | null = null;
  for (const messageId of pending.deliveredMessageIds) {
    message = await input.readMessage(messageId);
    if (message) break;
  }
  if (!message) throw new Error('legacy attachment message was not found');

  const materialized = await input.materialize(pending.parts, `legacy-${pending.commandId}`);
  const usedPartIds = new Set<string>();
  const replacements = candidates.map((candidate) => {
    const indexed = message.parts[candidate.index];
    const matches =
      indexed && sameAttachment(candidate.part, indexed)
        ? [indexed]
        : message.parts.filter((part) => sameAttachment(candidate.part, part));
    if (matches.length !== 1 || usedPartIds.has(matches[0]!.id)) {
      throw new Error(
        `legacy attachment "${candidate.part.filename ?? 'File'}" does not map to one runtime part`,
      );
    }
    const replacement = materialized[candidate.index];
    if (replacement?.type !== 'text' || typeof replacement.text !== 'string') {
      throw new Error(
        `legacy attachment "${candidate.part.filename ?? 'File'}" was not materialized`,
      );
    }
    usedPartIds.add(matches[0]!.id);
    return { partId: matches[0]!.id, text: replacement.text };
  });
  for (const replacement of replacements) {
    await input.updatePart({
      messageId: message.info.id,
      partId: replacement.partId,
      text: replacement.text,
    });
  }
  await input.markRepaired();
  return { repaired: candidates.length };
}
