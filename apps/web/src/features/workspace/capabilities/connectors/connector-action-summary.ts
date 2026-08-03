import type { ConnectorAction } from '@kortix/sdk';

export interface ConnectorActionSummary {
  readCount: number;
  writeCount: number;
  /** Up to `MAX_SAMPLE_NAMES` action names, in the order the connector
   *  reports them — never sorted or curated, so this can never imply an
   *  action is more representative than the connector's own listing does. */
  sampleNames: string[];
}

const MAX_SAMPLE_NAMES = 4;

/**
 * The Overview rung's "what it does" summary, derived only from the
 * connector's own `actions` — never invented copy. `read` counts separately
 * from `write` and `destructive`, which pool together as the actions a
 * session could change or delete something with.
 *
 * Returns `null` for zero actions so the rung can render nothing instead of
 * an empty shell or a "0 tools" line — the case the verification fixture
 * (`verify-api`, 0 actions) exercises.
 */
export function summarizeConnectorActions(
  actions: readonly ConnectorAction[],
): ConnectorActionSummary | null {
  if (actions.length === 0) return null;

  let readCount = 0;
  let writeCount = 0;
  for (const action of actions) {
    if (action.risk === 'read') readCount += 1;
    else writeCount += 1; // 'write' | 'destructive'
  }

  return {
    readCount,
    writeCount,
    sampleNames: actions.slice(0, MAX_SAMPLE_NAMES).map((action) => action.name),
  };
}

/**
 * "1 read tool, 2 write tools." — each half pluralized on its own count, and
 * only the halves with at least one, joined by a comma.
 *
 * **Tool, not action.** `ConnectorAction` is the SDK's type name, and it leaked
 * into user-facing copy here and nowhere else: the modal header two rows above
 * this line prints `19 tools`, the card summary prints `19 tools · OPENAPI`,
 * the Permissions search says `Search 19 tools`, and every bulk-confirm string
 * counts tools. One concept, one word.
 */
export function describeConnectorActionCounts(summary: ConnectorActionSummary): string {
  const parts: string[] = [];
  if (summary.readCount > 0) {
    parts.push(`${summary.readCount} read ${summary.readCount === 1 ? 'tool' : 'tools'}`);
  }
  if (summary.writeCount > 0) {
    parts.push(`${summary.writeCount} write ${summary.writeCount === 1 ? 'tool' : 'tools'}`);
  }
  return `${parts.join(', ')}.`;
}
