export async function withAuthBootstrapTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Authentication did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
