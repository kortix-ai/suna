/**
 * The Kortix review inbox (`kortix review submit|show`): how humans decide gates. The JSON shape of a
 * review item isn't pinned down in the docs yet, so reads are tolerant of a few field names.
 */
import { run } from "./exec";

export interface ReviewVerdict {
  verdict: string;
  note?: string;
  by: string;
}

export async function submitReview(o: {
  title: string;
  summary: string;
  risk: "none" | "low" | "medium" | "high";
  detail: Record<string, unknown>;
  agent: string;
}): Promise<string | undefined> {
  const res = await run(
    [
      "kortix", "review", "submit", "--kind", "decision", "--title", o.title, "--summary", o.summary.slice(0, 60000),
      "--risk", o.risk, "--detail", JSON.stringify(o.detail), "--agent", o.agent, "--json",
    ],
    { allowFail: true },
  );
  if (res.code !== 0) {
    console.error(`kortix review submit failed (${res.code}):\n${res.stderr.slice(-500)}`);
    return undefined;
  }
  return parseSubmitOutput(res.stdout);
}

/** The new item's id from `kortix review submit --json` (the CLI returns it as `review_item_id`). */
export function parseSubmitOutput(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout);
    const pick = (o: any) => o?.review_item_id ?? o?.id;
    return pick(j) ?? pick(j.item) ?? pick(j.data);
  } catch {
    return /"(?:review_item_id|id)"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
  }
}

/** The current verdict on a review item, or null if it can't be read. `verdict` is lower-case. */
export async function readReview(id: string): Promise<ReviewVerdict | null> {
  const res = await run(["kortix", "review", "show", id, "--json"], { allowFail: true });
  return res.code === 0 ? parseShowOutput(res.stdout) : null;
}

/**
 * Parse `kortix review show --json`. Observed shape (2026-10): `status` (needs_you | approved |
 * rejected | …), the person's note in `feedback`, the actor in `acted_by`.
 */
export function parseShowOutput(stdout: string): ReviewVerdict {
  const j = JSON.parse(stdout);
  const item = j.item ?? j.data ?? j;
  return {
    verdict: String(item.status ?? item.verdict ?? item.decision ?? "").toLowerCase(),
    note: item.feedback ?? item.message ?? item.note ?? undefined,
    by: String(item.acted_by ?? item.decided_by ?? "human"),
  };
}
