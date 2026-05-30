<!-- Mirrored from https://opencode.ai/docs/tools/ and https://opencode.ai/docs/custom-tools/
     — keep in sync with upstream. -->

# Tools

Manage the tools an LLM can use.

Tools allow the LLM to perform actions in your codebase. OpenCode comes with a set of built-in tools, and you can extend it with **custom tools** (defined in `.opencode/tools/`) or [MCP servers](./mcp-servers.md).

By default, all tools are **enabled** and don't need permission to run. You can control tool behavior through permissions.

---

## Configure

Use the `permission` field to control tool behavior. You can allow, deny, or require approval for each tool.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "deny",
    "bash": "ask",
    "webfetch": "allow"
  }
}
```

You can also use wildcards to control multiple tools at once. For example, to require approval for all tools from an MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "mymcp_*": "ask"
  }
}
```

---

## Built-in

Here are all the built-in tools available in OpenCode.

---

### bash

Execute shell commands in your project environment.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "allow"
  }
}
```

This tool allows the LLM to run terminal commands like `npm install`, `git status`, or any other shell command.

---

### edit

Modify existing files using exact string replacements.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow"
  }
}
```

This tool performs precise edits to files by replacing exact text matches. It's the primary way the LLM modifies code.

---

### write

Create new files or overwrite existing ones.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow"
  }
}
```

Use this to allow the LLM to create new files. It will overwrite existing files if they already exist.

> Note: The `write` tool is controlled by the `edit` permission, which covers all file modifications (`edit`, `write`, `apply_patch`).

---

### read

Read file contents from your codebase.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow"
  }
}
```

This tool reads files and returns their contents. It supports reading specific line ranges for large files.

---

### grep

Search file contents using regular expressions.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "grep": "allow"
  }
}
```

Fast content search across your codebase. Supports full regex syntax and file pattern filtering.

---

### glob

Find files by pattern matching.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "glob": "allow"
  }
}
```

Search for files using glob patterns like `**/*.js` or `src/**/*.ts`. Returns matching file paths sorted by modification time.

---

### lsp (experimental)

Interact with your configured LSP servers to get code intelligence features like definitions, references, hover info, and call hierarchy.

> Note: This tool is only available when `OPENCODE_EXPERIMENTAL_LSP_TOOL=true` (or `OPENCODE_EXPERIMENTAL=true`).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "lsp": "allow"
  }
}
```

Supported operations include `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`.

---

### apply_patch

Apply patches to files.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow"
  }
}
```

This tool applies patch files to your codebase. Useful for applying diffs and patches from various sources.

When handling `tool.execute.before` or `tool.execute.after` hooks, check `input.tool === "apply_patch"` (not `"patch"`).

`apply_patch` uses `output.args.patchText` instead of `output.args.filePath`. Paths are embedded in marker lines within `patchText` and are relative to the project root (for example: `*** Add File: src/new-file.ts`, `*** Update File: src/existing.ts`, `*** Move to: src/renamed.ts`, `*** Delete File: src/obsolete.ts`).

> Note: The `apply_patch` tool is controlled by the `edit` permission.

---

### skill

Load a skill (a `SKILL.md` file) and return its content in the conversation.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "skill": "allow"
  }
}
```

---

### todowrite

Manage todo lists during coding sessions.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "todowrite": "allow"
  }
}
```

Creates and updates task lists to track progress during complex operations.

> Note: This tool is disabled for subagents by default, but you can enable it manually.

---

### webfetch

Fetch web content.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "webfetch": "allow"
  }
}
```

---

### websearch

Search the web for information.

> Note: This tool is only available when using the OpenCode provider or when the `OPENCODE_ENABLE_EXA` environment variable is set to any truthy value.

To enable when launching OpenCode:

```bash
OPENCODE_ENABLE_EXA=1 opencode
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "websearch": "allow"
  }
}
```

Performs web searches using Exa AI. No API key is required — the tool connects directly to Exa AI's hosted MCP service.

> Tip: Use `websearch` when you need to find information (discovery), and `webfetch` when you need to retrieve content from a specific URL (retrieval).

---

### question

Ask the user questions during execution.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "question": "allow"
  }
}
```

