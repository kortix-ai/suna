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

function sameReplacement(
  runtime: LegacyRuntimeMessage['parts'][number],
  expectedText: string,
): boolean {
  return runtime.type === 'text' && runtime.text === expectedText;
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

  // The runtime may contain either:
  // - the canonical command-id XML written by the current delivery path, or
  // - the legacy-prefixed XML written by an earlier repair attempt.
  // Materialize both deterministic forms before mapping so an ambiguous
  // prompt response or a failed marker write can recover from transcript state.
  const canonicalMaterialized = await input.materialize(pending.parts, pending.commandId);
  const legacyMaterialized = await input.materialize(
    pending.parts,
    `legacy-${pending.commandId}`,
  );
  const usedPartIds = new Set<string>();
  const replacements = candidates.map((candidate) => {
    const canonicalReplacement = canonicalMaterialized[candidate.index];
    const legacyReplacement = legacyMaterialized[candidate.index];
    if (
      canonicalReplacement?.type !== 'text' ||
      typeof canonicalReplacement.text !== 'string' ||
      legacyReplacement?.type !== 'text' ||
      typeof legacyReplacement.text !== 'string'
    ) {
      throw new Error(
        `legacy attachment "${candidate.part.filename ?? 'File'}" was not materialized`,
      );
    }
    const canonicalText = canonicalReplacement.text;
    const legacyText = legacyReplacement.text;
    const matchesCandidate = (part: LegacyRuntimeMessage['parts'][number]): boolean =>
      sameAttachment(candidate.part, part) ||
      sameReplacement(part, canonicalText) ||
      sameReplacement(part, legacyText);
    const indexed = message.parts[candidate.index];
    const matches =
      indexed && matchesCandidate(indexed) ? [indexed] : message.parts.filter(matchesCandidate);
    if (matches.length !== 1 || usedPartIds.has(matches[0]!.id)) {
      throw new Error(
        `legacy attachment "${candidate.part.filename ?? 'File'}" does not map to one runtime part`,
      );
    }
    usedPartIds.add(matches[0]!.id);
    return {
      partId: matches[0]!.id,
      text: legacyText,
      alreadyRepaired:
        sameReplacement(matches[0]!, canonicalText) ||
        sameReplacement(matches[0]!, legacyText),
    };
  });
  for (const replacement of replacements) {
    if (replacement.alreadyRepaired) continue;
    await input.updatePart({
      messageId: message.info.id,
      partId: replacement.partId,
      text: replacement.text,
    });
  }
  await input.markRepaired();
  return { repaired: candidates.length };
}
