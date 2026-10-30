import { z } from 'zod';
import { artifactCommentAnchorSchema } from './artifact-comments';

export const ARTIFACT_ANNOTATION_LIMITS = {
  messageBytes: 65_536,
  chunkItems: 64,
  chunks: 256,
  elements: 8192,
  texts: 8192,
  textUnits: 524_288,
  pins: 1000,
  ranges: 64,
  rects: 64,
  coordinate: 10_000_000,
  viewport: 100_000,
} as const;

const unicode = z.string().regex(/^[^\u0000\uD800-\uDFFF]*$/u);
const integer = z.number().int().min(0).max(ARTIFACT_ANNOTATION_LIMITS.coordinate);
const nodeNumber = z
  .number()
  .int()
  .min(0)
  .max(ARTIFACT_ANNOTATION_LIMITS.elements - 1);
const pinNumber = integer.min(1);
const revision = z.number().int().min(0).max(2_147_483_647);
const coordinate = z
  .number()
  .finite()
  .min(-ARTIFACT_ANNOTATION_LIMITS.coordinate)
  .max(ARTIFACT_ANNOTATION_LIMITS.coordinate);
const size = z.number().finite().positive().max(ARTIFACT_ANNOTATION_LIMITS.coordinate);
const rectSchema = z
  .object({ x: coordinate, y: coordinate, width: size, height: size })
  .strict();
const viewportSchema = z
  .object({
    width: size.max(ARTIFACT_ANNOTATION_LIMITS.viewport),
    height: size.max(ARTIFACT_ANNOTATION_LIMITS.viewport),
    scroll: z.object({ x: coordinate.min(0), y: coordinate.min(0) }).strict(),
  })
  .strict();
const envelope = { kortix: z.literal('annotate'), v: z.literal(1) };

const candidateSchema = z.unknown().transform((value, ctx) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.hasOwn(value, 'version')
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid annotation candidate' });
    return z.NEVER;
  }
  const parsed = artifactCommentAnchorSchema.safeParse({
    ...value,
    version: 'frame-candidate',
  });
  if (!parsed.success || parsed.data.type === 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid annotation anchor' });
    return z.NEVER;
  }
  const { version: _version, ...anchor } = parsed.data;
  return anchor;
});

export const artifactAnnotationFrameMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('ready') }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('layout'),
      revision,
      chunk: z
        .number()
        .int()
        .min(0)
        .max(ARTIFACT_ANNOTATION_LIMITS.chunks - 1),
      final: z.boolean(),
      complete: z.boolean(),
      viewport: viewportSchema,
      elements: z
        .array(
          z
            .object({
              n: nodeNumber,
              selector: unicode.min(1).max(2048),
              snippet: unicode.max(120),
              rect: rectSchema,
            })
            .strict(),
        )
        .max(ARTIFACT_ANNOTATION_LIMITS.chunkItems),
      texts: z
        .array(
          z.object({ n: nodeNumber, offset: integer, text: unicode.min(1).max(4096) }).strict(),
        )
        .max(ARTIFACT_ANNOTATION_LIMITS.chunkItems),
    })
    .strict(),
  z
    .object({ ...envelope, type: z.literal('candidate'), revision, anchor: candidateSchema })
    .strict(),
  z.object({ ...envelope, type: z.literal('focus'), n: pinNumber }).strict(),
]);

const rangeSchema = z
  .object({ n: nodeNumber, start: integer, end: integer })
  .strict()
  .refine((range) => range.end > range.start, 'Empty annotation range');
const pinSchema = z
  .object({
    n: pinNumber,
    rects: z.array(rectSchema).max(ARTIFACT_ANNOTATION_LIMITS.rects),
    ranges: z.array(rangeSchema).max(ARTIFACT_ANNOTATION_LIMITS.ranges),
  })
  .strict()
  .refine((pin) => pin.rects.length + pin.ranges.length > 0, 'Empty annotation pin');

export const artifactAnnotationHostMessageSchema = z.discriminatedUnion('type', [
  z
    .object({ ...envelope, type: z.literal('mode'), mode: z.enum(['off', 'text', 'comment']) })
    .strict(),
  z.object({ ...envelope, type: z.literal('request_layout') }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('draw'),
      revision,
      pins: z.array(pinSchema).max(ARTIFACT_ANNOTATION_LIMITS.pins),
      active: pinNumber.nullable(),
      focus: z.boolean(),
    })
    .strict(),
]);

export type ArtifactAnnotationCandidate = z.infer<typeof candidateSchema>;
export type ArtifactAnnotationFrameMessage = z.infer<
  typeof artifactAnnotationFrameMessageSchema
>;
export type ArtifactAnnotationHostMessage = z.infer<typeof artifactAnnotationHostMessageSchema>;
export type ArtifactAnnotationLayout = Extract<
  ArtifactAnnotationFrameMessage,
  { type: 'layout' }
>;
export type ArtifactAnnotationPin = Extract<
  ArtifactAnnotationHostMessage,
  { type: 'draw' }
>['pins'][number];

function boundedPayload(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  let units = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 4096 || item.depth > 12) return false;
    const current = item.value;
    if (typeof current === 'string') {
      if (current.length > 4096) return false;
      units += current.length;
    } else if (
      current === null ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      units += 8;
    } else if (Array.isArray(current)) {
      if (current.length > ARTIFACT_ANNOTATION_LIMITS.pins) return false;
      for (const value of current) stack.push({ value, depth: item.depth + 1 });
    } else if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      let keys = 0;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        if (++keys > 32) return false;
        units += key.length;
        stack.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 });
      }
    } else return false;
    if (units > ARTIFACT_ANNOTATION_LIMITS.messageBytes) return false;
  }
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    ARTIFACT_ANNOTATION_LIMITS.messageBytes
  );
}

export function parseArtifactAnnotationFrameMessage(
  value: unknown,
): ArtifactAnnotationFrameMessage | null {
  try {
    if (!boundedPayload(value)) return null;
    const result = artifactAnnotationFrameMessageSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseArtifactAnnotationHostMessage(
  value: unknown,
): ArtifactAnnotationHostMessage | null {
  try {
    if (!boundedPayload(value)) return null;
    const result = artifactAnnotationHostMessageSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
