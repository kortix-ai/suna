// Lumen's agents and the Drive layout every firm gets. The agent prompts,
// skills and the `lumen` tool CLI live in agent-kit/ and reach Convex through
// convex/kit/bundle.generated.ts (`bun scripts/kit-bundle.ts`).

export const COUNSEL_AGENT = "lumen-counsel";
export const EXTRACTOR_AGENT = "lumen-extractor";
export const REVIEWER_AGENT = "lumen-reviewer";
export const DRAFTER_AGENT = "lumen-drafter";

/** The skills each agent may load (besides the stock project skills). */
export const AGENT_SKILLS: Record<string, readonly string[]> = {
  "lumen-counsel": ["lumen-citations", "lumen-research-method", "lumen-due-diligence"],
  "lumen-extractor": ["lumen-citations", "lumen-clause-extraction", "lumen-due-diligence"],
  "lumen-reviewer": ["lumen-citations", "lumen-playbook-review", "lumen-redlining"],
  "lumen-drafter": ["lumen-citations", "lumen-redlining"],
};

/** Drive folders every firm gets (paths inside the project Drive). */
export const FIRM_FOLDERS = ["/Company", "/Company/Lumen", "/Company/Lumen/Matters", "/Company/Lumen/Runs", "/Company/Lumen/Library"];
export const RUNS_ROOT = "/Company/Lumen/Runs";

/** The Drive's /Company folder is mounted at /drives/company inside every session. */
export const sandboxPath = (drivePath: string) => `/drives/company${drivePath.replace(/^\/Company/, "")}`;
