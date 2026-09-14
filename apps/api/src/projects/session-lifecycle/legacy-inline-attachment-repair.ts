import { isModelNativeAttachmentMime } from '@kortix/shared';

import { buildPromptAttachmentReference } from './prompt-attachment-materializer';
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

  // Build both deterministic transcript forms without touching workspace files.
  // Stateful materialization starts only after every runtime part maps uniquely.
  const usedPartIds = new Set<string>();
  const mappings = candidates.map((candidate) => {
    const canonicalText = buildPromptAttachmentReference({
      part: candidate.part,
      index: candidate.index,
      materializationKey: pending.commandId,
    }).text;
    const legacyText = buildPromptAttachmentReference({
      part: candidate.part,
      index: candidate.index,
      materializationKey: `legacy-${pending.commandId}`,
    }).text;
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
    const runtimePart = matches[0]!;
    usedPartIds.add(runtimePart.id);
    return {
      index: candidate.index,
      partId: runtimePart.id,
      runtimePart,
      legacyText,
      needsPatch: sameAttachment(candidate.part, runtimePart),
    };
  });

  const pendingWrites = mappings.filter((mapping) => mapping.needsPatch);
  let legacyMaterialized: PromptPartWire[] | null = null;
  if (pendingWrites.length > 0) {
    // Keep original indices, but replace already-canonical/repaired staged file
    // candidates with their transcript text so the materializer cannot rewrite them.
    const partsToMaterialize = pending.parts.slice();
    for (const mapping of mappings) {
      if (!mapping.needsPatch) {
        partsToMaterialize[mapping.index] = {
          type: 'text',
          text: mapping.runtimePart.text,
        };
      }
    }
    legacyMaterialized = await input.materialize(
      partsToMaterialize,
      `legacy-${pending.commandId}`,
    );
  }

  const replacements = mappings.map((mapping) => {
    if (!mapping.needsPatch) {
      return { partId: mapping.partId, text: mapping.legacyText, alreadyRepaired: true };
    }
    const replacement = legacyMaterialized?.[mapping.index];
    if (
      replacement?.type !== 'text' ||
      typeof replacement.text !== 'string' ||
      replacement.text !== mapping.legacyText
    ) {
      const candidate = pending.parts[mapping.index];
      throw new Error(
        `legacy attachment "${candidate?.filename ?? 'File'}" was not materialized`,
      );
    }
    return { partId: mapping.partId, text: replacement.text, alreadyRepaired: false };
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
