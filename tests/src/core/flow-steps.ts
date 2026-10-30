/**
 * Steps per flow id from flow-file sources. A `flow("ID")` or
 * `harnessFlow("ID")` token opens `ID`. Every `step("…")` line appends to the
 * open id. A step line before any flow token belongs to nothing.
 */
export function flowSteps(texts: string[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const text of texts) {
    const token =
      /(?:harnessFlow|flow)\(\s*["'`]([A-Za-z0-9_.-]+)["'`]|(?:ctx\.)?step\(\s*["'`]([^"'`]+)["'`]/g;
    let current: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = token.exec(text)) !== null) {
      if (m[1] !== undefined) {
        current = m[1];
        if (!byId.has(current)) byId.set(current, []);
      } else if (m[2] !== undefined && current) {
        byId.get(current)?.push(m[2]);
      }
    }
  }
  return byId;
}
