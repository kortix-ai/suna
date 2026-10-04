/**
 * Steps per flow id from flow-file sources. A `flow("ID")` token opens `ID`;
 * `harnessFlow("ID")` opens `<id>` and its `${id}-pi` twin — flow.ts registers
 * both from one body, so the twin runs the same inline steps. Every
 * `step("…")` line appends to every id still open. A step line before any flow
 * token belongs to nothing.
 */
export function flowSteps(texts: string[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const text of texts) {
    const token =
      /(?:(harness)Flow|flow)\(\s*["'`]([A-Za-z0-9_.-]+)["'`]|(?:ctx\.)?step\(\s*["'`]([^"'`]+)["'`]/g;
    let current: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = token.exec(text)) !== null) {
      if (m[2] !== undefined) {
        current = m[1] ? [m[2], `${m[2]}-pi`] : [m[2]];
        for (const id of current) if (!byId.has(id)) byId.set(id, []);
      } else if (m[3] !== undefined && current.length) {
        for (const id of current) byId.get(id)?.push(m[3]);
      }
    }
  }
  return byId;
}
