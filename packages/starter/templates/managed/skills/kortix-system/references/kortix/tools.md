# Tools

A tool is a function the model calls during a turn. A Kortix session has
three kinds of tool, on every harness (OpenCode and pi):

| Kind | Names | Who implements it |
| --- | --- | --- |
| Harness tools | `bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `question`, … | The harness itself. |
| Kortix tools | `web_search`, `image_search`, `scrape_webpage`, `memory`, `show`, `kortix-connectors_call`, `kortix-connectors_describe` | Kortix. Every project has all seven without a `tools:` entry. |
| Project tools | Any name you register | Your project: one module, registered in `kortix.yaml` `tools:`. |

A Kortix tool and a project tool are **harness-neutral**: one module runs on
OpenCode and on pi, with the same name, arguments and output. The Kortix
runtime in the sandbox (the `kortix-agent` daemon) loads and runs them. pi
calls them in its own process. OpenCode calls them through a plugin the
daemon writes, which forwards each call to the daemon.

## Which tools does an agent get?

`kortix_version: 3` splits the question in two:

- **The registry.** `kortix.yaml` `tools:` maps a name to a module. The seven
  Kortix tools are always registered and need no entry. A module registered
  under a Kortix tool's name replaces that tool for every agent.
- **The agent.** `agents.<name>.tools` decides which tools the model sees:
  every tool by default, or a list, or `{ exclude: [...] }`.

There is no project-wide removal of a Kortix tool. To hide one, use the
agent's `tools` grant. Read `kortix.yaml` and its imports to answer which
tools an agent gets. `kortix tools ls` uses the v2 selection rule: on a v3
manifest with a `tools:` key it lists Kortix tools as "Removed" that every
agent still has. Ignore that line on v3.

The running session loaded its tools from the base branch when it started;
a change reaches sessions after its change request merges.

## Checklist: add a project tool

1. Write the module, for example `tools/lookup_order.ts` (section "The
   module" below).
2. Register it in `kortix.yaml`:
   ```yaml
   tools:
     lookup_order: tools/lookup_order.ts
   ```
3. If the tool reads a secret, store it (`kortix secrets set NAME=-`, the value
   on stdin), declare the name under `env:`, and grant it to the agents that
   call the tool (`agents.<name>.secrets`).
4. An agent with the default `tools` (omitted or `all`) sees the new tool. An
   agent with a list sees it only when the list names it.
5. `kortix validate` — exit 0.
6. `git add tools/lookup_order.ts kortix.yaml && git commit -m "Add the lookup_order tool"`
7. `git push origin HEAD`
8. `kortix cr open --title "Add the lookup_order tool" --description "…"`

New sessions load the tool after the user merges the change request.

## Checklist: hide a tool from an agent

1. In `kortix.yaml`, set `tools` on the agent:
   ```yaml
   agents:
     researcher:
       tools: [read, grep, web_search, lookup_order]   # only these
     support:
       tools:
         exclude: [bash, write, edit, memory]          # every tool but these
   ```
2. `kortix validate` — exit 0. A name that is not a harness, Kortix or
   registered tool is an error.
3. `git add kortix.yaml && git commit -m "Limit the researcher agent's tools"`
4. `git push origin HEAD`
5. `kortix cr open --title "Limit the researcher agent's tools" --description "…"`

## Checklist: change a Kortix tool

1. `kortix tools eject <name>`. It writes the Kortix source to
   `tools/<name>.ts` and sets `<name>: tools/<name>.ts` in `kortix.yaml` (in
   the file that declares the entry). The changed line ends with
   `# ejected from kortix:<name>`. It refuses when `tools/<name>.ts` exists,
   unless `--force`. On a v3 manifest with no `tools:` key it also writes
   `<other>: kortix:<other>` lines: delete them, they are errors in v3.
2. Edit `tools/<name>.ts`. Keep the default export
   (`description`, `parameters`, `execute(args, context)`). Keep the name, the
   arguments and the output JSON, so skills that name the tool and the web UI
   view still work (section "The web UI views").
3. `kortix validate` — exit 0.
4. `git add tools/<name>.ts kortix.yaml && git commit -m "Own the <name> tool"`
5. `git push origin HEAD`
6. `kortix cr open --title "Own the <name> tool" --description "…"`

The copy belongs to the project. Kortix no longer updates it. To return to
the maintained tool, delete the `tools:` line and the file.

## When an agent does not have a tool

A session of an agent whose `tools` grant hides a tool:

- OpenCode does not offer the tool to the model.
- pi does not offer the tool. A call to it fails with `Tool show not found`
  (for `show`).
- A skill that names the tool still loads (`kortix-memory` names `memory`).
  Do the task with other tools: without `memory`, read and edit the files
  under `memory/` with the file tools.
## The module

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

**Errors.** A thrown error ends the call; the model reads the message. Write
a message that says what to change.

