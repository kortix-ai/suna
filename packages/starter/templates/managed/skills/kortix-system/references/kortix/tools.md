# Tools

A tool is a function the model calls during a turn. A Kortix session has
three kinds of tool, on every harness (OpenCode and pi):

| Kind | Names | Who implements it |
| --- | --- | --- |
| Harness tools | `bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `question`, … | The harness itself. |
| Kortix tools | `web_search`, `image_search`, `scrape_webpage`, `memory`, `show` | Kortix. Every session has them. |
| Project tools | Any name you declare | Your project: one module, declared in `kortix.yaml` `tools:`. |

A Kortix tool and a project tool are **harness-neutral**: one module runs on
OpenCode and on pi, with the same name, arguments and output. The Kortix
runtime in the sandbox (the `kortix-agent` daemon) loads and runs them. pi
calls them in its own process. OpenCode calls them through a plugin the
daemon writes, which forwards each call to the daemon.

## Add a project tool

1. Write the module (any folder; `tools/` is the convention).
2. Declare it in `kortix.yaml` under `tools:`.
3. Optional: limit which agents may use it (`agents.<name>.tools`).
4. Run `kortix validate`.
5. Open a change request. New sessions load the tool after the merge.

### 1. The module

```ts
// tools/lookup_order.ts
export default {
  description: 'Look up an order by id. Returns its status and carrier.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The order id, e.g. "A-1042"' },
      include_items: { type: 'boolean', description: 'Also list the items' },
    },
    required: ['id'],
  },
  async execute(args, context) {
    const response = await fetch(`https://orders.example.com/v1/orders/${args.id}`, {
      headers: { authorization: `Bearer ${context.env.ORDERS_API_KEY}` },
      signal: context.signal,
    })
    if (!response.ok) throw new Error(`orders API answered ${response.status}`)
    return await response.json()
  },
}
```

The default export is a plain object. The module imports nothing from a
harness: no `@opencode-ai/plugin`, no pi package.

| Field | Rule |
| --- | --- |
| `description` | Non-empty string. The model reads it to decide when to call the tool. |
| `parameters` | JSON Schema of the arguments, `type: 'object'`. List required arguments in `required`. The model receives this schema as it is. |
| `execute(args, context)` | Returns a string, or any JSON value (sent as indented JSON). May be `async`. A thrown error is the tool's error; the model reads its message. |

The runtime does not validate `args` against `parameters`. Check the
arguments the tool depends on.

`context`:

| Field | What it is |
| --- | --- |
| `sessionId` | The Kortix session the call belongs to. |
| `agent` | The agent that made the call. |
| `directory` | The project checkout (`/workspace`). Resolve a relative path against it. |
| `env` | The session environment: the box env plus the project secrets this agent receives, as they are now. Read a secret as `context.env.NAME`, not `process.env.NAME`: a secret changed after the box booted is only in `context.env`. |
| `signal` | An `AbortSignal` that aborts when the user stops the turn. Pass it to `fetch`. |

**Output size.** An output over 50 KB or 2,000 lines is saved whole to a file
under the system temp directory. The model receives the head, the size, and
the file path. Return what the model needs, not a raw dump.

**Imports.** A module may import `node:*` modules, Bun APIs, and relative
files (`./lib/client.ts`). A package import resolves from a `node_modules`
next to the module or above it. The sandbox installs no package for a tool,
so prefer `fetch` for HTTP APIs. TypeScript runs as is; there is no build
step. To write `parameters` with zod 4, use `z.toJSONSchema(z.object({ … }))`.

### 2. Declare it: `tools:`

```yaml
tools:
  lookup_order: tools/lookup_order.ts
  crm_note: integrations/crm/note.ts
```

- The key is the tool name the model calls: snake_case, a lower-case letter
  first, at most 64 characters (`^[a-z][a-z0-9_]{0,63}$`).
- A harness tool name is refused: `bash`, `read`, `write`, `edit`,
  `apply_patch`, `glob`, `grep`, `list`, `task`, `question`, `todowrite`,
  `webfetch`, `websearch`, `skill`, `lsp`, `invalid`, `execute`,
  `plan_exit`, and any `pty_*` name.
- A Kortix tool name (`web_search`, `image_search`, `scrape_webpage`,
  `memory`, `show`) is allowed: the project tool replaces the Kortix tool.
- The value is a repo-relative path to a `.ts`, `.js`, `.mts`, `.mjs`,
  `.cts` or `.cjs` file. No leading `/`, no `..`. Any folder works.
- A file listed under `imports:` may declare `tools:` too. One name, one file.

### 3. Who may use which tool: `agents.<name>.tools`

```yaml
agents:
  kortix:
    tools: all                                   # every tool (the default)
  researcher:
    tools: [read, grep, web_search, lookup_order] # only these
  support:
    tools:
      exclude: [bash, write, edit]               # every tool but these
  greeter:
    tools: none                                   # no tool
```

| Value | Meaning |
| --- | --- |
| omitted, or `all` | Every tool. |
| `none` | No tool. |
| a list | Only the tools listed. A list with `*` is `all`. |
| `{ exclude: [...] }` | Every tool except the ones listed. |
| a map, e.g. `{ bash: false }` | The earlier form: `false` removes a tool. |

- The names are tool names of all three kinds. Connector tools are governed
  by `agents.<name>.connectors`, not by this list.
- `tools` decides whether the model sees a tool. `permission` in the agent's
  `.md` decides whether a call is allowed, asked, or denied. A tool in the
  list keeps its permission rule; a tool not in the list is hidden and denied.
- A subagent started with `task` gets the tools both lists allow: its own
  and the agent of the session.
- `kortix validate` warns about a name that is not a harness, Kortix or
  project tool. A typo in an `exclude` list leaves the real tool on.

On OpenCode, Kortix maps the names to OpenCode's own: `bash` also covers the
pty plugin's `pty_*` tools, and `write`, `edit` and `apply_patch` share one
OpenCode permission (`edit`): listing either shows both, excluding either
hides both.

## When a change takes effect

The runtime loads the tools when it starts.

- A merged change reaches new sessions.
- With config releases on, a running session picks up the release: pi
  restarts its runtime in place while idle; OpenCode reloads.
- A tool module that fails to load (missing file, no default export, a
  `parameters` that is not an object schema, an error at import) is left out.
  The other tools still load. The daemon log line is
  `[tools] project tools that did not load`, with the reason per tool.

## Check what a session has

- `kortix validate` — names, paths, a missing file, and unknown names in
  agent lists.
- In a new session, call the tool once with real arguments. A tool that is
  not loaded is not offered to the model; a tool that throws answers with its
  error message.

## OpenCode-only tools (`harnesses/opencode/tools/`)

Projects created before hosted tools carry copies of the Kortix tools in
`harnesses/opencode/tools/` (`web_search.ts`, `memory.ts`, …) and may have
their own tools there. OpenCode still loads that folder; pi does not.

- A name defined in that folder wins over the hosted tool of the same name on
  OpenCode, so a project keeps its own copy until it deletes it.
- Delete the template copies of the Kortix tools: the runtime hosts them on
  both harnesses.
- To make your own OpenCode tool harness-neutral:
  1. Move the file out of `harnesses/opencode/tools/` (e.g. to `tools/`).
  2. Replace `tool({ description, args, execute })` with a plain object.
     `args: { id: tool.schema.string().describe('…') }` becomes
     `parameters: { type: 'object', properties: { id: { type: 'string', description: '…' } }, required: ['id'] }`.
  3. `context.directory` keeps its name. Read secrets from `context.env`.
  4. Declare it under `tools:` in `kortix.yaml`.
