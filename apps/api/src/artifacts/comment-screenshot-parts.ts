import { MAX_PROMPT_ATTACHMENT_FILES, MAX_PROMPT_ATTACHMENTS_BYTES, PROMPT_PARTS_MAX_BYTES } from '@kortix/shared';
import type { PromptPartWire } from '../projects/surface';
import { ARTIFACT_COMMENT_SEND_LIMIT } from './comment-routing-context';
import { ArtifactCommentScreenshotError, ARTIFACT_SCREENSHOT_LIMITS } from './comment-screenshot-validation';
import { artifactScreenshotStore, screenshotKeyMatches } from './comment-screenshot-storage';

export const ARTIFACT_SCREENSHOT_DELIVERY_LIMITS = { max_files: MAX_PROMPT_ATTACHMENT_FILES, max_total_bytes: MAX_PROMPT_ATTACHMENTS_BYTES, max_screenshot_bytes: ARTIFACT_SCREENSHOT_LIMITS.bytes, max_parts_bytes: PROMPT_PARTS_MAX_BYTES } as const;
export const SCREENSHOT_LIMIT_MESSAGE = `Send at most ${MAX_PROMPT_ATTACHMENT_FILES} screenshots and ${PROMPT_PARTS_MAX_BYTES / 1024 / 1024} MiB of encoded image parts per batch. Delete some screenshot comments or choose a text-only target, then send again.`;
export interface ScreenshotComment { commentId: string; screenshotKey: string | null; deletedAt: Date | null }
interface ArtifactScope { projectId: string; artifactId: string }
export interface ScreenshotReference { type: 'file'; mime: 'image/png' | 'image/webp'; filename: string; url: string; key: string }

export function assertScreenshotBatch(count: number, totalBytes = count * ARTIFACT_SCREENSHOT_LIMITS.bytes, partsBytes = 0): void {
  if (count > MAX_PROMPT_ATTACHMENT_FILES || totalBytes > MAX_PROMPT_ATTACHMENTS_BYTES || partsBytes > PROMPT_PARTS_MAX_BYTES) {
    throw new ArtifactCommentScreenshotError(413, 'artifact_comment_screenshot_limit', SCREENSHOT_LIMIT_MESSAGE, ARTIFACT_SCREENSHOT_DELIVERY_LIMITS);
  }
}
export function screenshotReferences(artifact: ArtifactScope, comments: readonly ScreenshotComment[], apiOrigin: string): ScreenshotReference[] {
  if (!comments.some(comment => !comment.deletedAt && comment.screenshotKey)) return [];
  const base = apiOrigin.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  return comments.flatMap(comment => {
    if (comment.deletedAt || !comment.screenshotKey || !screenshotKeyMatches(comment.screenshotKey, artifact.projectId, comment.commentId)) return [];
    const extension = comment.screenshotKey.endsWith('.png') ? 'png' : 'webp';
    return [{ type: 'file', mime: extension === 'png' ? 'image/png' : 'image/webp', filename: `${comment.commentId}.${extension}`, key: comment.screenshotKey,
      url: `${base}/v1/projects/${artifact.projectId}/artifacts/${artifact.artifactId}/comments/${comment.commentId}/screenshot` }];
  });
}
export function selectScreenshotSendBatch(ids: readonly string[], imageCounts: ReadonlyMap<string, number>, mayNeedImages: boolean, imageBytes?: ReadonlyMap<string, { bytes: number; partsBytes: number }>, textBytes?: ReadonlyMap<string, number>) {
  const selected: string[] = [];
  let count = 0, bytes = 0, partsBytes = 2;
  for (const id of ids) {
    if (selected.length >= ARTIFACT_COMMENT_SEND_LIMIT) break;
    const next = imageCounts.get(id) ?? 0;
    const nextBytes = imageBytes?.get(id);
    const nextParts = (nextBytes?.partsBytes ?? 0) + (textBytes?.get(id) ?? 0) + next;
    if (mayNeedImages && (count + next > MAX_PROMPT_ATTACHMENT_FILES || bytes + (nextBytes?.bytes ?? 0) > MAX_PROMPT_ATTACHMENTS_BYTES || partsBytes + nextParts > PROMPT_PARTS_MAX_BYTES)) {
      if (!selected.length) selected.push(id);
      break;
    }
    selected.push(id); count += next; bytes += nextBytes?.bytes ?? 0; partsBytes += nextParts;
  }
  return { send_thread_ids: selected, send_thread_count: ids.length };
}

