# pi tools

A pi session has eight harness tools and up to five Kortix tools, then the
project's own tools (`kortix.yaml` `tools:`, `../kortix/tools.md`). A project
file is not necessary for the harness tools. A pi extension or a pi package
can add more (`extensions.md`).

| Tool | What it does | Permission key |
| --- | --- | --- |
| `bash` | Runs a shell command in the workspace. | `bash` |
| `read` | Reads a file. | `read` |
| `write` | Creates or replaces a file. | `edit` |
| `edit` | Replaces text in a file. | `edit` |
| `glob` | Finds files by glob pattern (ripgrep). | `glob` |
| `grep` | Searches file contents with a regular expression (ripgrep). | `grep` |
| `question` | Asks the user one or more questions and waits for the answers. | `question` |
| `task` | Delegates one task to a subagent (`agents.md`). | `task` |
| `web_search` | Searches the web (Tavily). Batch queries with `|||`. | `websearch` |
| `image_search` | Searches for images (Serper). Batch queries with `|||`. | `websearch` |
| `scrape_webpage` | Fetches pages as markdown (Firecrawl). Comma-separated URLs. | `webfetch` |
| `memory` | Reads and writes the project brain in `memory/`. | `edit` (`read` for the `view` command) |
| `show` | Shows a file, an image, a URL or inline content to the user. | `show` |

`web_search`, `image_search`, `scrape_webpage`, `memory` and `show` are the
Kortix tools: the Kortix runtime runs one implementation of each on every
harness, so a skill that names one of them works on both. With no `tools:`
key in `kortix.yaml`, a session has all five; with one, only the ones it
lists as `<name>: kortix:<name>`. A Kortix tool the project does not list is
not offered, and a call to it fails with `Tool <name> not found`.
`kortix tools ls` lists what a session gets. A project tool is a
harness-neutral module the runtime runs the same way; prefer it over a pi
extension when the tool only needs arguments in and text out.
`agents.<name>.tools` in `kortix.yaml` decides which tools an agent sees.

A subagent gets every tool except `question` and `task`, limited by its own
`agents.<name>.tools` and the session agent's. The built-in `explore`
subagent gets `bash`, `read`, `glob` and `grep`.

## Tools pi does not have

`todowrite`, `todoread`, `webfetch`, `websearch`, `lsp`, `apply_patch`,
`skill`, `list`, the `pty_*` tools and MCP tools are OpenCode tools. On pi:

- to fetch a page, use `scrape_webpage`; to search, use `web_search`;
- to load a skill, read its `SKILL.md` with `read` (the system prompt lists
  each skill and its path);
- to keep a process running, start it in the background with `bash`
  (`nohup <command> >/tmp/<name>.log 2>&1 &`);
- to call an external app, use `kortix connectors` in `bash`.

## Arguments of the Kortix tools

| Tool | Arguments |
| --- | --- |
| `web_search` | `query` (required), `num_results` (1-20, default 5), `topic` (`general`, `news`, `finance`), `search_depth` (`basic`, `advanced`) |
| `image_search` | `query` (required), `num_results` (1-100, default 12) |
| `scrape_webpage` | `urls` (required, comma-separated), `include_html` (default false) |
| `memory` | `command` (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) and the arguments of that command. Every path starts with `memory`. The `kortix-memory` skill has the protocol. |
| `show` | `action: "show"`, then `type` with `path`, `url` or `content`, or `items` (a JSON array) for a carousel. A relative `path` resolves against the project checkout. |

The three web tools call the Kortix API with the session's own token. Kortix
bills each call to the project. No API key is necessary in the sandbox.

## Permissions

The agent's `permission` block in its `.md` frontmatter governs the tools, on
pi as on OpenCode. A rule names a permission key from the table above, not a
tool: `edit: deny` stops `write`, `edit` and every `memory` command that
changes a file, and `websearch: deny` stops `web_search` and `image_search`.
A rule under the tool's own name (`memory: allow`) wins over its permission
key.

```yaml
permission:
  bash:
    "git push *": ask
    "rm -rf *": deny
    "*": allow
  edit: ask
  websearch: allow
  webfetch: deny
```

- A rule is `allow`, `ask` or `deny`, or a map from a glob pattern to one of
  them. The pattern matches the command line for `bash` and the path for the
  file tools. The longest matching pattern wins.
- `ask` stops the call and shows a permission request to the user. The reply
  is `once`, `always` or `reject`. `always` allows that permission key for
  the rest of the session. A `deny` rule still wins after an `always`.
- A tool with no rule is allowed.
- `tools: { bash: false }` in the frontmatter removes a built-in tool from
  the agent.
- A subagent call must pass the subagent's own rules and the session agent's
  rules. A `deny` from either one wins.
