# Tools

A tool is a function the model calls during a turn. A Kortix session has
three kinds of tool, on every harness (OpenCode and pi):

| Kind | Names | Who implements it |
| --- | --- | --- |
| Harness tools | `bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `question`, … | The harness itself. |
| Kortix tools | `web_search`, `image_search`, `scrape_webpage`, `memory`, `show` | Kortix. `kortix.yaml` lists each as `<name>: kortix:<name>`. No `tools:` key = all five. |
| Project tools | Any name you declare | Your project: one module, declared in `kortix.yaml` `tools:`. |

A Kortix tool and a project tool are **harness-neutral**: one module runs on
OpenCode and on pi, with the same name, arguments and output. The Kortix
runtime in the sandbox (the `kortix-agent` daemon) loads and runs them. pi
calls them in its own process. OpenCode calls them through a plugin the
daemon writes, which forwards each call to the daemon.

## Which tools does this project's session get?

Run `kortix tools ls` in the project root (`/workspace`). It reads
`kortix.yaml` and its imports:

```text
$ kortix tools ls
NAME            KIND                 SOURCE
web_search      kortix (overridden)  tools/web_search.ts
scrape_webpage  kortix               kortix:scrape_webpage
memory          kortix               kortix:memory
show            kortix               kortix:show
lookup_order    project              tools/lookup_order.ts

Removed Kortix tools: image_search
Add `<name>: kortix:<name>` under `tools:` to get one back.
```

`--json` prints `{ manifest, tools_key, tools: [{ name, kind, source }], removed }`.

The selection rule:

- No `tools:` key in `kortix.yaml` or in any imported file: every session
  gets all five Kortix tools.
- A `tools:` key, even an empty one (`tools: {}`, or `tools:` with every line
  deleted): sessions get only the Kortix tools it lists, as `kortix:<name>`
  or as a module path that replaces the tool. A key in an imported file counts.

`kortix tools ls` reads the files in `/workspace`. The running session loaded
its tools from the base branch when it started; a change reaches sessions
after its change request merges.

## Checklist: add a project tool

1. Write the module, for example `tools/lookup_order.ts` (section "The
   module" below).
2. Declare it in `kortix.yaml`, under the existing `tools:` key. Keep the
   `kortix:<name>` lines:
   ```yaml
   tools:
     web_search: kortix:web_search
     image_search: kortix:image_search
     scrape_webpage: kortix:scrape_webpage
     memory: kortix:memory
     show: kortix:show
     lookup_order: tools/lookup_order.ts
   ```
   If `kortix.yaml` has no `tools:` key, add one that lists the five
   `kortix:<name>` lines and the new tool. A `tools:` key with only the new
   tool removes the five Kortix tools; `kortix validate` warns about it.
3. If the tool reads a secret, store it (`kortix secrets set NAME=-`, the value
   on stdin) and grant it to the agents that call the tool
   (`agents.<name>.secrets`).
4. Optional: limit which agents may use it (`agents.<name>.tools`).
5. `kortix validate` — exit 0, and no warning on `tools`.
6. `kortix tools ls` — the tool is listed with kind `project`.
7. `git add tools/lookup_order.ts kortix.yaml && git commit -m "Add the lookup_order tool"`
8. `git push origin HEAD`
9. `kortix cr open --title "Add the lookup_order tool" --description "…"`

New sessions load the tool after the user merges the change request.

## Checklist: remove a Kortix tool

1. In `kortix.yaml`, delete the `<name>: kortix:<name>` line under `tools:`.
   If the file has no `tools:` key, add one that lists the Kortix tools to
   keep, as `<name>: kortix:<name>`, and leave out the one to remove.
2. Remove the tool from any `agents.<name>.tools` list that names it.
3. `kortix validate` — exit 0. A warning on `agents.<name>.tools` names a list
   that still has the tool.
4. `kortix tools ls` — the tool is under `Removed Kortix tools`.
5. `git add kortix.yaml && git commit -m "Remove the <name> tool"`
6. `git push origin HEAD`
7. `kortix cr open --title "Remove the <name> tool" --description "…"`

To hide a tool from one agent only, do not remove it: use the checklist
"limit tools per agent".

## Checklist: change a Kortix tool

1. `kortix tools eject <name>`. It writes the Kortix source to
   `tools/<name>.ts` and sets `<name>: tools/<name>.ts` in `kortix.yaml` (in
   the file that declares the entry). The changed line ends with
   `# ejected from kortix:<name>`. With no `tools:` key, it also lists the
   other four Kortix tools. It refuses when `tools/<name>.ts` exists, unless
   `--force`.
2. Edit `tools/<name>.ts`. Keep the default export
   (`description`, `parameters`, `execute(args, context)`). Keep the name, the
   arguments and the output JSON, so skills that name the tool and the web UI
   view still work (section "The web UI views").
3. `kortix validate` — exit 0.
4. `kortix tools ls` — the tool has kind `kortix (overridden)`.
5. `git add tools/<name>.ts kortix.yaml && git commit -m "Own the <name> tool"`
6. `git push origin HEAD`
7. `kortix cr open --title "Own the <name> tool" --description "…"`

The copy belongs to the project. Kortix no longer updates it. To return to
the maintained tool, set the line back to `<name>: kortix:<name>` and delete
the file.

## Checklist: limit tools per agent

