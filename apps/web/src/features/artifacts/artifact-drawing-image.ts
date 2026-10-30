import type { ArtifactCommentMark } from '@kortix/sdk';
import { projectDrawingMark } from './artifact-drawing';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export async function compositeDrawingImage(
  image: Blob,
  marks: ArtifactCommentMark[],
  width: number,
  height: number,
): Promise<Blob> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 2048 ||
    height > 2048
  )
    throw new Error('Invalid capture dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(image);
    if (bitmap.width !== width || bitmap.height !== height)
      throw new Error('Capture dimensions changed');
    context.drawImage(bitmap, 0, 0, width, height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const mark of marks) {
      const shape = projectDrawingMark(mark, { x: 0, y: 0, width, height });
      context.strokeStyle = mark.color;
      context.lineWidth = shape.width;
      if (mark.tool === 'rectangle') {
        context.strokeRect(
          shape.rectangle.x,
          shape.rectangle.y,
          shape.rectangle.width,
          shape.rectangle.height,
        );
      } else {
        const first = shape.points[0]!;
        if (
          mark.tool === 'pen' &&
          shape.points.every((point) => point.x === first.x && point.y === first.y)
        ) {
          context.fillStyle = mark.color;
          context.beginPath();
          context.arc(first.x, first.y, shape.width / 2, 0, Math.PI * 2);
          context.fill();
          continue;
        }
        context.beginPath();
        shape.points.forEach((point, index) =>
          index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
        );
        context.stroke();
        if (mark.tool === 'arrow') {
          context.beginPath();
          shape.arrow.forEach((point, index) =>
            index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
          );
          context.stroke();
        }
      }
    }
    const result = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))),
        'image/png',
      ),
    );
    if (result.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds upload limit');
    return result;
  } finally {
    bitmap?.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function drawingImageBase64(image: Blob): Promise<string> {
  if (image.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds upload limit');
  const bytes = new Uint8Array(await image.arrayBuffer());
  const pieces: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192)
    pieces.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  return btoa(pieces.join(''));
}
