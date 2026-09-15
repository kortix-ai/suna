export function afterPushCompletion(
  body: ReadableStream<Uint8Array>,
  onComplete: () => void,
): ReadableStream<Uint8Array> {
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      onComplete();
    },
  }));
}
