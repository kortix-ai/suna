# pi extensions and packages

An extension adds tools, hooks or commands to a pi session. pi's own
extension system runs every extension. Kortix writes no adapter code for an
extension, so a package from <https://pi.dev/packages> runs unmodified.

This is the pi counterpart of an OpenCode plugin. An OpenCode file in
`harnesses/opencode/plugins/` or `harnesses/opencode/tools/` does nothing in
a pi session. A tool that takes arguments and returns text needs no
extension: write it as a project tool (`kortix.yaml` `tools:`,
`../kortix/tools.md`) and both harnesses run it.

## An extension file in the repository

Put the file in `harnesses/pi/extensions/`. pi loads each `.ts`, `.js`,
`.mjs` and `.cjs` file there when the runtime starts.

```ts
// harnesses/pi/extensions/word-count.ts
export default function (pi) {
  pi.registerTool({
    name: 'word_count',
    label: 'word_count',
    description: 'Count the words in a text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to count.' } },
      required: ['text'],
    },
    async execute(_toolCallId, params) {
      const count = params.text.trim().split(/\s+/).filter(Boolean).length
      return { content: [{ type: 'text', text: String(count) }], details: {} }
    },
  })
}
```

- The default export receives the pi extension API. `pi.registerTool` adds a
  tool. `pi.on('<event>', handler)` adds a hook (`tool_call`,
  `before_agent_start`, `input`, `session_shutdown`, …).
  `pi.registerCommand` adds a command.
- `parameters` is a JSON Schema object or a TypeBox schema. An extension can
  import `typebox` and the `@earendil-works/pi-*` packages; pi supplies them.
- A tool that fails throws an `Error`. pi reports the message to the model.
- The session's permission rules run before any extension `tool_call` hook.
  An extension cannot allow a call the project denies.
- The session has no pi terminal UI. `ctx.ui` calls do nothing. Use the
  `question` tool to ask the user.

pi also loads `.pi/extensions/*.ts` at the repository root, which is pi's own
default location.

## pi packages

Declare npm packages in `kortix.yaml`. Each entry is the pi.dev install line
with an exact version:

```yaml
runtime: pi
harnesses:
  pi:
    packages:
      - npm:pi-web-access@0.30.0
      - source: npm:pi-mcp-adapter@2.36.0
        extensions: ["extensions/*.ts"]   # load only these files of the package
        skills: []                        # load none of its skills
      - ./harnesses/pi/audit.ts           # an extension file in this repository
agents:
  reviewer:
    harnesses:
      pi:
        exclude: [pi-web-access]          # this agent does not load it
```

- A top-level package loads for every agent. An agent adds its own under
  `agents.<name>.harnesses.pi.packages` and drops a top-level one with
  `exclude`.
- A version range, a missing version or a Git source fails `kortix validate`.
- At most 20 entries.
- Kortix builds the package list when the change request merges. Nothing
  installs when a session boots. A session started before the merge does not
  have the package.
- A package that fails to load is reported in the session's health
  (`harness.details.extensions.failed`). The session still starts.

`../kortix/kortix-yaml.md` → `harnesses:` has the full entry schema.

## Test an extension

pi loads extensions only when the runtime starts. The session that writes an
extension does not load it, and `kortix sessions restart` does not reload it.

1. Commit the file on the session branch and open a change request.
2. After the merge, start a new session.
3. Ask the agent to call the tool by name.
4. If the tool is absent, read the session's health:
   `harness.details.extensions.loaded` lists each loaded extension and
   `harness.details.extensions.failed` gives the error of each one that did
   not load.