Each question includes a header, the question text, and a list of options. Users can select from the provided options or type a custom answer.

---

## Custom tools

Custom tools are functions you create that the LLM can call during conversations. They work alongside built-in tools.

Tools are defined as **TypeScript** or **JavaScript** files. The tool definition can invoke scripts written in **any language** — TS/JS is only used for the definition itself.

---

### Location

- Project-local: `.opencode/tools/` (or `.kortix/opencode/tools/` in a Kortix project)
- Global: `~/.config/opencode/tools/`

---

### Basic structure

The easiest way to create tools is using the `tool()` helper, which provides type-safety and validation.

**.opencode/tools/database.ts**

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    // Your database logic here
    return `Executed query: ${args.query}`
  },
})
```

The **filename** becomes the **tool name**. The above creates a `database` tool.

---

### Multiple tools per file

You can also export multiple tools from a single file. Each export becomes **a separate tool** with the name **`<filename>_<exportname>`**:

**.opencode/tools/math.ts**

```typescript
import { tool } from "@opencode-ai/plugin"

export const add = tool({
  description: "Add two numbers",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return args.a + args.b
  },
})

export const multiply = tool({
  description: "Multiply two numbers",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return args.a * args.b
  },
})
```

This creates two tools: `math_add` and `math_multiply`.

---

### Name collisions with built-in tools

If a custom tool uses the same name as a built-in tool, the custom tool takes precedence. For example, this file replaces the built-in `bash` tool:

**.opencode/tools/bash.ts**

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Restricted bash wrapper",
  args: {
    command: tool.schema.string(),
  },
  async execute(args) {
    return `blocked: ${args.command}`
  },
})
```

> Prefer unique names unless you intentionally want to replace a built-in. To **disable** a built-in (without overriding it), use permissions.

---

### Arguments

You can use `tool.schema`, which is just [Zod](https://zod.dev), to define argument types:

```typescript
args: {
  query: tool.schema.string().describe("SQL query to execute")
}
```

You can also import Zod directly and return a plain object:

```typescript
import { z } from "zod"

export default {
  description: "Tool description",
  args: {
    param: z.string().describe("Parameter description"),
  },
  async execute(args, context) {
    return "result"
  },
}
```

---

### Context

Tools receive context about the current session:

**.opencode/tools/project.ts**

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Get project information",
  args: {},
  async execute(args, context) {
    const { agent, sessionID, messageID, directory, worktree } = context
    return `Agent: ${agent}, Session: ${sessionID}, Directory: ${directory}`
  },
})
```

Use `context.directory` for the session working directory. Use `context.worktree` for the git worktree root.

---

### Polyglot example: invoking Python from a custom tool

You can write the implementation in any language and call it from a TS/JS tool definition.

**.opencode/tools/add.py**

```python
import sys
a = int(sys.argv[1])
b = int(sys.argv[2])
print(a + b)
```

**.opencode/tools/python-add.ts**

```typescript
import { tool } from "@opencode-ai/plugin"
import path from "path"

export default tool({
  description: "Add two numbers using Python",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args, context) {
    const script = path.join(context.worktree, ".opencode/tools/add.py")
    const result = await Bun.$`python3 ${script} ${args.a} ${args.b}`.text()
    return result.trim()
  },
})
```

`Bun.$` is the recommended shell helper.

---

## MCP servers

MCP (Model Context Protocol) servers allow you to integrate external tools and services. See [mcp-servers.md](./mcp-servers.md) for the in-depth reference.

---

## Internals

Internally, tools like `grep` and `glob` use [ripgrep](https://github.com/BurntSushi/ripgrep) under the hood. By default, ripgrep respects `.gitignore` patterns, which means files and directories listed in your `.gitignore` will be excluded from searches and listings.

---

### Ignore patterns

To include files that would normally be ignored, create a `.ignore` file in your project root:

```
!node_modules/
!dist/
!build/
```

This `.ignore` file allows ripgrep to search within `node_modules/`, `dist/`, and `build/` directories even if they're listed in `.gitignore`.
