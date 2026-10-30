import type { ArtifactCommentAnchor, ArtifactCommentMark } from '@kortix/sdk';
import { drawingViewportRect, normalizeDrawing, type DrawingStroke } from './artifact-drawing';
import { compositeDrawingImage, drawingImageBase64 } from './artifact-drawing-image';
import type {
  ArtifactAnnotationCaptureResult,
  ArtifactAnnotationRect,
  ArtifactAnnotationViewport,
} from './use-artifact-annotations';

export type ArtifactDrawingDraft = {
  anchor: ArtifactCommentAnchor;
  marks: ArtifactCommentMark[];
  image?: Blob;
  screenshot_base64?: string;
  imageFailed: boolean;
};

export async function prepareDrawingDraft(
  strokes: DrawingStroke[],
  viewport: ArtifactAnnotationViewport,
  annotations: {
    regionForViewportRect(
      rect: ArtifactAnnotationRect,
    ): { anchor: ArtifactCommentAnchor; documentRect: ArtifactAnnotationRect } | null;
    capture(rect: ArtifactAnnotationRect): Promise<ArtifactAnnotationCaptureResult>;
  },
): Promise<ArtifactDrawingDraft | null> {
  const rect = drawingViewportRect(strokes, viewport);
  if (!rect) return null;
  const region = annotations.regionForViewportRect(rect);
  if (!region) return null;
  const marks = normalizeDrawing(strokes, {
    ...region.documentRect,
    x: region.documentRect.x - viewport.scroll.x,
    y: region.documentRect.y - viewport.scroll.y,
  });
  const draft: ArtifactDrawingDraft = { anchor: region.anchor, marks, imageFailed: true };
  try {
    const capture = await annotations.capture(region.documentRect);
    if (capture.ok) {
      const image = await compositeDrawingImage(capture.blob, marks, capture.width, capture.height);
      return {
        ...draft,
        image,
        screenshot_base64: await drawingImageBase64(image),
        imageFailed: false,
      };
    }
    if (capture.reason === 'stale' || capture.reason === 'cancelled') return null;
  } catch {
    return draft;
  }
  return draft;
}