1. In `kortix.yaml`, set `tools` on the agent (section "Who may use which
   tool" below):
   ```yaml
   agents:
     researcher:
       tools: [read, grep, web_search, lookup_order]
   ```
2. `kortix validate` — exit 0, with no warning on `agents.researcher.tools`.
   A warning names a tool that does not exist or a Kortix tool the project
   does not load.
3. `git add kortix.yaml && git commit -m "Limit the researcher agent's tools"`
4. `git push origin HEAD`
5. `kortix cr open --title "Limit the researcher agent's tools" --description "…"`

## When the project removed a tool

A session of a project that does not list a Kortix tool:

- OpenCode does not offer the tool to the model.
- pi does not offer the tool. A call to it fails with `Tool show not found`
  (for `show`).
- The daemon answers `POST /kortix/tools/<name>` with `404`,
  `no tool named <name> is loaded`.
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

## Declare it: `tools:`

```yaml
tools:
  web_search: kortix:web_search
  memory: kortix:memory
  lookup_order: tools/lookup_order.ts
  crm_note: integrations/crm/note.ts
```

- The key is the tool name the model calls: snake_case, a lower-case letter
  first, at most 64 characters (`^[a-z][a-z0-9_]{0,63}$`).
- A harness tool name is refused: `bash`, `read`, `write`, `edit`,
  `apply_patch`, `glob`, `grep`, `list`, `task`, `question`, `todowrite`,
  `webfetch`, `websearch`, `skill`, `lsp`, `invalid`, `execute`,
  `plan_exit`, and any `pty_*` name.
- A value is `kortix:<name>` (a Kortix tool, under its own name only) or a
  repo-relative path to a `.ts`, `.js`, `.mts`, `.mjs`, `.cts` or `.cjs`
  file. No leading `/`, no `..`. Any folder works.
- A Kortix tool name with a path: the project module replaces the Kortix tool.
- A file listed under `imports:` may declare `tools:` too. One name, one file.

`kortix validate` errors and warnings:

| Case | Severity | Message |
| --- | --- | --- |
| `web_search: kortix:image_search` | error | ``must be `kortix:web_search` (the Kortix tool) or a repo-relative path to a .ts or .js module (e.g. `tools/web_search.ts`) that replaces it.`` |
| `web_serch: kortix:web_serch` | error | ``must be a repo-relative path to a .ts or .js module (e.g. `tools/web_serch.ts`). `kortix:<name>` names a Kortix tool under its own name: …`` |
| A module path that does not exist | error | `"tools/x.ts" does not exist in the project files.` |
| A `tools:` key with no Kortix tool | warning | ``Sessions of this project get no Kortix tool (web_search, image_search, scrape_webpage, memory, show). Add `<name>: kortix:<name>` to keep one.`` |
| An agent's `tools` names a Kortix tool the project does not load | warning | ``"show" is a Kortix tool this project does not load: add `show: kortix:show` under the top-level `tools`, or remove it here.`` |

## Who may use which tool: `agents.<name>.tools`

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
- An agent list cannot add a Kortix tool the project does not load: list it
  under the top-level `tools:` first.
- `tools` decides whether the model sees a tool. `permission` in the agent's
  `.md` decides whether a call is allowed, asked, or denied. A tool in the
  list keeps its permission rule; a tool not in the list is hidden and denied.
- A subagent started with `task`: on pi it gets the tools both lists allow
  (its own and the session agent's). On OpenCode it gets its own list's tools,
  because OpenCode applies an agent's rules to that agent only. Leave `task`
  out of a list to stop that agent from delegating.
- `kortix validate` warns about a name that is not a harness, Kortix or
  project tool. A typo in an `exclude` list leaves the real tool on.

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
  restarts its runtime in place while idle when a project tool or the list of
  Kortix tools changed; OpenCode reloads.
- A tool module that fails to load (missing file, no default export, a
  `parameters` that is not an object schema, an error at import, a package
  that does not resolve) is left out. The other tools still load. The daemon
  log line is `[tools] project tools that did not load`, with the reason per
  tool.

## Check what a session has

- `kortix tools ls` — the tools a session of the current files gets, and the
  removed Kortix tools.
- `kortix validate` — names, paths, a missing file, `kortix:` values, and
  unknown names in agent lists.
- In a new session, call the tool once with real arguments
  (`kortix sessions new --wait --prompt "Call the lookup_order tool once with id A-1042."`).
  A tool that is not loaded is not offered to the model; a tool that throws
  answers with its error message. `kortix sessions log <id>` prints the
  messages, with each tool call and its status.

## OpenCode-only tools (`harnesses/opencode/tools/`)

Projects created before hosted tools carry copies of the Kortix tools in
`harnesses/opencode/tools/` (`web_search.ts`, `memory.ts`, …) and may have
their own tools there. OpenCode still loads that folder; pi does not.

- A name defined in that folder wins over the hosted tool of the same name on
  OpenCode, so a project keeps its own copy until it deletes it.
- Delete the template copies of the Kortix tools: the runtime hosts the ones
  `kortix.yaml` lists on both harnesses. To keep a changed copy, move it with
  `kortix tools eject <name>` and port the change.
- To make your own OpenCode tool harness-neutral:
  1. Move the file out of `harnesses/opencode/tools/` (e.g. to `tools/`).
  2. Replace `tool({ description, args, execute })` with a plain object.
     `args: { id: tool.schema.string().describe('…') }` becomes
     `parameters: { type: 'object', properties: { id: { type: 'string', description: '…' } }, required: ['id'] }`.
  3. `context.directory` keeps its name. Read secrets from `context.env`.
  4. Declare it under `tools:` in `kortix.yaml`.
