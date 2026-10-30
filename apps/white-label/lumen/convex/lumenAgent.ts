// The layout of Lumen's one Kortix project. Every firm shares the project and
// its Drive; the firm boundary is one folder, one agent and one service
// account per firm (README "One project, many firms"). The role prompts,
// skills and the `lumen` tool CLI live in agent-kit/ and reach Convex through
// convex/kit/bundle.generated.ts (`bun scripts/kit-bundle.ts`).
//
// A restricted matter is the exception to "one agent per firm": its folder
// lives under /Lumen/Walled, outside the firm folder, and only its own agent
// (lumen-m-<matterId>) is granted it. A firm session never mounts it.

import type { Doc } from "./_generated/dataModel";

/** The kit roles. A role is a prompt file in the kit, not a Kortix agent: each firm runs every role on its own agent. */
export const COUNSEL_ROLE = "lumen-counsel";
export const EXTRACTOR_ROLE = "lumen-extractor";
export const REVIEWER_ROLE = "lumen-reviewer";
export const DRAFTER_ROLE = "lumen-drafter";

/** The project default agent: no folder grants, no repository, no permissions. A session without a firm agent sees nothing. */
export const NONE_AGENT = "lumen-none";

/** The firm's Kortix agent. Its folder grants are the firm folder (write) and the kit (read). */
export const firmAgent = (firmId: string) => `lumen-f-${firmId}`;
/**
 * A restricted matter's own Kortix agent. Its folder grants are the matter's
 * walled folder (write) and the kit (read): a session of the matter mounts
 * that matter and nothing else of the firm, and no firm session mounts it.
 */
export const matterAgent = (matterId: string) => `lumen-m-${matterId}`;
/** The firm's Kortix service account: it creates and drives every session of the firm. */
export const firmServiceAccount = (firmId: string) => `lumen-firm-${firmId}`;

export const LUMEN_ROOT = "/Lumen";
export const FIRMS_ROOT = "/Lumen/Firms";
export const KIT_ROOT = "/Lumen/Kit";
/** The kit version sessions read at start (one line). */
export const KIT_CURRENT = "/Lumen/Kit/CURRENT";

/** Restricted matters live outside every firm folder: the firm agent's grant does not reach them. */
export const WALLED_ROOT = "/Lumen/Walled";

export const FIRM_ROOT = (firmId: string) => `${FIRMS_ROOT}/${firmId}`;
export const MATTERS_ROOT = (firmId: string) => `${FIRM_ROOT(firmId)}/Matters`;
export const RUNS_ROOT = (firmId: string) => `${FIRM_ROOT(firmId)}/Runs`;
/** A matter's Drive folder: in its firm folder, or, restricted, its own folder under /Lumen/Walled. */
export const matterFolder = (m: { firmId: string; matterId: string; visibility: "firm" | "restricted" }) =>
  m.visibility === "restricted" ? `${WALLED_ROOT}/${m.matterId}` : `${MATTERS_ROOT(m.firmId)}/${m.matterId}`;
/**
 * Where a run's batch folders go. A restricted matter keeps its runs inside its
 * own folder (they hold excerpts of its documents); a firm matter's runs stay in
 * the firm's Runs folder.
 */
export const runFolder = (m: { firmId: string; driveFolder: string; visibility: "firm" | "restricted" }, runId: string) =>
  m.visibility === "restricted" ? `${m.driveFolder}/Runs/${runId}` : `${RUNS_ROOT(m.firmId)}/${runId}`;
/** Drive folders every firm gets. */
export const firmFolders = (firmId: string) => [FIRM_ROOT(firmId), MATTERS_ROOT(firmId), RUNS_ROOT(firmId), `${FIRM_ROOT(firmId)}/Library`];

/** The name Kortix mounts a granted folder under: the slug of its last segment (`folderMountName` in the Kortix API). */
const mountName = (segment: string) =>
  segment.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "") || "folder";

/**
 * A Drive path as a session sees it. Kortix mounts a granted folder at
 * `/drives/<slug of its last segment>`: `/Lumen/Firms/<firmId>` at
 * `/drives/<firmId>` (a Convex id is lowercase alphanumeric, its own slug) and
 * `/Lumen/Kit` at `/drives/kit`. A firm session has exactly these two grants.
 * A restricted matter's session mounts `/Lumen/Walled/<matterId>` at
 * `/drives/<matterId>` and the kit.
 */
export function sandboxPath(drivePath: string): string {
  const firm = /^\/Lumen\/(?:Firms|Walled)\/([^/]+)(\/.*)?$/.exec(drivePath);
  if (firm) return `/drives/${mountName(firm[1])}${firm[2] ?? ""}`;
  const kit = /^\/Lumen\/Kit(\/.*)?$/.exec(drivePath);
  if (kit) return `/drives/kit${kit[1] ?? ""}`;
  throw new Error(`500: ${drivePath} is not mounted in a firm session`);
}

/**
 * The Kortix agent a session of this matter runs on, or null while its folder
 * is moving. A restricted matter runs on its own agent, whose only folder grant
 * is the matter's walled folder; a firm matter on the firm's agent.
 */
export function sessionAgent(
  matter: Pick<Doc<"matters">, "folderMoving" | "driveFolder" | "visibility" | "kortixAgent">,
  firm: Pick<Doc<"firms">, "kortixAgent">,
): string | null {
  if (matter.folderMoving) return null;
  // The agent follows where the folder is: a walled folder only its matter agent reaches.
  if (matter.driveFolder.startsWith(`${WALLED_ROOT}/`)) return matter.kortixAgent ?? null;
  // Restricted but still inside the firm folder (its placement has not run): every firm session would see it.
  if (matter.visibility === "restricted") return null;
  return firm.kortixAgent ?? null;
}

