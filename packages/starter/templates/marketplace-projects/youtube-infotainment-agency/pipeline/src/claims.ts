import type { Claims, FactCheck } from "./schemas";

/**
 * Merge an independent fact-check into claims.json.
 * supported → verified; partially_supported → disputed (rewrite needed); unsupported/unreachable → rejected.
 * A claim the checker did not look at stays unverified, which the script lint treats as an error.
 */
export function applyFactCheck(claims: Claims, fc: FactCheck): { claims: Claims; summary: Record<string, number>; stale: string[] } {
  const verdicts = new Map(fc.results.map((r) => [r.claim_id, r]));
  const summary: Record<string, number> = { verified: 0, disputed: 0, rejected: 0, unverified: 0 };
  const stale: string[] = [];
  const next = structuredClone(claims);
  for (const c of next.claims) {
    const r = verdicts.get(c.id);
    // The fact-check can run while the research critic still reviews the dossier: a claim reworded since
    // its check keeps no verdict, so the fact-checker re-checks it.
    if (r?.claim_text !== undefined && r.claim_text !== c.text) {
      c.status = "unverified";
      stale.push(c.id);
      summary.unverified! += 1;
      continue;
    }
    if (!r) c.status = "unverified";
    else if (r.verdict === "supported") c.status = "verified";
    else if (r.verdict === "partially_supported") c.status = "disputed";
    else c.status = "rejected";
    if (r?.corrected_text && r.verdict === "partially_supported") {
      c.notes = `${c.notes ? c.notes + " | " : ""}checker suggests: ${r.corrected_text}`;
    }
    summary[c.status] = (summary[c.status] ?? 0) + 1;
  }
  return { claims: next, summary, stale };
}

/** Share of claims backed by at least one primary source — a research-quality signal for the critic. */
export function primaryShare(claims: Claims): number {
  const tier = new Map(claims.sources.map((s) => [s.id, s.tier]));
  const withPrimary = claims.claims.filter((c) => c.source_ids.some((s) => tier.get(s) === "primary")).length;
  return claims.claims.length ? withPrimary / claims.claims.length : 0;
}
