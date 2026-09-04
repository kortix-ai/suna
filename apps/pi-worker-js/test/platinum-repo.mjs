// WHERE PLATINUM'S SOURCE IS, for the claims that pin this worker against it.
//
// Three suites read Platinum's tree: platinum-shapes and execenv-platinum parse
// apps/api's ExecBody and sanitiseGuestPath so a drift in the API's contract
// fails a claim here; tools-logic scans infra/celld/bindings for the one
// conditional that lives inside a comment. Inside the Platinum monorepo those
// were repo-root-relative paths. This worker now lives in the Kortix repo, and
// every one of them failed on the first sweep with ENOENT — pointed at the
// wrong apps/api, the one that belongs to Kortix.
//
// Resolution order: PLATINUM_REPO, then "are we inside Platinum", then a
// sibling checkout of the repo root (platinum-dev, platinum). Nothing found
// yields a path that names the variable, so the claim that fails says what to
// set rather than "ENOENT".
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const looksLikePlatinum = (p) => existsSync(resolve(p, "apps/api/src/api/sandboxes.ts")) && existsSync(resolve(p, "infra/celld"));

export const PLATINUM_REPO = (() => {
  // PLATINUM_REPO=none says "there is no checkout" — CI, or a machine without
  // one — so the suites that read Platinum's source SKIP by name instead of
  // failing on a path that does not exist.
  if (process.env.PLATINUM_REPO === "none") return "";
  if (process.env.PLATINUM_REPO && looksLikePlatinum(process.env.PLATINUM_REPO)) return resolve(process.env.PLATINUM_REPO);
  const inside = resolve(HERE, "../../../..");
  if (looksLikePlatinum(inside)) return inside;
  const repoRoot = resolve(HERE, "../../..");
  for (const sib of ["../platinum-dev", "../platinum"]) {
    const p = resolve(repoRoot, sib);
    if (looksLikePlatinum(p)) return p;
  }
  return "/<PLATINUM_REPO not set and no sibling platinum checkout>";
})();

export const platinumPath = (rel) => resolve(PLATINUM_REPO, rel);
/** True when a Platinum checkout is present; the contract suites SKIP without one. */
export const havePlatinum = !!PLATINUM_REPO && looksLikePlatinum(PLATINUM_REPO);
