import type { rebuildArtifactCommentContinuePrompt } from './comment-delivery';
import type { PromptPartWire } from '../projects/surface';
import { assertScreenshotBatch, materializeArtifactScreenshotParts, screenshotReferences, screenshotTargetCapability } from './comment-screenshot-parts';
import { artifactScreenshotStore } from './comment-screenshot-storage';
import { ArtifactCommentScreenshotError } from './comment-screenshot-validation';

type Row = Parameters<typeof rebuildArtifactCommentContinuePrompt>[0];
type Source = Parameters<NonNullable<Parameters<typeof rebuildArtifactCommentContinuePrompt>[1]>>[0];
const textOnly = 'The target model does not declare image input. Use the anchor text and authenticated screenshot URLs; do not assume you can see the image.';

export async function rebuildArtifactCommentScreenshotMessage(row: Row, modelOverride?: { providerID?: string; modelID?: string }, store?: Awaited<ReturnType<typeof artifactScreenshotStore>>): Promise<{ text: string; parts?: PromptPartWire[] }> {
  const { rebuildArtifactCommentContinuePrompt } = await import('./comment-delivery');
  let first: Source | undefined;
  const text = await rebuildArtifactCommentContinuePrompt(row, async source => { first = source; });
  if (!first || !row.sessionId || !first.comments.some(comment => !comment.deletedAt && comment.screenshotKey)) return { text };
  const capability = await screenshotTargetCapability(first.artifact.projectId, row.sessionId, modelOverride);
  if (!capability.vision) return { text: `${text}\n\n${textOnly}` };
  let parts: PromptPartWire[];
  try { parts = await materializeArtifactScreenshotParts(first.artifact, first.comments, row.sessionId, modelOverride, store, text); }
  catch (error) {
    if (error instanceof ArtifactCommentScreenshotError && error.status === 413) await rebuildArtifactCommentContinuePrompt(row, async () => { throw error; });
    throw error;
  }
  let current: Source | undefined;
  let messageParts: PromptPartWire[] = [];
  let vision = true;
  const currentText = await rebuildArtifactCommentContinuePrompt(row, async (source, sourceText) => {
    current = source;
    const refs = screenshotReferences(source.artifact, source.comments, '');
    if (refs.some(reference => !parts.some(part => part.filename === reference.filename))) throw new Error('Artifact screenshots changed before delivery; retry the current source');
    const now = await screenshotTargetCapability(source.artifact.projectId, row.sessionId, modelOverride);
    vision = now.vision;
    const live = new Set(refs.map(ref => ref.filename));
    const currentParts = parts.filter(part => part.filename && live.has(part.filename));
    messageParts = currentParts.length ? [{ type: 'text', text: sourceText }, ...currentParts] : [];
    if (vision) assertScreenshotBatch(currentParts.length, 0, Buffer.byteLength(JSON.stringify(messageParts)));
  });
  if (!current) return { text: currentText };
  if (!vision) return { text: `${currentText}\n\n${textOnly}` };
  return { text: currentText, ...(messageParts.length ? { parts: messageParts } : {}) };
}
