// THE PROJECT'S PERMISSION POLICY, ENFORCED IN THE CELL.
//
// Kortix compiles each agent's `permission` block into OpenCode's
// PermissionConfig (`{ [tool]: 'allow'|'ask'|'deny' | { [pattern]: rule } }`)
// and hands it over in KORTIX_COMPILED_AGENT_CONFIG. kortixd's pi harness
// enforces it before every tool call (harness/pi/interactions.ts). The cell
// read the config for the prompt and the model and ignored this block, so an
// agent with `bash: deny` still ran bash.
//
// The rules here are interactions.ts, line for line: OpenCode's wildcard, the
// most specific pattern wins, a tool with no rule is `allow`, a capability
// covers the tools that share it, and a pattern map that cannot be evaluated
// against a call never degrades to `allow`.

const RULES = new Set(["allow", "ask", "deny"]);
const isRule = (value) => typeof value === "string" && RULES.has(value);

/** OpenCode's PermissionConfig, kept whole: pattern maps are matched per call. */
export function compilePermissionPolicy(raw) {
  const policy = {};
  if (isRule(raw)) return { "*": raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return policy;
  for (const [tool, value] of Object.entries(raw)) {
    if (isRule(value)) policy[tool] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const patterns = {};
      for (const [pattern, rule] of Object.entries(value)) if (isRule(rule)) patterns[pattern] = rule;
      if (Object.keys(patterns).length > 0) policy[tool] = patterns;
    }
  }
  return policy;
}

/** OpenCode's `Wildcard.match`: `*` is `.*`, `?` is `.`, anchored, dot-all; `ls *` also matches `ls`. */
function wildcardMatch(value, pattern) {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(value.replaceAll("\\", "/"));
}

/** OpenCode's `Wildcard.all`: sorted by length then name, the LAST match wins. */
function matchPatterns(subject, patterns) {
  let matched;
  const sorted = Object.entries(patterns).sort(([a], [b]) => a.length - b.length || a.localeCompare(b));
  for (const [pattern, rule] of sorted) if (wildcardMatch(subject, pattern)) matched = rule;
  return matched;
}

/** The string a pattern is tested against: the command for bash, the name for skill, the path otherwise. */
export function permissionSubject(tool, args) {
  if (!args || typeof args !== "object") return undefined;
  const value = args[tool === "bash" ? "command" : tool === "skill" ? "name" : "path"];
  return typeof value === "string" ? value : undefined;
}

function resolveRule(config, tool, args) {
  if (config === undefined || typeof config === "string") return config;
  const subject = permissionSubject(tool, args);
  if (subject !== undefined) return matchPatterns(subject, config);
  // A restriction that cannot be evaluated must never silently become `allow`.
  if (Object.entries(config).some(([pattern, rule]) => pattern !== "*" && rule !== "allow")) return "ask";
  return config["*"];
}

/** Tools whose name is not their capability (interactions.ts `TOOL_CAPABILITY`). */
const TOOL_CAPABILITY = {
  write: "edit",
  web_search: "websearch",
  image_search: "websearch",
  scrape_webpage: "webfetch",
};

/** The capability a rule names for this call; `memory` is `read` for `view`, `edit` otherwise. */
export function toolCapability(tool, args) {
  if (tool === "memory") return args?.command === "view" ? "read" : "edit";
  return TOOL_CAPABILITY[tool] ?? tool;
}

/** One call's rule: the tool's entry, else its capability's, else `*`. `undefined`: the policy says nothing. */
export function resolvePolicyRule(policy, tool, args) {
  return resolveRule(policy[tool] ?? policy[toolCapability(tool, args)] ?? policy["*"], tool, args);
}

/**
 * The rule that applies to one call, with the session's "always" answers.
 * A deny outranks an earlier "always": approving `ls` must not unlock the
 * `rm -rf *` the same pattern map denies. No rule is `allow`.
 */
export function callRule(policy, tool, args, alwaysAllowed = new Set()) {
  const resolved = resolvePolicyRule(policy, tool, args);
  if (resolved === "deny") return "deny";
  if (alwaysAllowed.has(toolCapability(tool, args))) return "allow";
  return resolved ?? "allow";
}

/** Whether an agent may see a skill: only a `deny` on `skill` hides it (pi has no skill tool to gate). */
export function skillGranted(policy, name) {
  return resolvePolicyRule(policy ?? {}, "skill", { name }) !== "deny";
}
