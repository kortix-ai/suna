// The layout of Lumen's one Kortix project. Every firm shares the project and
// its Drive; the firm boundary is one folder, one agent and one service
// account per firm (README "One project, many firms"). The role prompts,
// skills and the `lumen` tool CLI live in agent-kit/ and reach Convex through
// convex/kit/bundle.generated.ts (`bun scripts/kit-bundle.ts`).

/** The kit roles. A role is a prompt file in the kit, not a Kortix agent: each firm runs every role on its own agent. */
export const COUNSEL_ROLE = "lumen-counsel";
export const EXTRACTOR_ROLE = "lumen-extractor";
export const REVIEWER_ROLE = "lumen-reviewer";
export const DRAFTER_ROLE = "lumen-drafter";

/** The project default agent: no folder grants, no repository, no permissions. A session without a firm agent sees nothing. */
export const NONE_AGENT = "lumen-none";

/** The firm's Kortix agent. Its folder grants are the firm folder (write) and the kit (read). */
export const firmAgent = (firmId: string) => `lumen-f-${firmId}`;
/** The firm's Kortix service account: it creates and drives every session of the firm. */
export const firmServiceAccount = (firmId: string) => `lumen-firm-${firmId}`;

export const LUMEN_ROOT = "/Lumen";
export const FIRMS_ROOT = "/Lumen/Firms";
export const KIT_ROOT = "/Lumen/Kit";
/** The kit version sessions read at start (one line). */
export const KIT_CURRENT = "/Lumen/Kit/CURRENT";

export const FIRM_ROOT = (firmId: string) => `${FIRMS_ROOT}/${firmId}`;
export const MATTERS_ROOT = (firmId: string) => `${FIRM_ROOT(firmId)}/Matters`;
export const RUNS_ROOT = (firmId: string) => `${FIRM_ROOT(firmId)}/Runs`;
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
 */
export function sandboxPath(drivePath: string): string {
  const firm = /^\/Lumen\/Firms\/([^/]+)(\/.*)?$/.exec(drivePath);
  if (firm) return `/drives/${mountName(firm[1])}${firm[2] ?? ""}`;
  const kit = /^\/Lumen\/Kit(\/.*)?$/.exec(drivePath);
  if (kit) return `/drives/kit${kit[1] ?? ""}`;
  throw new Error(`500: ${drivePath} is not mounted in a firm session`);
}
