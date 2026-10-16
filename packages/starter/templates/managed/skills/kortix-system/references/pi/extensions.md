# pi extensions and packages

An extension adds tools, hooks or commands to a pi session. pi's own
extension system runs every extension. Kortix writes no adapter code for an
extension, so a package from <https://pi.dev/packages> runs unmodified.

This is the pi counterpart of an OpenCode plugin. Both are extensions in
`kortix.yaml`: the project registers each one under `extensions`, with one
implementation per harness, and each agent enables the ones it uses. A tool
that takes arguments and returns text needs no extension: write it as a
project tool (`kortix.yaml` `tools:`, `../kortix/tools.md`) and both
harnesses run it.

## An extension file in the repository

Write the file anywhere in the repository, for example
`extensions/word-count.ts`:

```ts
// extensions/word-count.ts
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

Register it and enable it on an agent:

```yaml
extensions:
  word-count:
    pi: extensions/word-count.ts
agents:
  writer:
    extensions: [word-count]
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

## pi packages

An npm package is an extension too. The `pi` value is the pi.dev install
line with an exact version:

```yaml
extensions:
  web-access:
    pi: npm:pi-web-access@0.30.0
  mcp-adapter:
    pi:
      source: npm:pi-mcp-adapter@2.36.0
      extensions: ["extensions/*.ts"]   # load only these files of the package
      skills: []                        # load none of its skills
  audit:
    opencode: extensions/audit.opencode.ts
    pi: extensions/audit.pi.ts          # an extension file in this repository
agents:
  researcher:
    extensions: [web-access, audit]
  reviewer:
    extensions: none                    # the default: no extension
```

- A `pi` value is `npm:<name>@<x.y.z>`, a repository path to a file or a
  folder, or `{ source, extensions, skills, prompts, themes }`. Each filter
  is a list of glob patterns. An omitted filter loads everything; `[]` loads
  nothing.
- A version range, a missing version or a Git source fails `kortix validate`.
- An agent loads only the extensions its `extensions` grant names. Kortix
  sends them to the session as `KORTIX_PI_PACKAGES`; a repository path
  becomes `./<path>`.
- A session loads the extensions of the agent it starts with. A switch to
  another agent in the running session keeps them.
- An extension with only an `opencode` value does nothing on pi.
- Kortix builds the npm packages when the change request merges. Nothing
  installs when a session boots. A session started before the merge does not
  have the package.
- A package that fails to load is reported in the session's health
  (`harness.details.extensions.failed`). The session still starts.

`../kortix/kortix-yaml.md` has the full entry schema.

Legacy: a `kortix_version` 1 or 2 project declares packages under
`harnesses.pi.packages` and files under `harnesses/pi/extensions/`.
`kortix migrate` prints the v3 manifest; `kortix migrate --write` writes it.

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
