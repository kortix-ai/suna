# Lumen agent kit

Lumen's own role prompts, skills and tools. Lumen uploads this folder once per
version into the Drive of its one Kortix project, at `/Lumen/Kit/<version>/`,
and writes `/Lumen/Kit/CURRENT` (`kortix.ensure` in `convex/kortix.ts`). Every
firm's agent has a read-only grant on `/Lumen/Kit`, so a session reads the kit
at `/drives/kit/<version>/`. Nothing here is Kortix platform code.

| Path | Installed as |
|---|---|
| `agents/_rules.md` + `agents/<role>.md` | `agents/<role>.md` in the kit folder, rules first. The counsel role is also each firm agent's prompt (`updateAgentConfig`); a run names its role file in `input.json` (`role_path`) |
| `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` in the kit folder. A session has no repository, so an agent reads a skill with `cat` (rule text in `_rules.md`) |
| `lumen-kit/` (minus `fixtures/` and the selftest) | `lumen-kit/` in the kit folder; agents run `python3 /drives/kit/<version>/lumen-kit/bin/lumen …` |
| `lumen-kit/schemas/` | Also bundled into Convex: Lumen validates every result file with ajv against the same schemas |
| `shared/cite-vectors.json` | Quote normalization cases; the Python selftest and `tests/unit/cite.test.ts` both run them |
| `evals/` | Not installed: the answer key, cases and scorer |

`{{KIT}}` in a prompt, skill or tool file is the session path of the kit
folder (`/drives/kit/<version>`). `scripts/kit-bundle.ts` substitutes it.

## Change something

1. Edit the prompt, skill or tool.
2. Bump `kit.json` `version` (patch: wording; minor: a new command, skill or
   optional field; major: a result schema change old outputs do not meet).
3. `bun scripts/kit-bundle.ts` (rewrites `convex/kit/bundle.generated.ts` and the hash).
4. `cd agent-kit/lumen-kit && python3 -m lumen_kit.selftest` and
   `bun test tests/unit/kit-bundle.test.ts tests/unit/cite.test.ts`.
5. `pnpm --filter @kortix/white-label-lumen eval` and compare the table with
   the last one in the PR.

The project picks up the new kit on the next thread or run of any firm (one
upload for every firm); each firm agent's prompt is rewritten on that firm's
next thread or run (Settings → Firm shows the version). Sessions that are
running keep the kit they started with.

## The run contract

Lumen writes `input.json` (schema `input`: the `kind`, the `role` and its
`role_path`, the documents) into `/drives/<firmId>/Runs/<runId>/<batchId>/`
(the firm folder `/Lumen/Firms/<firmId>` as the session mounts it). The agent writes each result
with `lumen result write` into `out/` (review rows as `out/rows/<docId>.json`;
one `out/answer.json`, `out/issues.json`, `out/report.json` or `out/draft.json`
for the other kinds; files a result names, such as `redline.docx`, go next to
it) and finishes with `lumen result done`, which
refuses to write `done.json` while any result is invalid. A citation is
`{doc_id, a: "p<page>.<n>", quote}`; `lumen cite check` and Lumen apply the
same rules.
