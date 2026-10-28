# Tools

A tool is a function the model calls during a turn. A session has three
kinds:

| Kind | Names | Source |
| --- | --- | --- |
| Runtime tools | `bash`, `read`, `write`, `edit`, `glob`, `grep`, `question`, `task` | pi (`../pi.md`). `codemode` is set by `agents.<name>.codemode`. |
| Kortix tools | `web_search`, `image_search`, `scrape_webpage`, `memory`, `show` | Kortix. Always registered. |
| Project tools | Any snake_case name | A module in the repository, registered under `tools:`. |

`kortix tools ls` lists the tools the current files give a session:
`NAME`, `KIND` (`kortix`, `kortix (overridden)`, `project`), `SOURCE`.

## Add a project tool

1. Write the module, for example `tools/lookup_order.ts` (below).
2. Register it: `tools: { lookup_order: tools/lookup_order.ts }`.
3. A secret it reads: store it (`kortix secrets set NAME=-`) and grant it to
   each agent that calls the tool (`agents.<name>.secrets`).
4. Limit who may call it, if needed (`agents.<name>.tools`).
5. `kortix validate` exits 0. `kortix tools ls` lists it as `project`.
6. Commit, push, `kortix cr open`. New sessions load it after the merge.

## Change a Kortix tool

1. `kortix tools eject <name>` writes the Kortix source to `tools/<name>.ts`
   and registers `tools.<name>: tools/<name>.ts`. It refuses when the file
   exists, unless `--force`.
2. Edit the copy. Keep the name, the arguments and the output shape: skills
   and the web app's tool views depend on them.
3. `kortix validate`, `kortix tools ls` (kind `kortix (overridden)`), CR.

The copy is the project's. Kortix no longer updates it. Delete the entry and
the file to return to the maintained tool.

## Remove a tool from an agent

The Kortix tools cannot be unregistered. Hide one per agent:

```yaml
agents:
  support:
    tools: { exclude: [bash, write, edit, web_search] }   # every tool but these
  researcher:
    tools: [read, grep, web_search, lookup_order]         # only these
  greeter:
    tools: none
```

`all` is the default. A name must be a runtime, Kortix or registered tool.
`tools` hides a tool; `permission` decides calls to a visible one. A
subagent gets the tools both its own list and the caller's list allow.
Leave `task` out to stop an agent from delegating.

## The module

```ts
// tools/lookup_order.ts
export default {
  description: 'Look up an order by id. Returns its status and carrier.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The order id, e.g. "A-1042"' } },
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

- `description`: the model reads it to decide when to call the tool.
- `parameters`: a JSON Schema object, sent to the model as it is. The runtime
  does not validate `args` against it: check what you depend on.
- `execute(args, context)` returns a string or any JSON value. A thrown error
  is the tool's answer: write a message that says what to change.
- `context`: `sessionId`, `agent`, `directory` (`/workspace`), `env` (the
  session env plus this agent's secrets, as they are now: read secrets from
  `context.env`, not `process.env`), `signal` (aborts when the user stops
  the turn).
- Imports: `node:*`, Bun APIs, relative files. A package resolves only from
  a committed `node_modules` next to the module or above it; prefer `fetch`.
  TypeScript runs as is.
- Output over 50 KB or 2,000 lines goes to a temp file; the model gets the
  head and the path. Return what the model needs.

## Registry rules

- The name is snake_case: `^[a-z][a-z0-9_]{0,63}$`, or a Kortix tool's name
  to replace it. A runtime tool name (`bash`, `read`, `task`, …) or a
  `pty_*` name is refused.
- The value is a repository path to a `.ts`, `.js`, `.mts`, `.mjs`, `.cts`
  or `.cjs` file. No leading `/`, no `..`.
- An imported file may declare `tools:`. One name lives in one file.
- A module that fails to load is skipped; the other tools still load. Prove
  it in a new session after the merge:
  `kortix sessions new --json --prompt "Call lookup_order once with id A-1042."`,
  then `kortix sessions wait-for <id>` and `kortix sessions log <id>`.
