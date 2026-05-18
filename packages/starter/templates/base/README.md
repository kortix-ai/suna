# {{projectName}}

A Kortix project — git-versioned, OpenCode-native.

Every session is an isolated sandbox: a fresh VM with this repo cloned
onto its own branch (named after the session UUID). Commit and push from
the session, then merge the branch into `main` when you're done.

## Layout

```
kortix.toml                       # project manifest (Kortix config lives here)
Dockerfile                        # sandbox base image — Kortix layers its runtime on top
.opencode/
  opencode.jsonc                  # OpenCode runtime config
  agents/kortix.md                # the general knowledge worker — your default agent
  skills/kortix-system/SKILL.md   # on-demand: how the Kortix platform works
  tools/show.ts                   # `show` tool — surface files/URLs/images to the user
```

Customize `Dockerfile` and `.opencode/` to taste. Kortix-specific config
(triggers, env, secrets) lives in `kortix.toml`. OpenCode docs:
<https://opencode.ai/docs/>.

## Local

```sh
git clone https://github.com/{{repoFullName}} {{projectName}}
cd {{projectName}}
opencode
```
