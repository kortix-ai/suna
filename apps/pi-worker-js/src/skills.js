// SKILLS, READ FROM THE WORKSPACE THE AGENT IS WORKING IN.
//
// pi ships the whole thing — `loadSkills` traverses directories, parses
// SKILL.md frontmatter, honours ignore files and reports diagnostics — and it
// takes an ExecutionEnv, which is the interface this cell already implements.
// So skills come from the workspace over whichever backend is configured, with
// no filesystem access in the isolate and nothing re-implemented here.
//
// What goes into the system prompt is the NAME, DESCRIPTION AND PATH of each
// skill, not its content: the model reads the file with its own read tool when
// a task matches. Two skills cost about 670 characters of prompt no matter how
// long the skills themselves are.
import { formatSkillInvocation, formatSkillsForSystemPrompt, loadSkills } from "./vendor/pi-skills.js";

/** Where the managed `kortix-*` overlay lives in the cell's tree (kortixd's baked `/opt/kortix/managed-skills`). */
export const MANAGED_SKILLS_DIR = "/opt/kortix/managed-skills";

/**
 * Skill directories, most specific first; the first skill of a name wins.
 * kortixd's `resolvePiSkillDirectories`, in its order: the managed overlay
 * (so the platform's copy of a `kortix-*` skill wins over one a project
 * tracks), the project's `skills/`, pi's own config dir, then the legacy
 * `.kortix/opencode/skills` a project authored for OpenCode.
 *
 * The cell used to read `<opencode or pi config dir>/skills` and `.pi/skills`.
 * A project on the current layout keeps its skills in `skills/`, so it showed
 * none: measured on pi-js 2026-10-06, `GET /skill` answered `[]` for a
 * workspace carrying 11 skills.
 *
 * `SKILLS_DIR` still wins, and EMPTY still means none: `??`, not a
 * truthiness test, because `SKILLS_DIR=""` is how an operator turns skills off.
 */
export function skillDirs(env, piDir = null) {
  if (env.SKILLS_DIR !== undefined && env.SKILLS_DIR !== null) {
    return String(env.SKILLS_DIR).split(",").map((d) => d.trim()).filter(Boolean);
  }
  return [MANAGED_SKILLS_DIR, "skills", ...(piDir ? [`${piDir}/skills`] : []), ".kortix/opencode/skills"];
}

// A FRESH OP PREFIX ON EVERY LOAD, and this is not a detail.
//
// Loading skills LISTS and READS through the workspace, and the daemon caches
// every op by its id. A fixed prefix would make the second load replay the
// first one's reads: edit a SKILL.md, reload, and get the old text back
// forever. The prefix is what makes a reload actually re-read.
let loadSeq = 0;
const nextPrefix = () => `skills-${Date.now().toString(36)}-${loadSeq++}`;

/**
 * Load the workspace's skills.
 *
 * `envFor(opId)` builds an ExecutionEnv bound to that op prefix — the same
 * factory the tools use, so skills are read over exactly the backend the tools
 * write through. `allowed(name)` is the agent's skill grant: a denied skill is
 * neither listed nor put in the prompt.
 */
export async function loadWorkspaceSkills(env, envFor, piDir = null, allowed = () => true) {
  const dirs = skillDirs(env, piDir);
  if (dirs.length === 0) return { skills: [], diagnostics: [], block: "", dirs };
  const execEnv = envFor(nextPrefix());
  // Absolute, so the <location> the model is shown is a path it can hand
  // straight to a tool rather than one it has to resolve against a cwd it was
  // never told.
  const resolved = [];
  for (const d of dirs) {
    if (d.startsWith("/")) { resolved.push(d); continue; }
    const abs = await execEnv.absolutePath(d);
    resolved.push(abs?.ok ? abs.value : d);
  }
  try {
    const loaded = await loadSkills(execEnv, resolved);
    // The first directory wins a name, as in kortixd (pi reports the loser).
    const seen = new Set();
    const skills = [];
    const diagnostics = [...loaded.diagnostics];
    for (const skill of loaded.skills) {
      if (seen.has(skill.name)) { diagnostics.push({ type: "collision", message: `skill "${skill.name}" is shadowed by an earlier directory`, path: skill.filePath }); continue; }
      seen.add(skill.name);
      if (allowed(skill.name)) skills.push(skill);
    }
    return { skills, diagnostics, block: skills.length ? formatSkillsForSystemPrompt(skills) : "", dirs: resolved };
  } catch (e) {
    // A broken skills directory must not take the turn down with it. The agent
    // is still useful without skills; it is not useful if it cannot start.
    return { skills: [], diagnostics: [{ type: "warning", code: "list_failed", message: String(e?.message ?? e), path: resolved.join(",") }], block: "", dirs: resolved };
  }
}

/** The system prompt with the workspace's skills appended, or unchanged if there are none. */
export function withSkills(base, block) {
  return block ? `${base}\n\n${block}` : base;
}

/**
 * Turn an explicit skill invocation into the user message pi expects.
 * Returns null when no such skill is loaded, so the caller can 404 rather than
 * silently sending the model a prompt about a skill that does not exist.
 */
export function invokeSkill(skills, name, instructions) {
  const skill = (skills ?? []).find((s) => s.name === name);
  return skill ? formatSkillInvocation(skill, instructions || undefined) : null;
}
