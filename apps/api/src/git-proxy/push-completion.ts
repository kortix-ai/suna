export function afterPushCompletion<T extends Uint8Array>(
  body: ReadableStream<T>,
  onComplete: () => void,
): ReadableStream<T> {
  return body.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      onComplete();
    },
  }));
}
