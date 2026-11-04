# pi: tools, permissions, subagents, extensions

pi is the runtime of every Kortix session. It runs inside the Kortix daemon
in the sandbox, calls models only through the Kortix LLM gateway, and reads
its config from `kortix.yaml` and the files it names.

## Tools

| Tool | What it does | Permission key |
| --- | --- | --- |
| `bash` | Runs a shell command in `/workspace`. | `bash` |
| `read` | Reads a file. | `read` |
| `write` | Creates or replaces a file. | `edit` |
| `edit` | Replaces text in a file. | `edit` |
| `glob` | Finds files by glob pattern. | `glob` |
| `grep` | Searches file contents by regular expression. | `grep` |
| `question` | Asks the user and waits for the answer. | `question` |
| `agent` | Starts a subagent (`task` is its old name). | the `subagents` grant |
| `codemode` | Runs a JavaScript script that calls the other tools as `await tools.<name>(args)`. Only the script output returns. | the rule of each nested call |
| `web_search` | Searches the web. Batch queries with `\|\|\|`. | `websearch` |
| `image_search` | Searches for images. | `websearch` |
| `scrape_webpage` | Fetches pages as markdown. Comma-separated URLs. | `webfetch` |
| `image_gen` | Generates or edits an image file. | `edit` |
| `show` | Shows a file, an image, a URL or content to the user. | `show` |

- The three web tools (`web_search`, `image_search`, `scrape_webpage`) bill
  the project. No key is needed in the sandbox.
- Project tools from `tools:` run like the Kortix tools (`kortix/tools.md`).
- `agents.<name>.codemode`: `on` (default), `only` (the model sees only
  `codemode`), `off`. A script cannot call `agent` or `question`.
- Not on pi: `webfetch`, `websearch`, `todowrite`, `lsp`, `apply_patch`,
  `skill`, `list`, MCP tools. Fetch a page with `scrape_webpage`. Read a
  skill with `read`. Keep a process running with
  `nohup <command> >/tmp/<name>.log 2>&1 &`. Call an app with
  `kortix connectors`.

## Permissions

`agents.<name>.permission` in `kortix.yaml` decides each call. A key names
the permission key above, or a tool name; a tool name wins over its key.

```yaml
permission:
  bash:
    "git push *": ask
    "rm -rf *": deny
    "*": allow
  edit: ask
  webfetch: deny
  external_directory: deny
```

- A rule is `allow`, `ask` or `deny`, or a map of glob pattern to one of
  them. The most specific (longest) matching pattern wins, in any key order.
- `bash` patterns match each command of the line. pi splits on `;`, `&`,
  `|` and newlines and reads `$(…)` and backtick bodies. The strictest
  answer wins.
- File patterns match the resolved path, relative to `/workspace`. A path
  outside it also answers to `external_directory`. A path rule does not
  govern `bash`: `cat secrets/a` is a `bash` command.
- `ask` stops the call and asks the user: `once`, `always` (this permission
  key, for the session) or `reject`. A `deny` still wins after `always`.
- No rule: `allow`. `skill` and `task` are not permission keys: use the
  `skills` and `subagents` grants.
- `agents.<name>.tools` hides tools; `permission` decides calls to visible
  ones.

## Subagents

`agent` runs one prompt in a child and returns its final message.
Arguments: `description`, `prompt`, `subagent_type` (a declared agent) or
`agent` (an inline agent: `instructions`, optional `description`, `model`,
`tools`), `session`, and `task_id` to continue an earlier child.

- `subagent_type` is a declared, enabled agent with `mode: subagent` or
  `all`, named in the caller's `subagents` grant. pi has no built-in
  `general` or `explore` subagent. An inline agent needs no grant: leave
  `agent` and `task` out of `tools` to stop an agent from delegating.
- A subagent runs with its own prompt, model and permission. A call must
  pass both the subagent's rules and the caller's: a `deny` from either wins.
  A child never gets a tool its caller lacks.
- `session: "separate"` (the default) runs the subagent in its own new
  session with its own sandbox and branch. The one call waits until that
  session finishes (up to 30 minutes) and returns its final message: ask the
  subagent to put the answer and the paths of its files there. A separate
  child may delegate again, at most 2 levels deep; at most 4 run at once.
- `run_in_background: true` (separate sessions only) returns the child's
  `task_id` at once. Keep working or end your turn: the child's final
  report arrives later as a new message in this session, one per finished
  turn of the child. Never poll or wait for it. A follow-up with only the
  `task_id` also returns at once. Use it for long or parallel work.
- `session: "same"` runs it inside this session: no boot, no new sandbox.
  It cannot start a subagent or ask the user a question.
- Several `agent` calls alone in one message run at the same time. The user
  sees each child session.
- Delegate with `agent`, not with `kortix sessions new` + `wait-for` from bash.
- With codemode `only`, call `agent` and `question` directly, not from a
  script: a script may not call them.

## Skills and slash commands

- The system prompt lists each skill the agent's `skills` grant allows, with
  its path. Read the `SKILL.md` with `read`.
- A prompt that starts with `/<command>` runs a `commands:` entry the agent
  enables, or a granted skill. In a command prompt, `$ARGUMENTS` is the raw
  argument text and `$1`, `$2` are words (a quoted string is one word). pi
  does not run shell expansion in a command.

## Extensions

An extension adds tools, hooks or commands. pi runs packages from
https://pi.dev/packages unmodified. A tool that takes arguments and returns
text needs no extension: write a project tool (`kortix/tools.md`).

```yaml
extensions:
  word-count: { pi: extensions/word-count.ts }    # a file in the repository
  web-access: { pi: "npm:pi-web-access@0.30.0" }  # an exact npm pin
  mcp-adapter:
    pi: { source: "npm:pi-mcp-adapter@2.36.0", extensions: ["extensions/*.ts"], skills: [] }
agents:
  kortix:
    tools: all
    extensions: [word-count, web-access]          # all | none | names; omitted = none
```

```ts
// extensions/word-count.ts
export default function (pi) {
  pi.registerTool({
    name: 'word_count',
    label: 'word_count',
    description: 'Count the words in a text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(_toolCallId, params) {
      const count = params.text.trim().split(/\s+/).filter(Boolean).length
      return { content: [{ type: 'text', text: String(count) }], details: {} }
    },
  })
}
```

- `pi.registerTool` adds a tool, `pi.on('<event>', handler)` a hook
  (`tool_call`, `before_agent_start`, `input`, …), `pi.registerCommand` a
  command. pi supplies `typebox` and the `@earendil-works/pi-*` packages.
- The agent's permission rules run before any extension `tool_call` hook.
- The session has no pi terminal UI: `ctx.ui` calls do nothing. Use the
  `question` tool.
- An npm source needs an exact version. A version range fails
  `kortix validate`.

## When a change takes effect

- A session reads its config from the default branch's config release. A
  change on your session branch takes effect after its CR merges.
- After the merge, running sessions pick up agents, skills, `AGENTS.md`,
  tools and commands while idle.
- Extensions and `codemode` load when the runtime starts. Test an extension
  in a new session after the merge: ask the agent to call its tool by name.
- Compaction runs by itself near the context limit;
  `kortix sessions compact <id>` runs it now. The transcript keeps every
  message.
