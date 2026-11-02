---
title: kortix.yaml without versions
status: building on branch `one-schema` (PR #11236): one format, older formats read converted; the plan below is superseded where the 2026-10-30 sections say so
owner: Marko
updated: 2026-10-30
---

# kortix.yaml without versions

`kortix.yaml` loses its version line. One schema describes the latest shape,
every reader accepts every old shape, and every write saves the latest shape.
Validation says, per line, what is supported and what to change.

## 2026-10-30, later: older formats still work (supersedes the hard cut's "Old files" row)

A census of dev (1,527 projects, read-only, counts only) before the merge:
675 on `kortix_version: 2`, 91 with only a `kortix.toml`, 715 with no
manifest, 46 on the v3 shape. 188 of the 766 legacy projects belong to real
accounts and 24 were active in the last 30 days. Prod received the v3 starter
only in v0.14.11 (2026-10-30), so nearly every prod project is v2 or TOML. The
hard cut would have turned off their agents, so it is reversed:

- Read: `readManifestFromRepo` converts a legacy file (`legacy.ts`, the old
  `kortix migrate` planner) with the files it points at. Sessions run the
  converted agents; `manifest_health` has one `legacy-format` warning, one
  warning per setting with no place in the format, and the converted issues.
- Write: the first Kortix write saves the converted files in that commit
  (kortix.yaml, prompt bodies, deletes of `kortix.toml` and the OpenCode
  files). `kortix validate --fix` writes the same conversion. The other CLI
  writers refuse a legacy file.
- Checked: all 54 historical starter and marketplace templates convert with 0
  errors; real sessions on a v2 and a TOML project ran the converted agent.
- Retire the converter only when a census finds 0 legacy files on every
  environment.

## 2026-10-30: hard cut (supersedes "Old files", "Cut" and WP2)

Marko, 2026-10-30: "remove v1/v2/v3, toml support & just have 1 like infinitely
maintained schema", "we dont have that much customers, we can just rm these
projects", "be bold with old stuff", and "do we want silent failures? like it
will always default to some good default but send clear warnings wherever
necessary for self fixing".

| Topic | 2026-10-27 plan | 2026-10-30 decision (built on `one-schema`) |
| --- | --- | --- |
| Old files (TOML, v1, v2) | converter in the reader, heal job, census | no converter, no `kortix migrate`, no upgrade UI. A retired file gets one error and the project runs built-in agents only (My Kortix). |
| `kortix_version` | deprecated with a fix | obsolete: `3` is a warning ("remove it"), any other value is the retired-format error |
| `agents`, `default_agent` | required | optional: no agents means built-ins only, no `default_agent` means My Kortix |
| Run time | the reader drops only the broken entry | `usableManifest(parsed, issues)`: unknown keys ignored; an agent or trigger with an error is off; a broken connector, app, skill, tool, command, extension, space or sandbox template is dropped; `project`, `default_agent`, `runtime` fall back to their defaults; any other error means built-ins only. Every case only removes access. |
| Write time | — | errors block (`kortix validate`, `kortix ship`, the change-request merge gate, API writes, the editor). Writers never write `kortix_version`. |
| Surfaces | issue lines with file:line:col | every issue has line and column, unknown keys get "Did you mean"; `GET /v1/projects/:id/detail` returns `manifest_health`; the project banner offers "Fix with My Kortix"; the compiled agent set carries `manifest_issues` and the sandbox writes them into the agent's system prompt |
| JSON Schema | generated from zod | one hand-kept document (`/schema/kortix.schema.json`, alias `kortix.v3.schema.json`); the zod single source (WP1) is the next PR |

Still open after `one-schema`: WP1 (one zod source for validator, types, JSON
Schema, docs), comment-keeping API writes, and removing the `V2`/`V3`
suffixes from names. Built on `one-schema` since: `kortix validate --fix`,
the deprecation table, validators for `policy`, `policies` and `approvals`.

## Problem (verified on `project-admin`, 2026-10-27)

- Three versions and two formats: TOML v1, YAML v2, YAML v3. `apps/api/src/`
  holds 96 version checks in 25 files.
- Six definitions of one contract drift: the v1/v2/v3 validators
  (`packages/manifest-schema/src/index.ts`, `index.v2.ts`, `index.v3.ts`, about
  4,000 lines), the hand-written JSON Schema (`json-schema.ts`, 1,464 lines),
  hand-written types and docs, and the API parsers.
- Defaults differ by key: an omitted `tools` means every tool, every other
  omitted grant means none.
- Only 3 of 7 write paths validate the whole file. Every API write except a
  trigger edit removes comments.
- Only YAML syntax errors carry line:col. No issue says what to write instead.

## Marko's picks

| Question | Pick |
| --- | --- |
| Keep `imports:` (nested YAML files)? | Keep. The starter uses it. |
| Old files | Read every old shape, push it to the latest. A Kortix change request does the rewrite. |
| Cut | Soft: old shapes work until no environment has any. |
| Build now? | Plan first. |

## How it works for a user

Each problem is one line: file, line, column, severity, code, what to write.

```
kortix.yaml:1:1              deprecated  kortix_version is no longer needed. Delete the line.        fix: drop-kortix-version
agents/researcher.yaml:7:5   error       `tool` is not an agent key. Did you mean `tools`?
agents/support.yaml:3:3      deprecated  `tools` is not set: this agent gets every tool. Write it.   fix: tools-explicit
```

| Severity | Meaning | Effect |
| --- | --- | --- |
| error | Not supported. | A Kortix write refuses to add one. At run time the reader drops only that entry. |
| deprecated | Works, has a newer shape; carries a fix id. | Readers apply the fix in memory; `kortix validate --fix` and every Kortix write save the new shape. |
| warning | Works, probably not meant. | Shown, never blocks. |

One zod schema generates the types, the validator, the editor JSON Schema and
the reference docs. Surfaces: editor (schema modeline), `kortix validate`
(`--fix`, `--format github`), API `422` with the issue lines, a Customize
banner ("2 errors, 3 updates available", one click opens a change request),
agents. A broken file still accepts any edit that adds no new error.

## Old files

1. Read: the reader turns any old file into the latest shape in memory.
   Legacy files (TOML, v1, v2 with its agent `.md`) go through the converter;
   v3-era shapes through small fixes. Both are compile-neutral (tested).
2. Write: every Kortix write saves the latest shape and keeps comments.
3. Heal: a background job opens one Kortix change request per project with
   every fix. Kill switch per environment.
4. Count: a census counts old shapes per fix on dev, staging and prod.
5. Retire: a fix or the converter is deleted only at census 0 everywhere and
   60 days on `:stable`.

## Imports and the starter

`imports:` stays and becomes the normal layout. Rules in
`packages/manifest-schema/src/imports.ts` stay. Changes:

- Issues in an imported file carry that file's path, line and column.
- Writes go to the origin file (`splitManifestByOrigin`, `alsoExpect`).
- A directory import with no YAML yet imports nothing (today it throws at
  `imports.ts:248` and the whole manifest fails); a missing file is an error
  issue. No import problem is an exception.
- Root-only keys in a fragment are an error with a line, not a silent drop.

Starter layout (My Kortix is built in, so a new project has no agent):

```
kortix.yaml                      # project, sandbox, env, imports: [agents/, triggers/, apps/]
agents/<name>/agent.yaml         # agents: { <name>: { tools: [...], prompt_file: ... } }
agents/<name>/prompt.md
triggers/<slug>.yaml
apps/<name>/app.yaml
skills/<name>/SKILL.md
```

## Tools: the first fix

1. Shipped (`ec2b45304e`, `project-admin`): saves write `tools: all` when
   missing, validation warns, starter and create prompts write the key.
2. Fix `tools-explicit` writes `tools: all` where missing (compile-neutral).
3. At census 0, the schema makes `tools` required.

Rule for every future key: never change what a missing key means. Write the old
meaning with a fix, then tighten the schema.

## Build plan

Branch `kortix-yaml`, two releases, held for Marko.

| Package | What | Needs |
| --- | --- | --- |
| WP1 Schema core | zod schema, reader, comment-keeping editor, issues with file:line:col and did-you-mean, native imports; generates types, JSON Schema, docs | — |
| WP2 Rollover | converter in the reader path, fix catalog, census script, heal job (change requests, kill switch) | WP1 |
| WP3 API reads | `readProjectManifest` on the core; every runtime consumer reads one typed config | WP1, WP2 |
| WP4 API writes | one writer and one commit guard for all 7 write paths; origin-file writes | WP1, WP2 |
| WP5 CLI, kortixd | `kortix validate`, `kortix schema`, CLI writer, kortixd on the core | WP1, WP2 |
| WP6 Clients, docs | Customize banner and editor, SDK types, generated docs, imports starter, prompts, `kortix-yaml` skill | WP1, WP2 |
| WP7 Sweep | delete v1/v2/v3 validators and hand-written JSON Schema (~5,400 lines + tests), fixtures, reader floor | WP3–WP6 |

Gates: PR 1 (WP1+WP2) needs Marko's approval (it writes change requests).
G1 = census parity in every environment + Marko's OK, before Release B. G2 =
per fix, census 0 and 60 days on `:stable`.

## Testing

Compile parity per fix; a synthetic history corpus of every shipped shape;
golden issue lines; editor (comments, origin file); census parity (counts
only); REST `MAN-*` flows for all write paths; CLI flows; browser (banner,
change request); a real session of an agent created as
`agents/<name>/agent.yaml`, locally and on dev.

## Risks

| Risk | Guard |
| --- | --- |
| New reader compiles a fleet file differently | G1 census parity |
| Strict schema drops an entry that runs today | census lists drops per class before G1 |
| Heal writes to customer repos | change request only, kill switch, approval per environment |
| v2 conversion at read time needs agent `.md` files | cache per commit |
| Rollback below Release B | reader floor in the rollback workflow |
| Multi-file write race | revision check on every touched file, `409` |

## Open decisions

- Drop `agents.<name>.network_egress` (never enforced)? Default: yes.
- Paths in imported files: repo-relative (today) or file-relative? Default: repo-relative.
- Make every grant required like `tools`? Default: `tools` only.
- Start Release A now?

## Sources

- Earlier design: the one-schema design workflow (2026-10-27), 7 work packages.
- Doc copy: https://claude.ai/artifact/A9f5ypGtyAtedCCJPDsJ9n
