// Small example utility used to demo the Kortix PR-bot review pipeline.
// Returns the input list with duplicate string values removed, preserving
// first-seen order.

export function dedupe(items: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    let seen = false;
    for (let j = 0; j < out.length; j++) {
      if (out[j] === items[i]) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      out.push(items[i]);
    }
  }
  return out;
}