export async function screenshotTargetCapability(projectId: string, sessionId?: string | null, modelOverride?: { providerID?: string; modelID?: string }) {
  if (!sessionId) return { known: false, vision: false, mayNeedImages: true };
  const [{ projectSessions }, { db }, { and, eq }, { modelReadsImages }, { promptWireModel, continuationOverrides }] = await Promise.all([
    import('@kortix/db'), import('../shared/db'), import('drizzle-orm'), import('../channels/vision-model'), import('../projects/surface'),
  ]);
  const [session] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)));
  const explicit = modelOverride?.providerID && modelOverride.modelID ? { model: { providerID: modelOverride.providerID, modelID: modelOverride.modelID } } : undefined;
  const inherited = await continuationOverrides(sessionId, explicit);
  const model = promptWireModel(inherited?.model, session?.metadata?.opencode_model);
  const vision = modelReadsImages(projectId, model);
  return { known: !!model, vision, mayNeedImages: !model || vision };
}

export function screenshotReferenceBudget(refs: readonly ScreenshotReference[], sizes: ReadonlyMap<string, number>, text = '') {
  let bytes = 0, partsBytes = refs.length ? 2 + Buffer.byteLength(JSON.stringify({ type: 'text', text })) + 1 : 0;
  for (const ref of refs) {
    const size = sizes.get(ref.key) ?? ARTIFACT_SCREENSHOT_LIMITS.bytes;
    bytes += size;
    partsBytes += JSON.stringify({ type: ref.type, mime: ref.mime, filename: ref.filename, url: `data:${ref.mime};base64,` }).length + 4 * Math.ceil(size / 3) + 1;
  }
  return { bytes, partsBytes };
}
type ReceiptReader = Pick<typeof import('../shared/db').db, 'select'>;
export async function screenshotSizes(projectId: string, keys: readonly string[], executor?: ReceiptReader): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const [{ artifactCommentScreenshotObjects: objects }, { and, eq, inArray }] = await Promise.all([import('@kortix/db'), import('drizzle-orm')]);
  const reader = executor ?? (await import('../shared/db')).db;
  const rows = await reader.select({ key: objects.objectKey, bytes: objects.sizeBytes }).from(objects).where(and(eq(objects.projectId, projectId), inArray(objects.objectKey, [...keys])));
  return new Map(rows.flatMap(row => row.bytes === null ? [] : [[row.key, row.bytes] as const]));
}
export async function assertScreenshotReferences(artifact: ArtifactScope, refs: readonly ScreenshotReference[], text = '', executor?: ReceiptReader) {
  const budget = screenshotReferenceBudget(refs, await screenshotSizes(artifact.projectId, refs.map(ref => ref.key), executor), text);
  assertScreenshotBatch(refs.length, budget.bytes, budget.partsBytes);
}

export async function screenshotQueuedParts(artifact: ArtifactScope, comments: readonly ScreenshotComment[], sessionId: string, text: string,
  options?: { capability: Awaited<ReturnType<typeof screenshotTargetCapability>>; executor: ReceiptReader }): Promise<PromptPartWire[]> {
  if (!comments.some(comment => !comment.deletedAt && comment.screenshotKey)) return [];
  const capability = options?.capability ?? await screenshotTargetCapability(artifact.projectId, sessionId);
  const { config } = await import('../config');
  const refs = screenshotReferences(artifact, comments, config.KORTIX_URL);
  if (capability.mayNeedImages) await assertScreenshotReferences(artifact, refs, text, options?.executor);
  return capability.vision ? [{ type: 'text', text }, ...refs.map(({ key: _key, ...part }) => part)] : [];
}

export async function materializeArtifactScreenshotParts(artifact: ArtifactScope, comments: readonly ScreenshotComment[], sessionId: string,
  modelOverride?: { providerID?: string; modelID?: string }, store?: Awaited<ReturnType<typeof artifactScreenshotStore>>, text = ''): Promise<PromptPartWire[]> {
  const capability = await screenshotTargetCapability(artifact.projectId, sessionId, modelOverride);
  if (!capability.vision) return [];
  const { config } = await import('../config');
  const refs = screenshotReferences(artifact, comments, config.KORTIX_URL);
  await assertScreenshotReferences(artifact, refs, text);
  const images = await Promise.all(refs.map(async reference => ({ reference, image: await (store ?? await artifactScreenshotStore()).read(reference.key) })));
  assertScreenshotBatch(images.length, images.reduce((total, entry) => total + entry.image.bytes.byteLength, 0));
  const parts: PromptPartWire[] = images.map(({ reference, image }) => ({ type: 'file', filename: reference.filename, mime: image.mime, url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` }));
  assertScreenshotBatch(parts.length, images.reduce((sum, entry) => sum + entry.image.bytes.byteLength, 0), Buffer.byteLength(JSON.stringify([{ type: 'text', text }, ...parts])));
  return parts;
}