**Imports.** A module may import `node:*` modules, Bun APIs, and relative
files (`./lib/client.ts`). A package import resolves only from a
`node_modules` next to the module or above it. The sandbox installs no
package for a tool, and a config release holds only the files Git tracks, so
prefer `fetch` for HTTP APIs. TypeScript runs as is; there is no build step.

**zod.** zod 4 writes `parameters` as
`z.toJSONSchema(z.object({ … }))`. The module then loads only where `zod`
resolves from a `node_modules`; otherwise it fails with
`Cannot find package 'zod'`. To author with zod and ship plain JSON Schema,
print the schema once and paste it:
`bun -e "import { z } from 'zod'; console.log(JSON.stringify(z.toJSONSchema(z.object({ id: z.string() })), null, 2))"`.

## Register it: `tools:`

```yaml
tools:
  lookup_order: tools/lookup_order.ts
  crm_note: integrations/crm/note.ts
  web_search: integrations/search/web_search.ts   # replaces the Kortix web_search
```

- The key is the tool name the model calls: snake_case, a lower-case letter
  first, at most 64 characters (`^[a-z][a-z0-9_]{0,63}$`). A Kortix tool's
  name is also accepted, to replace that tool.
- A harness tool name is refused: `bash`, `read`, `write`, `edit`,
  `apply_patch`, `glob`, `grep`, `list`, `task`, `question`, `todowrite`,
  `webfetch`, `websearch`, `skill`, `lsp`, `invalid`, `execute`,
  `plan_exit`, and any `pty_*` name.
- A value is a repo-relative path to a `.ts`, `.js`, `.mts`, `.mjs`, `.cts`
  or `.cjs` file. No leading `/` or `-`, no `.` or `..` segment. Any folder
  works. The v2 value `kortix:<name>` is an error in v3.
- A file listed under `imports:` may register tools too. One name, one file.

## Who may use which tool: `agents.<name>.tools`

```yaml
agents:
  assistant:
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

- The names are tool names of all three kinds. Connector tools are governed
  by `agents.<name>.connectors`, not by this list.
- Each name is a harness tool, a Kortix tool or a registered tool. Any other
  name is an error. The v2 map form `{ bash: false }` is an error: use
  `{ exclude: [bash] }`.
- `tools` decides whether the model sees a tool. `permission` on the agent
  block decides whether a call is allowed, asked, or denied. A tool in the
  list keeps its permission rule; a tool not in the list is hidden and denied.
- A subagent started with `task`: on pi it gets the tools both lists allow
  (its own and the session agent's). On OpenCode it gets its own list's tools,
  because OpenCode applies an agent's rules to that agent only. Leave `task`
  out of a list to stop that agent from delegating.

On OpenCode, Kortix maps the names to OpenCode's own: `bash` also covers the
pty plugin's `pty_*` tools, and `write`, `edit` and `apply_patch` share one
OpenCode permission (`edit`): listing either shows both, excluding either
hides both.

## The web UI views

The web UI has a view for each Kortix tool, picked by the tool name. The
`show` and `memory` views read the call's arguments (`type`, `path`, `url`,
`content`, `items`; `command`, `path`). The `web_search`, `image_search` and
`scrape_webpage` views read the output JSON. A changed copy that keeps the
name must keep those arguments and that output shape, or the UI shows the
raw output.

## When a change takes effect

The runtime loads the tools when it starts.

- A merged change reaches new sessions.
- With config releases on, a running session picks up the release: pi
  restarts its runtime in place while idle when a project tool changed; OpenCode reloads.
- A tool module that fails to load (missing file, no default export, a
  `parameters` that is not an object schema, an error at import, a package
  that does not resolve) is left out. The other tools still load. The daemon
  log line is `[tools] project tools that did not load`, with the reason per
  tool.

## Check what a session has

- `kortix.yaml` — the `tools:` registry and the agent's `tools` grant.
- `kortix validate` — tool names, paths, and each agent's `tools` grant.
- In a new session, call the tool once with real arguments
  (`kortix sessions new --wait --prompt "Call the lookup_order tool once with id A-1042."`).
  A tool that is not loaded is not offered to the model; a tool that throws
  answers with its error message. `kortix sessions log <id>` prints the
  messages, with each tool call and its status.

## Tools in a legacy harness folder

A `kortix_version: 3` session does not read `harnesses/opencode/tools/` or
`.kortix/opencode/tools/`. Legacy v2 projects may carry copies of the Kortix
tools or their own tools there. To keep one on v3, port it to a project tool:

1. Move the file out of the folder (e.g. to `tools/`).
2. Replace `tool({ description, args, execute })` with a plain object.
   `args: { id: tool.schema.string().describe('…') }` becomes
   `parameters: { type: 'object', properties: { id: { type: 'string', description: '…' } }, required: ['id'] }`.
3. `context.directory` keeps its name. Read secrets from `context.env`.
4. Register it under `tools:` in `kortix.yaml`.

Delete copies of the Kortix tools: the runtime hosts all seven.
