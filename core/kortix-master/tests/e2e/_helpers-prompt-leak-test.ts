// Prompt-leak test: simulate what OpenCode constructs as the system prompt
// when a user picks the `general` agent under PROJECTS_ENABLED=false.
//
// Final assembly (matches OpenCode's known order):
//   1. Plugin auth prefix ("You are Claude Code...")
//   2. opencode.jsonc instructions[] -> kortix-system.md body
//   3. Agent file body (general.md without YAML frontmatter)
//
// Then we run our `experimental.chat.system.transform` hook on this array
// and search for project-paradigm leakage.

import * as fs from "node:fs"

function readFileNoFrontmatter(path: string): string {
  const txt = fs.readFileSync(path, "utf8")
  const m = txt.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return m ? m[1] : txt
}

const kortixSystem = fs.readFileSync("/ephemeral/kortix-master/opencode/kortix-system.md", "utf8")
const general = readFileNoFrontmatter("/ephemeral/kortix-master/opencode/agents/general.md")

const system: string[] = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  kortixSystem,
  general,
]

// Project-leak audit
const fullPrompt = system.join("\n\n")

const projectTokens = [
  "project_create", "project_select", "project_list", "project_get", "project_delete", "project_update",
  "ticket_create", "ticket_update", "ticket_list", "ticket_assign",
  "milestone_create", "milestone_close", "milestone_list",
  "project-maintainer", "orchestrator",
  "<project_status", "<project_ref",
  "task_create", "task_update", "task_deliver", "task_blocker",
  ".kortix/CONTEXT.md", "project_context_sync",
  "<projects>", "<tasks>", "<subagents>", "<tasks_deep>",
  "team_create_agent", "credential_set",
]

const leaks: { token: string; lines: string[] }[] = []
for (const t of projectTokens) {
  const lines = fullPrompt.split("\n").filter((l) => l.includes(t))
  if (lines.length) leaks.push({ token: t, lines: lines.slice(0, 3) })
}

console.log("=== System prompt size:", fullPrompt.length, "chars,", fullPrompt.split("\n").length, "lines ===")
console.log("=== Leaks under PROJECTS_ENABLED=false ===")
if (leaks.length === 0) {
  console.log("✓ ZERO project-paradigm tokens in the system prompt.")
} else {
  console.log(`✘ ${leaks.length} token(s) leaked:`)
  for (const l of leaks) {
    console.log(`  - "${l.token}":`)
    for (const line of l.lines) console.log(`      ${line.trim().slice(0, 120)}`)
  }
  process.exit(1)
}
